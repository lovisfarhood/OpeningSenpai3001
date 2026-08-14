import { describe, expect, it } from 'vitest';

import { buildCanonicalRepertoire } from '../../scripts/lib/build.js';
import { createFixtureStudy, createLoadedSources } from '../fixtures/repertoire-fixture.js';
import { combineRepertoires, createCombinedOpenings } from '../../src/domain/combined-openings.js';
import { createExplorerIndex, explorerPosition, type ExplorerSource } from '../../src/domain/explorer.js';
import { analyzePgn, parsePgn } from '../../src/domain/pgn.js';
import type { CanonicalRepertoire } from '../../src/domain/repertoire.js';
import type { OpeningIndexEntry } from '../../src/data/repertoire.js';

function graph(id: string, side: 'white' | 'black', lines: string[][]): CanonicalRepertoire {
  return buildCanonicalRepertoire(
    createLoadedSources(lines.map((sans, index) => createFixtureStudy({
      studyFolder: `${id}-${index}`,
      lines: [{ sans }],
    }))),
    { openingId: id, title: id, repertoireSide: side },
  ).repertoire;
}

function source(repertoire: CanonicalRepertoire): ExplorerSource {
  return {
    openingId: repertoire.openingId,
    title: repertoire.title,
    repertoireSide: repertoire.openingSide,
    repertoire,
  };
}

describe('personal opening explorer', () => {
  it('aggregates referenced graphs without copying them and exposes every root theory move', () => {
    const e4 = graph('e4-book', 'white', [['e4', 'e5', 'Nf3']]);
    const d4 = graph('d4-book', 'white', [['d4', 'd5', 'c4']]);
    const sources = [source(e4), source(d4)];
    const index = createExplorerIndex(sources);
    const position = explorerPosition(index, e4.positions[e4.rootPosition]!.fullFens[0]!);

    expect(index.sources[0]?.repertoire).toBe(e4);
    expect(index.sources[1]?.repertoire).toBe(d4);
    expect(position.moves.map((move) => move.san)).toEqual(['d4', 'e4']);
    expect(position.openings).toEqual(['d4-book', 'e4-book']);
    expect(position.variationCount).toBe(2);
    expect(position.remainingDepth).toBeGreaterThan(0);
    expect(position.moves.every((move) => move.role === 'repertoire')).toBe(true);
  });

  it('classifies full-repertoire arrows as repertoire, opponent, or both', () => {
    const white = graph('white-book', 'white', [
      ['e4', 'e5'],
      ['d4', 'd5'],
    ]);
    const black = graph('black-book', 'black', [
      ['e4', 'e5'],
      ['Nf3', 'Nf6'],
    ]);
    const position = explorerPosition(
      createExplorerIndex([source(white), source(black)]),
      white.positions[white.rootPosition]!.fullFens[0]!,
    );

    expect(Object.fromEntries(position.moves.map((move) => [move.san, move.role])))
      .toEqual({ d4: 'repertoire', e4: 'both', Nf3: 'opponent' });
    expect(position.moves.find((move) => move.san === 'e4')?.sources.map((item) => item.role).sort())
      .toEqual(['opponent', 'repertoire']);
  });

  it('analyzes the first departure from theory and recommends stored alternatives', () => {
    const repertoire = graph('caro', 'black', [['e4', 'c6', 'd4', 'd5']]);
    const index = createExplorerIndex([source(repertoire)]);
    const game = parsePgn('[Event "Deviation"]\n\n1. e4 c6 2. Nf3');
    const analysis = analyzePgn(game, index);

    expect(analysis.theoryPlies).toBe(2);
    expect(analysis.deviationPly).toBe(3);
    expect(analysis.deviationSan).toBe('Nf3');
    expect(analysis.alternatives.map((move) => move.san)).toEqual(['d4']);
    expect(analysis.theoryPercentage).toBe(67);
    expect(analysis.studies.length).toBeGreaterThan(0);
  });

  it('preserves PGN comments and parses castling, en passant, and promotion', () => {
    const castling = parsePgn('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O {King safe}');
    expect(castling.moves.at(-1)).toMatchObject({ san: 'O-O', comment: 'King safe' });

    const enPassant = parsePgn('1. e4 Nf6 2. e5 d5 3. exd6');
    expect(enPassant.moves.at(-1)?.san).toBe('exd6');

    const promotion = parsePgn('[SetUp "1"]\n[FEN "7k/P7/8/8/8/8/8/7K w - - 0 1"]\n\n1. a8=Q+');
    expect(promotion.moves[0]?.san).toBe('a8=Q+');
    expect(() => parsePgn('this is not a game')).toThrow(/could not be parsed|contains no moves/);
  });
});
describe('combined opening definitions', () => {
  const opening = (id: string, title: string, repertoireSide: 'white' | 'black'): OpeningIndexEntry => ({
    id, slug: id, title, sourcePath: `data/chessly/${id}`,
    sourceCourseUrl: `https://example.test/${id}`, repertoireSide,
    chapterCount: 1, studyCount: 1, positionCount: 1, moveCount: 1,
    commentCount: 0, processingStatus: 'ready', conflictCount: 0,
    rootFen: 'root', processedFile: `openings/${id}.json`, studies: 1,
    positions: 1, opponentChoices: 1, repertoireDecisions: 1,
    maximumDepth: 1, conflicts: 0, validationStatus: 'ready', issueCount: 0,
    availableModes: ['book', 'practice', 'explorer'],
  });

  it('stores only opening IDs in virtual collections', () => {
    const openings = [
      opening('vienna-game', 'Vienna Game', 'white'),
      opening('1-e4-part-2-sicilian', '1.e4 Part 2', 'white'),
      opening('1-e4-part-3-caro-etc', '1.e4 Part 3', 'white'),
      opening('sicilian-dragon', 'Sicilian Dragon', 'black'),
      opening('the-gotham-dutch', 'Gotham Dutch', 'black'),
    ];
    const combined = createCombinedOpenings(openings);

    expect(combined.find((item) => item.id === 'complete-1-e4')?.openingIds).toEqual(['vienna-game', '1-e4-part-2-sicilian', '1-e4-part-3-caro-etc']);
    expect(combined.find((item) => item.id === 'complete-black-repertoire')?.openingIds).toEqual(['sicilian-dragon', 'the-gotham-dutch']);
    expect(combined.find((item) => item.id === 'full-repertoire-explorer')).toMatchObject({
      repertoireSide: 'both',
      availableModes: ['explorer'],
    });
    expect(combined.find((item) => item.id === 'full-repertoire-explorer')?.openingIds)
      .toEqual(openings.map((item) => item.id));
    expect(combined.every((item) => item.openingIds.every((id) => typeof id === 'string'))).toBe(true);
  });

  it('keeps a Black runtime collection Black and pauses ambiguous decisions', () => {
    const first = graph('sicilian-dragon', 'black', [['e4', 'c5']]);
    const second = graph('four-knights-sicilian', 'black', [['e4', 'e6']]);
    const definition = {
      id: 'complete-sicilian', title: 'Complete Sicilian', repertoireSide: 'black' as const,
      openingIds: [first.openingId, second.openingId], availableModes: ['book', 'practice', 'explorer'] as const,
    };
    const combined = combineRepertoires(definition, [first, second]);
    const afterE4 = Object.values(combined.edges).find((edge) => edge.from === combined.rootPosition && edge.san === 'e4')!.to;
    expect(combined.openingSide).toBe('black');
    expect(combined.repertoireDecisionNodes[afterE4]?.candidates).toHaveLength(2);
    expect(combined.repertoireDecisionNodes[afterE4]?.selectedCandidateId).toBeNull();
  });
});
