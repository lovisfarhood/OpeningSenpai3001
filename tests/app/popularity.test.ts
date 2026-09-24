import { describe, expect, it } from 'vitest';

import { buildCanonicalRepertoire } from '../../scripts/lib/build.js';
import {
  buildImportanceOrder,
  createImportanceScope,
  importanceBudgetOptions,
  normalizeImportanceBudget,
  type PopularityPack,
} from '../../src/domain/popularity.js';
import {
  createMovePracticeItems,
  createPracticeItems,
  maximumPracticeDepth,
} from '../../src/domain/practice.js';
import { normalizeFen } from '../../src/domain/repertoire.js';
import {
  createFixtureStudy,
  createLoadedSources,
  linePositions,
} from '../fixtures/repertoire-fixture.js';

function fixture(lines: string[][], side: 'white' | 'black' = 'white') {
  return buildCanonicalRepertoire(
    createLoadedSources(lines.map((sans, index) => createFixtureStudy({
      studyFolder: `importance-${index}`,
      lines: [{ sans }],
    }))),
    { repertoireSide: side, openingId: 'importance', title: 'Importance' },
  ).repertoire;
}

function positionAfter(sans: string[]): string {
  return normalizeFen(linePositions(sans).at(-1)!);
}

function popularity(
  repertoire: ReturnType<typeof fixture>,
  gamesByPath: Readonly<Record<string, number>>,
  roots = [repertoire.rootPosition],
): PopularityPack {
  const edgeGames = Object.fromEntries(Object.values(repertoire.edges).map((edge) => {
    const source = edge.sources[0];
    const key = `${source?.variationId ?? ''}:${source?.variationIndex ?? 0}:${edge.san}`;
    return [edge.id, gamesByPath[key] ?? gamesByPath[edge.san] ?? 0];
  }));
  const positionGames = Object.fromEntries(Object.values(repertoire.edges).map(
    (edge) => [edge.to, edgeGames[edge.id] ?? 0],
  ));
  for (const edge of Object.values(repertoire.edges)) {
    positionGames[edge.from] ??= Object.values(repertoire.edges)
      .filter((candidate) => candidate.from === edge.from)
      .reduce((sum, candidate) => sum + (edgeGames[candidate.id] ?? 0), 0);
  }
  return {
    formatVersion: 2,
    openingId: repertoire.openingId,
    source: 'lichess-opening-explorer',
    retrievedAt: '2026-08-27T00:00:00.000Z',
    filters: {
      variant: 'standard',
      speeds: 'all',
      ratings: 'all',
      since: '1952-01',
      until: '3000-12',
    },
    coverage: {
      repertoireParentPositions: Object.keys(positionGames).length,
      cachedParentPositions: Object.keys(positionGames).length,
      inferredZeroParentPositions: 0,
      missingParentPositions: 0,
      failedRequests: 0,
    },
    edgeGames,
    positionGames,
    defaultRootPositions: roots,
    importanceOrder: buildImportanceOrder(
      repertoire,
      roots,
      edgeGames,
      positionGames,
    ),
  };
}

function configuredPopularity(
  repertoire: ReturnType<typeof fixture>,
  moveCounts: readonly { parent: string[]; san: string; games: number }[],
  parentCounts: readonly { path: string[]; games: number }[],
  roots = [repertoire.rootPosition],
): PopularityPack {
  const base = popularity(repertoire, {}, roots);
  const edgeGames = { ...base.edgeGames };
  const positionGames = { ...base.positionGames };
  for (const count of moveCounts) {
    const parent = count.parent.length > 0
      ? positionAfter(count.parent)
      : repertoire.rootPosition;
    const edge = Object.values(repertoire.edges).find(
      (candidate) => candidate.from === parent && candidate.san === count.san,
    );
    if (!edge) throw new Error(`Missing configured edge ${count.san}.`);
    edgeGames[edge.id] = count.games;
  }
  for (const count of parentCounts) {
    const position = count.path.length > 0
      ? positionAfter(count.path)
      : repertoire.rootPosition;
    positionGames[position] = count.games;
  }
  return {
    ...base,
    edgeGames,
    positionGames,
    importanceOrder: buildImportanceOrder(
      repertoire,
      roots,
      edgeGames,
      positionGames,
    ),
  };
}

describe('Importance priority frontier', () => {
  it('counts unique positions rather than path prefixes', () => {
    const repertoire = fixture([['e4', 'e5', 'Nf3']]);
    const pack = popularity(repertoire, { e4: 100, e5: 90, Nf3: 80 });
    const scope = createImportanceScope(repertoire, [repertoire.rootPosition], 3, pack);

    expect([...scope.selectedPositions]).toEqual([
      positionAfter(['e4']),
      positionAfter(['e4', 'e5']),
      positionAfter(['e4', 'e5', 'Nf3']),
    ]);
    expect(scope.summary.positions).toBe(3);
  });

  it('keeps own repertoire moves at full reach and never selects a child before its parent', () => {
    const repertoire = fixture([
      ['e4', 'e5', 'Nf3'],
      ['d4', 'd5', 'c4'],
    ]);
    const pack = popularity(repertoire, {
      e4: 100,
      e5: 90,
      Nf3: 80,
      d4: 50,
      d5: 40,
      c4: 30,
    });
    const positions = pack.importanceOrder.map((entry) => entry.position);

    expect(positions.slice(0, 3)).toEqual([
      positionAfter(['e4']),
      positionAfter(['d4']),
      positionAfter(['e4', 'e5']),
    ]);
    for (const entry of pack.importanceOrder) {
      for (const parent of entry.parentPositions) {
        if (parent === repertoire.rootPosition) continue;
        expect(positions.indexOf(parent)).toBeLessThan(positions.indexOf(entry.position));
      }
    }
  });

  it('keeps scopes monotonic with deterministic tie breaking', () => {
    const repertoire = fixture([
      ['e4', 'e5', 'Nf3', 'Nc6'],
      ['d4', 'd5', 'c4', 'e6'],
      ['c4', 'e5', 'Nc3', 'Nf6'],
    ]);
    const pack = popularity(repertoire, {});
    const ten = createImportanceScope(repertoire, [repertoire.rootPosition], 10, pack);
    const twenty = createImportanceScope(repertoire, [repertoire.rootPosition], 20, pack);
    const repeat = buildImportanceOrder(
      repertoire,
      [repertoire.rootPosition],
      pack.edgeGames,
      pack.positionGames,
    );

    expect([...ten.selectedPositions].every((position) => twenty.selectedPositions.has(position))).toBe(true);
    expect(repeat).toEqual(pack.importanceOrder);
    expect(ten.summary.positions).toBe(Math.min(10, pack.importanceOrder.length));
  });

  it('deduplicates transpositions while retaining both theory edges', () => {
    const repertoire = fixture([
      ['Nf3', 'Nf6', 'g3', 'g6'],
      ['g3', 'g6', 'Nf3', 'Nf6'],
    ]);
    const pack = popularity(repertoire, {
      Nf3: 100,
      Nf6: 90,
      g3: 80,
      g6: 70,
    });
    const scope = createImportanceScope(
      repertoire,
      [repertoire.rootPosition],
      pack.importanceOrder.length,
      pack,
    );
    const transposition = positionAfter(['Nf3', 'Nf6', 'g3', 'g6']);
    const inbound = Object.values(scope.repertoire.edges).filter(
      (edge) => edge.to === transposition,
    );

    expect(pack.importanceOrder.filter((entry) => entry.position === transposition)).toHaveLength(1);
    expect(inbound).toHaveLength(2);
    expect(scope.selectedPositions.size).toBe(pack.importanceOrder.length);
  });

  it('shares one unique-position budget across multiple roots', () => {
    const repertoire = fixture([
      ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'],
      ['d4', 'd5', 'c4', 'e6', 'Nc3'],
    ]);
    const roots = [positionAfter(['e4']), positionAfter(['d4'])];
    const pack = popularity(repertoire, {
      e5: 100,
      Nf3: 90,
      Nc6: 80,
      d5: 70,
      c4: 60,
      e6: 50,
    }, roots);
    const scope = createImportanceScope(repertoire, roots, 4, pack);

    expect(scope.selectedPositions).toHaveLength(4);
    expect(scope.selectedPositions.has(roots[0]!)).toBe(false);
    expect(scope.selectedPositions.has(roots[1]!)).toBe(false);
  });
});

describe('repertoire-conditioned reach', () => {
  it('ranks a 70% reply in a rare own line above a 0.2% reply in a common line', () => {
    const repertoire = fixture([
      ['e4', 'e5'],
      ['d4', 'd5'],
    ]);
    const pack = configuredPopularity(
      repertoire,
      [
        { parent: [], san: 'e4', games: 10 },
        { parent: ['e4'], san: 'e5', games: 700 },
        { parent: [], san: 'd4', games: 1_000_000 },
        { parent: ['d4'], san: 'd5', games: 2_000 },
      ],
      [
        { path: ['e4'], games: 1_000 },
        { path: ['d4'], games: 1_000_000 },
      ],
    );
    const byPosition = new Map(pack.importanceOrder.map((entry) => [entry.position, entry]));
    const rareOwnMove = byPosition.get(positionAfter(['e4']))!;
    const commonOwnMove = byPosition.get(positionAfter(['d4']))!;
    const commonReply = byPosition.get(positionAfter(['e4', 'e5']))!;
    const rareReply = byPosition.get(positionAfter(['d4', 'd5']))!;

    expect(rareOwnMove.repertoireMove).toBe(true);
    expect(rareOwnMove.moveProbabilityFactor).toBe(1);
    expect(rareOwnMove.repertoireConditionedReach).toBe(1);
    expect(commonOwnMove.repertoireConditionedReach).toBe(1);
    expect(commonReply.moveProbabilityFactor).toBeCloseTo(0.7);
    expect(rareReply.moveProbabilityFactor).toBeCloseTo(0.002);
    expect(pack.importanceOrder.indexOf(commonReply))
      .toBeLessThan(pack.importanceOrder.indexOf(rareReply));
  });

  it('uses sample size only as a secondary confidence tie-break', () => {
    const repertoire = fixture([
      ['e4', 'e5'],
      ['d4', 'd5'],
    ]);
    const pack = configuredPopularity(
      repertoire,
      [
        { parent: ['e4'], san: 'e5', games: 4 },
        { parent: ['d4'], san: 'd5', games: 80_000 },
      ],
      [
        { path: ['e4'], games: 5 },
        { path: ['d4'], games: 100_000 },
      ],
    );
    const lowSample = pack.importanceOrder.find(
      (entry) => entry.position === positionAfter(['e4', 'e5']),
    )!;
    const highSample = pack.importanceOrder.find(
      (entry) => entry.position === positionAfter(['d4', 'd5']),
    )!;

    expect(lowSample.repertoireConditionedReach).toBeCloseTo(0.8);
    expect(highSample.repertoireConditionedReach).toBeCloseTo(0.8);
    expect(pack.importanceOrder.indexOf(highSample))
      .toBeLessThan(pack.importanceOrder.indexOf(lowSample));
  });

  it('multiplies only Black opponent decisions in a White repertoire', () => {
    const repertoire = fixture([['e4', 'e5', 'Nf3', 'Nc6']]);
    const pack = configuredPopularity(
      repertoire,
      [
        { parent: [], san: 'e4', games: 5 },
        { parent: ['e4'], san: 'e5', games: 500 },
        { parent: ['e4', 'e5'], san: 'Nf3', games: 4 },
        { parent: ['e4', 'e5', 'Nf3'], san: 'Nc6', games: 250 },
      ],
      [
        { path: ['e4'], games: 1_000 },
        { path: ['e4', 'e5', 'Nf3'], games: 500 },
      ],
    );
    const reaches = pack.importanceOrder.map((entry) => entry.repertoireConditionedReach);

    expect(reaches).toEqual([1, 0.5, 0.5, 0.25]);
    expect(pack.importanceOrder.map((entry) => entry.repertoireMove)).toEqual([
      true, false, true, false,
    ]);
  });

  it('multiplies only White opponent decisions in a Black repertoire', () => {
    const repertoire = fixture([['e4', 'c6', 'd4', 'd5']], 'black');
    const pack = configuredPopularity(
      repertoire,
      [
        { parent: [], san: 'e4', games: 700 },
        { parent: ['e4'], san: 'c6', games: 3 },
        { parent: ['e4', 'c6'], san: 'd4', games: 350 },
        { parent: ['e4', 'c6', 'd4'], san: 'd5', games: 2 },
      ],
      [
        { path: [], games: 1_000 },
        { path: ['e4', 'c6'], games: 700 },
      ],
    );
    const reaches = pack.importanceOrder.map((entry) => entry.repertoireConditionedReach);

    expect(reaches).toEqual([0.7, 0.7, 0.35, 0.35]);
    expect(pack.importanceOrder.map((entry) => entry.repertoireMove)).toEqual([
      false, true, false, true,
    ]);
  });

  it('budgets a transposition once at the highest reachable path probability', () => {
    const repertoire = fixture([
      ['Nf3', 'd5', 'g3'],
      ['g3', 'd5', 'Nf3'],
    ]);
    const pack = configuredPopularity(
      repertoire,
      [
        { parent: ['Nf3'], san: 'd5', games: 700 },
        { parent: ['g3'], san: 'd5', games: 200 },
      ],
      [
        { path: ['Nf3'], games: 1_000 },
        { path: ['g3'], games: 1_000 },
      ],
    );
    const transposition = positionAfter(['Nf3', 'd5', 'g3']);
    const entries = pack.importanceOrder.filter((entry) => entry.position === transposition);
    const scope = createImportanceScope(
      repertoire,
      [repertoire.rootPosition],
      pack.importanceOrder.length,
      pack,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.repertoireConditionedReach).toBeCloseTo(0.7);
    expect(Object.values(scope.repertoire.edges).filter(
      (edge) => edge.to === transposition,
    )).toHaveLength(2);
  });
});

describe('Importance budget choices', () => {
  it('uses coarse steps and always retains an irregular maximum', () => {
    expect(importanceBudgetOptions(2645)).toEqual([
      ...Array.from({ length: 52 }, (_, index) => (index + 1) * 50),
      2645,
    ]);
    expect(importanceBudgetOptions(273)).toEqual([50, 100, 150, 200, 250, 273]);
    expect(importanceBudgetOptions(101)).toEqual([50, 100, 101]);
    expect(importanceBudgetOptions(100)).toEqual(
      Array.from({ length: 10 }, (_, index) => (index + 1) * 10),
    );
    expect(importanceBudgetOptions(73)).toEqual([10, 20, 30, 40, 50, 60, 70, 73]);
    expect(importanceBudgetOptions(7)).toEqual([7]);
  });

  it('normalizes legacy values to the nearest valid in-range choice', () => {
    expect(normalizeImportanceBudget(213, 273)).toBe(200);
    expect(normalizeImportanceBudget(1847, 2645)).toBe(1850);
    expect(normalizeImportanceBudget(225, 273)).toBe(200);
    expect(normalizeImportanceBudget(9999, 273)).toBe(273);
    expect(normalizeImportanceBudget(-10, 273)).toBe(50);
  });
});

describe('Importance Practice integration', () => {
  it('creates full-line and Random Recall items only from scoped edges', () => {
    const repertoire = fixture([
      ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'],
      ['d4', 'd5', 'c4', 'e6', 'Nc3'],
    ]);
    const pack = popularity(repertoire, {
      e4: 100,
      e5: 90,
      Nf3: 80,
      Nc6: 70,
      Bb5: 60,
      d4: 10,
    });
    const scope = createImportanceScope(repertoire, [repertoire.rootPosition], 5, pack);
    const depth = maximumPracticeDepth(scope.repertoire, scope.repertoire.rootPosition);
    const lines = createPracticeItems(scope.repertoire, scope.repertoire.rootPosition, depth);
    const moves = createMovePracticeItems(scope.repertoire, [scope.repertoire.rootPosition], depth);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.flatMap((line) => line.edgeIds).every((id) => scope.selectedEdgeIds.has(id))).toBe(true);
    expect(moves.every((item) => scope.selectedEdgeIds.has(item.edgeId))).toBe(true);
  });

  it('extends a White scope ending on a Black move through the stored White response', () => {
    const repertoire = fixture([['e4', 'e5', 'Nf3', 'Nc6']]);
    const pack = popularity(repertoire, { e4: 100, e5: 90, Nf3: 80, Nc6: 70 });
    const scope = createImportanceScope(repertoire, [repertoire.rootPosition], 2, pack);
    const items = createPracticeItems(
      scope.repertoire,
      scope.repertoire.rootPosition,
      Math.max(1, maximumPracticeDepth(scope.repertoire, scope.repertoire.rootPosition)),
      { boundary: 'scope-end', continuationRepertoire: repertoire },
    );

    expect(scope.summary.positions).toBe(2);
    expect(scope.selectedPositions.has(positionAfter(['e4', 'e5', 'Nf3']))).toBe(false);
    expect(items[0]?.sans).toEqual(['e4', 'e5', 'Nf3']);
  });

  it('extends a Black scope ending on a White move through the stored Black response', () => {
    const repertoire = fixture([['e4', 'c6', 'd4', 'd5']], 'black');
    const pack = popularity(repertoire, { e4: 100, c6: 90, d4: 80, d5: 70 });
    const scope = createImportanceScope(repertoire, [repertoire.rootPosition], 1, pack);
    const items = createPracticeItems(
      scope.repertoire,
      scope.repertoire.rootPosition,
      Math.max(1, maximumPracticeDepth(scope.repertoire, scope.repertoire.rootPosition)),
      { boundary: 'scope-end', continuationRepertoire: repertoire },
    );

    expect(scope.summary.positions).toBe(1);
    expect(scope.selectedPositions.has(positionAfter(['e4', 'c6']))).toBe(false);
    expect(items[0]?.sans).toEqual(['e4', 'c6']);
  });

  it('leaves an opponent-ending scope unchanged when no repertoire response exists', () => {
    const repertoire = fixture([['e4', 'e5']]);
    const pack = popularity(repertoire, { e4: 100, e5: 90 });
    const scope = createImportanceScope(repertoire, [repertoire.rootPosition], 2, pack);
    const items = createPracticeItems(
      scope.repertoire,
      scope.repertoire.rootPosition,
      1,
      { boundary: 'scope-end', continuationRepertoire: repertoire },
    );

    expect(scope.summary.positions).toBe(2);
    expect(items[0]?.sans).toEqual(['e4', 'e5']);
  });

  it('keeps one stable item when a smaller scope extension matches the larger scope', () => {
    const repertoire = fixture([['e4', 'e5', 'Nf3', 'Nc6']]);
    const pack = popularity(repertoire, { e4: 100, e5: 90, Nf3: 80, Nc6: 70 });
    const smallerScope = createImportanceScope(
      repertoire,
      [repertoire.rootPosition],
      2,
      pack,
    );
    const largerScope = createImportanceScope(
      repertoire,
      [repertoire.rootPosition],
      3,
      pack,
    );
    const itemFor = (scope: ReturnType<typeof createImportanceScope>) =>
      createPracticeItems(
        scope.repertoire,
        scope.repertoire.rootPosition,
        Math.max(1, maximumPracticeDepth(scope.repertoire, scope.repertoire.rootPosition)),
        { boundary: 'scope-end', continuationRepertoire: repertoire },
      );
    const smallerItems = itemFor(smallerScope);
    const largerItems = itemFor(largerScope);

    expect(smallerScope.summary.positions).toBe(2);
    expect(largerScope.summary.positions).toBe(3);
    expect(smallerItems).toHaveLength(1);
    expect(largerItems).toHaveLength(1);
    expect(smallerItems[0]?.sans).toEqual(['e4', 'e5', 'Nf3']);
    expect(largerItems[0]?.sans).toEqual(smallerItems[0]?.sans);
    expect(largerItems[0]?.id).toBe(smallerItems[0]?.id);
  });
});

describe('canonical position identity', () => {
  it('keeps board, turn, castling and en-passant state but removes move clocks', () => {
    expect(normalizeFen('8/8/8/8/8/8/8/K6k w - e3 17 42')).toBe(
      '8/8/8/8/8/8/8/K6k w - e3',
    );
  });
});
