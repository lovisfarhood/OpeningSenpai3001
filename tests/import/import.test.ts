import { Chess } from 'chess.js';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { buildCanonicalRepertoire } from '../../scripts/lib/build.js';
import {
  START_FEN,
  type CanonicalRepertoire,
  type SourceType,
} from '../../src/domain/repertoire.js';
import {
  parseChesslyFiles,
  parseChesslyZip,
  parseNativeImport,
  type ImportFileEntry,
  type RawImportedComment,
  type RawImportedMove,
} from '../../src/import/index.js';
import {
  createFixtureStudy,
  createLoadedSources,
} from '../fixtures/repertoire-fixture.js';

interface StudyFilesOptions {
  directory: string;
  lines: readonly (readonly string[])[];
  comments?: Readonly<Record<string, readonly RawImportedComment[]>>;
  sourceType?: SourceType;
}

function nominalFen(
  chess: Chess,
  move: ReturnType<Chess['move']>,
): string {
  const fields = chess.fen().split(' ');
  if (move.isBigPawn()) {
    const fromRank = Number(move.from[1]);
    const toRank = Number(move.to[1]);
    fields[3] = `${move.from[0]}${(fromRank + toRank) / 2}`;
  }
  return fields.join(' ');
}

function lineMoves(
  sans: readonly string[],
  variationId: string,
): RawImportedMove[] {
  const result: RawImportedMove[] = [];
  let fen = START_FEN;
  for (const san of sans) {
    const chess = new Chess(fen);
    const move = chess.move(san, { strict: true });
    const nextFen = nominalFen(chess, move);
    result.push({
      fen,
      san,
      nextFen,
      variationId,
      variationIndex: 1,
    });
    fen = nextFen;
  }
  return result;
}

function studyFiles(options: StudyFilesOptions): ImportFileEntry[] {
  const moves: Record<string, RawImportedMove[]> = {};
  for (const [index, line] of options.lines.entries()) {
    for (const move of lineMoves(line, `variation-${index + 1}`)) {
      const values = moves[move.fen] ?? [];
      values.push(move);
      moves[move.fen] = values;
    }
  }
  const source =
    options.sourceType === undefined
      ? {}
      : { sourceType: options.sourceType };
  return [
    {
      path: `${options.directory}/moves.json`,
      content: JSON.stringify(moves),
      ...source,
    },
    {
      path: `${options.directory}/comments.json`,
      content: JSON.stringify(options.comments ?? {}),
      ...source,
    },
    {
      path: `${options.directory}/info.md`,
      content:
        '# Fixture Study\n\n- Kurs: Fixture Course\n- Kapitel: Fixture Chapter\n- Study: Fixture Study\n',
      ...source,
    },
  ];
}

const fixtureComment: RawImportedComment = {
  text: 'Fixture explanation',
  arrows: { threats: [], opportunities: ['c7-c6'] },
  highlights: { threats: [], opportunities: ['c6'] },
};

describe('Chessly-Dateiimport', () => {
  it('gruppiert mehrere Studies, dedupliziert und bewahrt main/bonus', () => {
    const firstLine = lineMoves(['e4', 'c6'], 'preview');
    const commentFen = firstLine[1]?.nextFen;
    if (!commentFen) {
      throw new Error('Fixture-FEN fehlt.');
    }
    const comments = { [commentFen]: [fixtureComment] };
    const files = [
      ...studyFiles({
        directory: 'data/chessly/caro-kann/01_main',
        lines: [['e4', 'c6']],
        comments,
      }),
      ...studyFiles({
        directory: 'data/chessly/caro-kann-bonus/01_bonus',
        lines: [['e4', 'c6']],
        comments,
      }),
    ];

    const result = parseChesslyFiles(files);

    expect(result.status).toBe('ready');
    expect(result.canApply).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.overwriteExisting).toBe(false);
    expect(result.sourceType).toBe('mixed');
    expect(result.statistics).toMatchObject({
      addedPositions: 3,
      addedMoves: 2,
      addedComments: 1,
      duplicates: 3,
      conflicts: 0,
      invalidFiles: 0,
      disconnectedGraphParts: 0,
    });
    expect(
      result.payload?.kind === 'chessly-studies'
        ? result.payload.studies.map((study) => study.sourceType)
        : [],
    ).toEqual(['bonus', 'main']);
    expect(
      result.payload?.kind === 'chessly-studies'
        ? result.payload.studies[0]?.metadata
        : null,
    ).toEqual({
      course: 'Fixture Course',
      chapter: 'Fixture Chapter',
      study: 'Fixture Study',
    });
  });

  it('blockiert ungültige oder doppelte Dateien, ohne die erste zu überschreiben', () => {
    const good = studyFiles({
      directory: 'upload/good-study',
      lines: [['e4', 'c6']],
    });
    const duplicateMoves = {
      ...good[0],
      content: '{"would":"overwrite"}',
    };
    const invalid = studyFiles({
      directory: 'upload/bad-study',
      lines: [['d4', 'd5']],
    }).map((entry) =>
      entry.path.endsWith('moves.json')
        ? { ...entry, content: '{not-json' }
        : entry,
    );

    const result = parseChesslyFiles([
      ...good,
      duplicateMoves as ImportFileEntry,
      ...invalid,
      {
        path: '../escape/moves.json',
        content: '{}',
      },
    ]);

    expect(result.status).toBe('invalid');
    expect(result.canApply).toBe(false);
    expect(result.overwriteExisting).toBe(false);
    expect(result.statistics.invalidFiles).toBe(3);
    expect(result.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'duplicate-file',
        'invalid-json',
        'invalid-path',
      ]),
    );
    expect(
      result.payload?.kind === 'chessly-studies'
        ? result.payload.studies.map((study) => study.studyFolder)
        : [],
    ).toEqual(['good-study']);
  });

  it('meldet unterschiedliche Schwarzantworten und unverbundene Graphteile', () => {
    const connected = studyFiles({
      directory: 'upload/conflict',
      lines: [
        ['e4', 'c6'],
        ['e4', 'c5'],
      ],
    });
    const isolatedMoves = lineMoves(['d4', 'd5'], 'isolated').slice(1);
    const isolated = studyFiles({
      directory: 'upload/isolated',
      lines: [],
    }).map((entry) =>
      entry.path.endsWith('moves.json')
        ? {
            ...entry,
            content: JSON.stringify({
              [isolatedMoves[0]?.fen ?? 'missing']: isolatedMoves,
            }),
          }
        : entry,
    );

    const result = parseChesslyFiles([...connected, ...isolated]);

    expect(result.status).toBe('ready');
    expect(result.statistics.conflicts).toBe(1);
    expect(result.statistics.duplicates).toBe(1);
    expect(result.statistics.disconnectedGraphParts).toBe(1);
    expect(result.statistics.disconnectedPositions).toBe(2);
  });

  it('berechnet Ergänzungen und Duplikate gegen ein bestehendes Repertoire', () => {
    const existingStudy = createFixtureStudy({
      studyFolder: 'existing',
      lines: [{ sans: ['e4', 'c6'] }],
    });
    const existing = buildCanonicalRepertoire(
      createLoadedSources([existingStudy]),
    ).repertoire;
    const imported = studyFiles({
      directory: 'upload/imported',
      lines: [
        ['e4', 'c6'],
        ['e4', 'c5'],
      ],
      sourceType: 'bonus',
    });

    const result = parseChesslyFiles(imported, {
      existingRepertoire: existing,
    });

    expect(result.sourceType).toBe('bonus');
    expect(result.statistics.addedPositions).toBe(1);
    expect(result.statistics.addedMoves).toBe(1);
    expect(result.statistics.duplicates).toBe(3);
    expect(result.statistics.conflicts).toBe(1);
    expect(result.overwriteExisting).toBe(false);
  });
});

describe('ZIP-Import', () => {
  it('entpackt Chessly-Studies ausschließlich im Speicher', () => {
    const files = studyFiles({
      directory: 'caro-kann-bonus/01_zip',
      lines: [['e4', 'c6']],
    });
    const archive = zipSync(
      Object.fromEntries(
        files.map((file) => [
          file.path,
          strToU8(String(file.content)),
        ]),
      ),
    );

    const result = parseChesslyZip(archive);

    expect(result.status).toBe('ready');
    expect(result.sourceType).toBe('bonus');
    expect(result.statistics.addedMoves).toBe(2);
    expect(
      result.payload?.kind === 'chessly-studies'
        ? result.payload.studies[0]?.studyFolder
        : null,
    ).toBe('01_zip');
  });

  it('weist ungültige ZIP-Daten kontrolliert zurück', () => {
    const result = parseChesslyZip(strToU8('kein zip'));

    expect(result.status).toBe('invalid');
    expect(result.statistics.invalidFiles).toBe(1);
    expect(result.issues[0]?.code).toBe('invalid-zip');
  });
});

describe('natives versioniertes App-JSON', () => {
  function nativeFixture(): CanonicalRepertoire {
    const study = createFixtureStudy({
      studyFolder: 'native',
      lines: [{ sans: ['e4', 'c6'] }],
    });
    return buildCanonicalRepertoire(
      createLoadedSources([study]),
    ).repertoire;
  }

  it('validiert ein kanonisches Repertoire und liefert nur eine Vorschau', () => {
    const result = parseNativeImport(JSON.stringify(nativeFixture()));

    expect(result.status).toBe('ready');
    expect(result.inputKind).toBe('native-repertoire');
    expect(result.statistics.addedPositions).toBe(3);
    expect(result.statistics.addedMoves).toBe(2);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.overwriteExisting).toBe(false);
    expect(result.payload?.kind).toBe('native-repertoire');
  });

  it('lehnt eine unbekannte Formatversion ab', () => {
    const document = {
      ...nativeFixture(),
      formatVersion: '99.0.0',
    };

    const result = parseNativeImport(JSON.stringify(document));

    expect(result.status).toBe('invalid');
    expect(result.canApply).toBe(false);
    expect(result.issues[0]?.code).toBe('unsupported-version');
  });

  it('erkennt das native lokale Backupformat Version 1', () => {
    const backup = {
      kind: 'interactive-chessbook-local-backup',
      version: 1,
      exportedAt: '2026-07-24T12:00:00.000Z',
      data: {
        overrides: [],
        additions: [],
        conflictSelections: [],
        settings: {
          orientation: 'black',
          showArrows: true,
          showHighlights: true,
        },
        navigation: null,
      },
    };

    const result = parseNativeImport(JSON.stringify(backup));

    expect(result.status).toBe('ready');
    expect(result.inputKind).toBe('native-local-backup');
    expect(result.sourceType).toBe('user');
    expect(result.statistics).toMatchObject({
      addedPositions: 0,
      addedMoves: 0,
      addedComments: 0,
      invalidFiles: 0,
    });
    expect(result.payload?.kind).toBe('native-local-backup');
  });
});
