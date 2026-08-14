import { describe, expect, it } from 'vitest';

import { buildCanonicalRepertoire } from '../../scripts/lib/build.js';
import { eligibleOpponentEdges } from '../../src/domain/practice.js';
import { normalizeFen } from '../../src/domain/repertoire.js';
import {
  createVariationIndex,
  isEndOfLine,
  isPracticeEndOfLine,
  maximumTrainingDepth,
  practiceBranches,
  remainingLineCount,
  remainingLines,
  storedContinuationSummary,
  storedContinuations,
} from '../../src/domain/variations.js';
import {
  createFixtureStudy,
  createLoadedSources,
  linePositions,
  type FixtureLine,
} from '../fixtures/repertoire-fixture.js';

function fixture(
  side: 'white' | 'black',
  studies: Array<{ studyFolder: string; lines: FixtureLine[] }>,
) {
  return buildCanonicalRepertoire(
    createLoadedSources(studies.map(createFixtureStudy)),
    { repertoireSide: side, openingId: 'variations', title: 'Variations' },
  ).repertoire;
}

function positionAfter(sans: string[]): string {
  const position = linePositions(sans).at(-1);
  if (!position) throw new Error('Fixture position fehlt.');
  return normalizeFen(position);
}

describe('variation index', () => {
  it('deduplicates stored source/SAN/target continuations and counts lineages', () => {
    const repertoire = fixture('black', [
      {
        studyFolder: 'alpha',
        lines: [
          {
            sans: ['e4', 'c6', 'd4', 'd5'],
            variationId: 'shared-variation-id',
          },
        ],
      },
      {
        studyFolder: 'beta',
        lines: [
          {
            sans: ['e4', 'c6', 'Nf3', 'd5'],
            variationId: 'shared-variation-id',
          },
        ],
      },
    ]);
    const index = createVariationIndex(repertoire);
    const root = storedContinuationSummary(index, repertoire.rootPosition);

    expect(root.branchCount).toBe(1);
    expect(root.pathCount).toBe(2);
    expect(root.continuations[0]).toMatchObject({
      san: 'e4',
      sourcePosition: repertoire.rootPosition,
      pathCount: 2,
      downstreamBranchCount: 1,
    });
    expect(root.continuations[0]?.directLineageIds).toHaveLength(2);

    const afterC6 = positionAfter(['e4', 'c6']);
    expect(storedContinuationSummary(index, afterC6)).toMatchObject({
      branchCount: 2,
      pathCount: 2,
    });
    expect(storedContinuations(index, afterC6).map((item) => item.san)).toEqual([
      'd4',
      'Nf3',
    ]);
    expect(remainingLines(index, repertoire.rootPosition)).toHaveLength(2);
    expect(
      remainingLines(index, repertoire.rootPosition).map((lineage) => [
        lineage.studyFolder,
        lineage.variationId,
      ]),
    ).toEqual([
      ['alpha', 'shared-variation-id'],
      ['beta', 'shared-variation-id'],
    ]);
  });

  it('keeps stored continuations separate from eligible Practice branches', () => {
    const repertoire = fixture('black', [
      {
        studyFolder: 'complete',
        lines: [{ sans: ['e4', 'c6'] }],
      },
      {
        studyFolder: 'without-reply',
        lines: [{ sans: ['d4'] }],
      },
    ]);
    const index = createVariationIndex(repertoire);

    expect(
      storedContinuations(index, repertoire.rootPosition).map(
        (continuation) => continuation.san,
      ),
    ).toEqual(['d4', 'e4']);
    expect(
      practiceBranches(index, repertoire.rootPosition).map(
        (continuation) => continuation.san,
      ),
    ).toEqual(['e4']);
    expect(
      practiceBranches(index, repertoire.rootPosition).flatMap(
        (continuation) => continuation.edgeIds,
      ),
    ).toEqual(
      eligibleOpponentEdges(repertoire, repertoire.rootPosition).map(
        (edge) => edge.id,
      ),
    );
    expect(maximumTrainingDepth(index, repertoire.rootPosition)).toBe(1);
  });

  it('uses Study URLs before legacy folder identities for lineages', () => {
    const repertoire = fixture('black', [
      {
        studyFolder: 'legacy-folder-a',
        lines: [
          { sans: ['e4', 'c6'], variationId: 'shared-source-line' },
        ],
      },
      {
        studyFolder: 'legacy-folder-b',
        lines: [
          { sans: ['e4', 'c6'], variationId: 'shared-source-line' },
        ],
      },
    ]);
    for (const edge of Object.values(repertoire.edges)) {
      for (const source of edge.sources) {
        source.courseUrl = 'https://example.test/course';
        source.studyUrl = 'https://example.test/course/study/shared';
      }
    }

    const lines = remainingLines(
      createVariationIndex(repertoire),
      repertoire.rootPosition,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      studyUrl: 'https://example.test/course/study/shared',
      variationId: 'shared-source-line',
    });
  });

  it('deduplicates lineages across transpositions without losing either path', () => {
    const repertoire = fixture('black', [
      {
        studyFolder: 'knight-first',
        lines: [
          {
            sans: ['Nf3', 'd5', 'g3', 'Nf6'],
            variationId: 'knight-line',
          },
        ],
      },
      {
        studyFolder: 'pawn-first',
        lines: [
          {
            sans: ['g3', 'd5', 'Nf3', 'Nf6'],
            variationId: 'pawn-line',
          },
        ],
      },
    ]);
    const index = createVariationIndex(repertoire);
    const transposition = positionAfter(['Nf3', 'd5', 'g3']);
    const terminal = positionAfter(['Nf3', 'd5', 'g3', 'Nf6']);

    expect(storedContinuationSummary(index, repertoire.rootPosition)).toMatchObject(
      { branchCount: 2, pathCount: 2 },
    );
    expect(remainingLineCount(index, transposition)).toBe(2);
    expect(storedContinuations(index, transposition).map((item) => item.san)).toEqual([
      'Nf6',
    ]);
    expect(maximumTrainingDepth(index, repertoire.rootPosition)).toBe(2);
    expect(isEndOfLine(index, terminal)).toBe(true);
    expect(isPracticeEndOfLine(index, terminal)).toBe(true);
  });

  it('condenses cycles and counts each distinct repertoire decision once', () => {
    const repertoire = fixture('black', [
      {
        studyFolder: 'cycle',
        lines: [
          {
            sans: ['Nf3', 'Nf6', 'Ng1', 'Ng8'],
            variationId: 'cycle-line',
          },
        ],
      },
    ]);
    const index = createVariationIndex(repertoire);

    expect(remainingLineCount(index, repertoire.rootPosition)).toBe(1);
    expect(maximumTrainingDepth(index, repertoire.rootPosition)).toBe(2);
    expect(isEndOfLine(index, repertoire.rootPosition)).toBe(false);
    expect(isPracticeEndOfLine(index, repertoire.rootPosition)).toBe(false);
    expect(storedContinuations(index, repertoire.rootPosition)).toBe(
      storedContinuations(index, repertoire.rootPosition),
    );
  });

  it('collapses duplicate edge records with the same source/SAN/target tuple', () => {
    const repertoire = fixture('black', [
      {
        studyFolder: 'duplicate',
        lines: [{ sans: ['e4', 'c6'] }],
      },
    ]);
    const rootEdge = Object.values(repertoire.edges).find(
      (edge) => edge.from === repertoire.rootPosition,
    );
    if (!rootEdge) throw new Error('Root edge fehlt.');
    repertoire.edges.duplicate_edge = {
      ...rootEdge,
      id: 'duplicate_edge',
    };

    const continuations = storedContinuations(
      createVariationIndex(repertoire),
      repertoire.rootPosition,
    );
    expect(continuations).toHaveLength(1);
    expect(continuations[0]?.edgeIds).toEqual([
      'duplicate_edge',
      rootEdge.id,
    ]);
  });
});
