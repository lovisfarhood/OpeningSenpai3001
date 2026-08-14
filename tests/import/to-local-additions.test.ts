import { describe, expect, it } from 'vitest';

import { buildCanonicalRepertoire } from '../../scripts/lib/build.js';
import {
  importPackageToLocalAdditions,
  parseChesslyFiles,
  type ImportFileEntry,
  type RawImportedComment,
} from '../../src/import/index.js';
import {
  createFixtureStudy,
  createLoadedSources,
} from '../fixtures/repertoire-fixture.js';

function baseRepertoire() {
  return buildCanonicalRepertoire(
    createLoadedSources([
      createFixtureStudy({
        studyFolder: 'main-c6',
        lines: [{ sans: ['e4', 'c6'] }],
      }),
    ]),
  ).repertoire;
}

function filesForStudy(
  study: ReturnType<typeof createFixtureStudy>,
  comments = study.comments ?? {},
): ImportFileEntry[] {
  if (!study.moves) {
    throw new Error('Fixture-Züge fehlen.');
  }
  const source = { sourceType: study.sourceType };
  return [
    {
      path: `data/chessly/${study.courseFolder}/${study.studyFolder}/moves.json`,
      content: JSON.stringify(study.moves),
      ...source,
    },
    {
      path: `data/chessly/${study.courseFolder}/${study.studyFolder}/comments.json`,
      content: JSON.stringify(comments),
      ...source,
    },
    {
      path: `data/chessly/${study.courseFolder}/${study.studyFolder}/info.md`,
      content:
        `# ${study.metadata.study}\n\n` +
        `- Kurs: ${study.metadata.course}\n` +
        `- Kapitel: ${study.metadata.chapter}\n` +
        `- Study: ${study.metadata.study}\n`,
      ...source,
    },
  ];
}

describe('Importvorschau zu lokalen Ergänzungen', () => {
  it('importiert ein bereits vorhandenes Basisrepertoire nicht noch einmal lokal', () => {
    const existing = baseRepertoire();
    const duplicate = createFixtureStudy({
      sourceType: 'bonus',
      studyFolder: 'bonus-duplicate',
      lines: [{ sans: ['e4', 'c6'] }],
    });
    const preview = parseChesslyFiles(filesForStudy(duplicate), {
      existingRepertoire: existing,
    });

    expect(preview.canApply).toBe(true);
    expect(importPackageToLocalAdditions(preview, existing)).toEqual([]);
  });

  it('ergänzt eine neue Bonusabweichung mit erhaltener Quellenklasse', () => {
    const existing = baseRepertoire();
    const bonus = createFixtureStudy({
      sourceType: 'bonus',
      studyFolder: 'bonus-c5',
      lines: [{ sans: ['e4', 'c5'] }],
    });
    const preview = parseChesslyFiles(filesForStudy(bonus), {
      existingRepertoire: existing,
    });

    const additions = importPackageToLocalAdditions(preview, existing);

    expect(additions).toHaveLength(1);
    expect(additions[0]).toMatchObject({
      sourceType: 'bonus',
      baseDecisionId:
        existing.whiteTurnNodes[existing.rootPosition]?.moves[0]?.id,
      whiteTurnPosition: existing.rootPosition,
      whiteMoveSan: 'e4',
      replies: [{ san: 'c5' }],
    });
  });

  it('liest Antwort und Plan nur von den jeweils exakten vollständigen FENs', () => {
    const existing = baseRepertoire();
    const bonus = createFixtureStudy({
      sourceType: 'bonus',
      studyFolder: 'bonus-annotated-c5',
      lines: [{ sans: ['e4', 'c5'] }],
    });
    if (!bonus.moves) {
      throw new Error('Fixture-Züge fehlen.');
    }
    const rootMove = Object.values(bonus.moves)
      .flat()
      .find((move) => move.san === 'e4');
    const replyMove = Object.values(bonus.moves)
      .flat()
      .find((move) => move.san === 'c5');
    if (!rootMove || !replyMove) {
      throw new Error('Fixture-Linie fehlt.');
    }
    const exactReply: RawImportedComment = {
      text: 'Erklärung an exakter schwarzer FEN',
      arrows: { threats: ['c7-c5'], opportunities: [] },
      highlights: null,
    };
    const exactPlan: RawImportedComment = {
      text: 'Plan an exakter Ergebnis-FEN',
      arrows: null,
      highlights: { threats: [], opportunities: ['c5'] },
    };
    const decoySameNormalized: RawImportedComment = {
      text: 'Darf nicht über normalisierte FEN durchsickern',
      arrows: null,
      highlights: null,
    };
    const alterCounters = (fen: string) => {
      const fields = fen.split(' ');
      fields[4] = '17';
      fields[5] = '42';
      return fields.join(' ');
    };
    const comments = {
      [rootMove.fen]: [
        {
          text: 'Kommentar vor dem weißen Zug',
          arrows: null,
          highlights: null,
        },
      ],
      [replyMove.fen]: [exactReply],
      [alterCounters(replyMove.fen)]: [decoySameNormalized],
      [replyMove.nextFen]: [exactPlan],
      [alterCounters(replyMove.nextFen)]: [decoySameNormalized],
    };
    const preview = parseChesslyFiles(filesForStudy(bonus, comments), {
      existingRepertoire: existing,
    });

    const addition = importPackageToLocalAdditions(preview, existing)[0];

    expect(addition?.replies[0]?.replyExplanation).toEqual({
      text: exactReply.text,
      arrows: exactReply.arrows,
      highlights: exactReply.highlights,
    });
    expect(addition?.replies[0]?.resultingPlan).toEqual({
      text: exactPlan.text,
      arrows: exactPlan.arrows,
      highlights: exactPlan.highlights,
    });
  });
});
