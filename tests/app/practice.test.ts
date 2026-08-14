import { describe, expect, it } from 'vitest';

import { buildCanonicalRepertoire } from '../../scripts/lib/build.js';
import { combineRepertoires } from '../../src/domain/combined-openings.js';
import {
  activeRepertoireCandidate,
  advancePracticeProgress,
  canContinuePracticeLine,
  canStartPracticeExercise,
  chooseOpponentEdge,
  chooseWeightedPracticeLine,
  completePracticeLineRun,
  createMovePracticeItems,
  createPracticeItems,
  createPracticeLines,
  deterministicStartingPath,
  classifyPracticeCompletion,
  eligibleOpponentEdges,
  maximumPracticeDepth,
  markPracticeLineUnderstood,
  penalizePracticeLine,
  practiceLineProgress,
  practiceSelectionWeight,
  requiredCleanRuns,
  selectPracticeItem,
  type PracticeShuffleState,
  type PracticeLineProgressMap,
} from '../../src/domain/practice.js';
import { normalizeFen } from '../../src/domain/repertoire.js';
import { createFixtureStudy, createLoadedSources, linePositions } from '../fixtures/repertoire-fixture.js';

function fixture(side: 'white' | 'black', lines: string[][], openingId = 'practice') {
  return buildCanonicalRepertoire(
    createLoadedSources(lines.map((sans, index) => createFixtureStudy({ studyFolder: `line-${index}`, lines: [{ sans }] }))),
    { repertoireSide: side, openingId, title: 'Practice' },
  ).repertoire;
}

function positionAfter(sans: string[]): string {
  return normalizeFen(linePositions(sans).at(-1)!);
}

describe('Practice progression', () => {
  it('increments only correct repertoire decisions and shown solutions', () => {
    expect(advancePracticeProgress(0, 'opponent-move')).toBe(0);
    expect(advancePracticeProgress(0, 'incorrect-move')).toBe(0);
    expect(advancePracticeProgress(0, 'hint')).toBe(0);
    expect(advancePracticeProgress(0, 'correct-repertoire-move')).toBe(1);
    expect(advancePracticeProgress(1, 'shown-solution')).toBe(2);
  });
  it('counts repertoire decisions rather than plies for a Black repertoire', () => {
    const data = fixture('black', [['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4']]);
    expect(maximumPracticeDepth(data, data.rootPosition)).toBe(3);
  });

  it('counts three White decisions in the same continuation', () => {
    const data = fixture('white', [['d4', 'd5', 'Bf4', 'Nf6', 'e3']]);
    expect(maximumPracticeDepth(data, data.rootPosition)).toBe(3);
  });

  it('starts depth at zero for a selected later position', () => {
    const data = fixture('black', [['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4', 'Bf5']]);
    const selected = linePositions(['e4', 'c6']).at(-1)!;
    const normalized = selected.split(' ').slice(0, 4).join(' ');
    expect(maximumPracticeDepth(data, normalized)).toBe(3);
  });

  it('recognizes a valid continuation after a completed depth segment', () => {
    const data = fixture('black', [[
      'e4',
      'c6',
      'd4',
      'd5',
      'Nc3',
      'dxe4',
      'Nxe4',
      'Bf5',
    ]]);
    const afterThirdDecision = positionAfter([
      'e4',
      'c6',
      'd4',
      'd5',
      'Nc3',
      'dxe4',
    ]);

    expect(canContinuePracticeLine(data, afterThirdDecision)).toBe(true);
    expect(
      classifyPracticeCompletion(data, afterThirdDecision, true),
    ).toBe('target-depth-reached');
    expect(maximumPracticeDepth(data, afterThirdDecision)).toBe(1);
  });

  it('classifies the actual stored line end ahead of a simultaneous depth limit', () => {
    const data = fixture('black', [['e4', 'c6']]);
    const lineEnd = positionAfter(['e4', 'c6']);

    expect(canContinuePracticeLine(data, lineEnd)).toBe(false);
    expect(classifyPracticeCompletion(data, lineEnd, true)).toBe(
      'stored-line-ended',
    );
  });

  it('validates the selected candidate against its stored edge', () => {
    const data = fixture('black', [['e4', 'c6']]);
    const repertoirePosition = positionAfter(['e4']);
    const decision = data.repertoireDecisionNodes[repertoirePosition]!;
    const selected = decision.candidates.find(
      (candidate) => candidate.id === decision.selectedCandidateId,
    )!;

    expect(activeRepertoireCandidate(data, repertoirePosition)).toBe(selected);
    selected.edgeId = 'missing-edge';
    expect(activeRepertoireCandidate(data, repertoirePosition)).toBeNull();
    expect(classifyPracticeCompletion(data, repertoirePosition, false)).toBe(
      'unresolved-repertoire-decision',
    );
  });

  it('distinguishes an unresolved reply from a valid starting exercise', () => {
    const data = fixture('black', [
      ['e4', 'c6'],
      ['e4', 'e6'],
    ]);
    const repertoirePosition = positionAfter(['e4']);

    expect(activeRepertoireCandidate(data, repertoirePosition)).toBeNull();
    expect(
      classifyPracticeCompletion(data, repertoirePosition, false),
    ).toBe('unresolved-repertoire-decision');
    expect(canStartPracticeExercise(data, data.rootPosition)).toBe(false);
    expect(classifyPracticeCompletion(data, data.rootPosition, false)).toBe(
      'no-valid-opponent-continuation',
    );
  });

  it('uses the stored side to move for White and Black starting positions', () => {
    const white = fixture('white', [
      ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'e6', 'Nf3'],
    ]);
    const black = fixture('black', [['e4', 'c6', 'd4', 'd5']]);
    const afterWhiteThirdDecision = positionAfter([
      'd4',
      'd5',
      'Bf4',
      'Nf6',
      'e3',
    ]);

    expect(canStartPracticeExercise(white, white.rootPosition)).toBe(true);
    expect(activeRepertoireCandidate(white, white.rootPosition)?.san).toBe('d4');
    expect(canContinuePracticeLine(white, afterWhiteThirdDecision)).toBe(true);
    expect(canStartPracticeExercise(black, black.rootPosition)).toBe(true);
    expect(activeRepertoireCandidate(black, black.rootPosition)).toBeNull();
  });

  it('classifies an explicit user ending independently of graph state', () => {
    const data = fixture('white', [['d4', 'd5', 'Bf4']]);

    expect(
      classifyPracticeCompletion(data, data.rootPosition, false, true),
    ).toBe('user-ended-exercise');
  });

  it('never reuses a shuffle-bag edge from another source position', () => {
    const data = fixture('black', [
      ['e4', 'c6', 'd4', 'd5'],
      ['Nf3', 'c6', 'd4', 'd5'],
    ]);
    const first = chooseOpponentEdge(data, data.rootPosition, { seed: 7, bags: {} });
    expect(first.edge?.from).toBe(data.rootPosition);
    const nextPosition = first.edge ? data.edges[data.repertoireDecisionNodes[first.edge.to]!.candidates[0]!.edgeId]!.to : '';
    const second = chooseOpponentEdge(data, nextPosition, first.state);
    expect(second.edge?.from).toBe(nextPosition);
    expect(eligibleOpponentEdges(data, nextPosition)).toContainEqual(second.edge);
  });

  it('avoids an immediate repeat when a position bag is refilled', () => {
    const data = fixture('black', [
      ['e4', 'c6'],
      ['d4', 'd5'],
      ['Nf3', 'c6'],
    ]);
    const eligibleCount = eligibleOpponentEdges(data, data.rootPosition).length;
    let state: PracticeShuffleState = { seed: 7, bags: {} };
    const firstCycle: string[] = [];

    for (let index = 0; index < eligibleCount; index += 1) {
      const choice = chooseOpponentEdge(data, data.rootPosition, state);
      expect(choice.edge).not.toBeNull();
      firstCycle.push(choice.edge!.id);
      state = choice.state;
    }

    expect(new Set(firstCycle).size).toBe(eligibleCount);
    const refill = chooseOpponentEdge(data, data.rootPosition, state);
    expect(refill.edge?.id).not.toBe(firstCycle.at(-1));
  });
});

describe('weighted practice-line learning', () => {
  it.each([
    [0, 1], [1, 2], [2, 2], [3, 3], [4, 3], [5, 4], [6, 4],
    [7, 4], [8, 4], [10, 5], [18, 6],
  ])('requires %i mistakes to be repaid by %i clean runs', (mistakes, required) => {
    expect(requiredCleanRuns(mistakes)).toBe(required);
  });

  it('masters only a clean run and preserves penalties on a failed run', () => {
    const data = fixture('black', [['e4', 'c6']]);
    const line = createPracticeLines(data)[0]!;
    let progress: PracticeLineProgressMap = {};
    expect(practiceLineProgress(progress, line.id).n).toBe(1);
    progress = completePracticeLineRun(progress, line.id, true);
    expect(practiceLineProgress(progress, line.id)).toMatchObject({ n: 0, mastered: true, cleanRuns: 1 });

    progress = {};
    progress = penalizePracticeLine(progress, line.id);
    expect(practiceLineProgress(progress, line.id).n).toBe(2);
    progress = completePracticeLineRun(progress, line.id, false);
    expect(practiceLineProgress(progress, line.id).n).toBe(2);
    progress = completePracticeLineRun(progress, line.id, true);
    expect(practiceLineProgress(progress, line.id).n).toBe(1);
    progress = completePracticeLineRun(progress, line.id, true);
    expect(practiceLineProgress(progress, line.id)).toMatchObject({ n: 0, mastered: true, mistakes: 1, cleanRuns: 2 });
  });

  it('counts every mistake and solution, while manual understanding masters immediately', () => {
    const data = fixture('white', [['d4', 'd5', 'Bf4']]);
    const line = createPracticeLines(data)[0]!;
    let progress: PracticeLineProgressMap = {};
    progress = penalizePracticeLine(progress, line.id);
    progress = penalizePracticeLine(progress, line.id);
    progress = penalizePracticeLine(progress, line.id);
    expect(practiceLineProgress(progress, line.id)).toMatchObject({ mistakes: 3, required: 3, n: 3 });
    progress = penalizePracticeLine(progress, line.id); // Show solution uses the same penalty.
    expect(practiceLineProgress(progress, line.id)).toMatchObject({ mistakes: 4, required: 3, n: 3 });
    progress = markPracticeLineUnderstood(progress, line.id);
    expect(practiceLineProgress(progress, line.id)).toMatchObject({ n: 0, mastered: true, cleanRuns: 3 });
  });

  it('uses injected weighted RNG and prevents an immediate repeat', () => {
    const data = fixture('black', [
      ['e4', 'c6'],
      ['d4', 'd5'],
      ['Nf3', 'Nf6'],
    ]);
    const lines = createPracticeLines(data);
    const progress = Object.fromEntries(lines.map((line, index) => [
      line.id,
      index === 2 ? { mistakes: 8, cleanRuns: 0 } : { mistakes: 0, cleanRuns: 0 },
    ]));
    expect(chooseWeightedPracticeLine(lines, progress, () => 0.99)?.id).toBe(lines[2]?.id);
    const previous = chooseWeightedPracticeLine(lines, progress, () => 0)?.id;
    expect(chooseWeightedPracticeLine(lines, progress, () => 0, previous)?.id).not.toBe(previous);
    expect(chooseWeightedPracticeLine([lines[0]!], {}, () => 0, lines[0]?.id)?.id).toBe(lines[0]?.id);
  });

  it('ages skipped items and resets the selected item without excluding others', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(practiceSelectionWeight(1, 5)).toBeGreaterThan(practiceSelectionWeight(1, 0));

    const result = selectPracticeItem(
      items,
      {},
      { skipsSinceSeen: { a: 5, b: 1, c: 0 } },
      () => 0,
    );
    expect(result.item?.id).toBe('a');
    expect(result.state.skipsSinceSeen).toEqual({ a: 0, b: 2, c: 1 });
  });

  it('protects against immediate repeats and relaxes exclusions for a tiny pool', () => {
    const items = [{ id: 'a' }, { id: 'b' }];
    const selected = selectPracticeItem(items, {}, { skipsSinceSeen: {} }, () => 0, 'a');
    expect(selected.item?.id).toBe('b');
    expect(selectPracticeItem([items[0]!], {}, { skipsSinceSeen: {} }, () => 0, 'a').item?.id).toBe('a');
    expect(selectPracticeItem(items, {}, { skipsSinceSeen: {} }, () => 0, null, new Set(['a', 'b'])).item).not.toBeNull();
  });

  it('keeps separate stable items for source lines and finds the first branch', () => {
    const data = fixture('black', [
      ['e4', 'c6', 'd4', 'd5'],
      ['e4', 'c6', 'Nf3', 'd5'],
    ]);
    const lines = createPracticeLines(data);
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((line) => line.id)).size).toBe(2);
    expect(createPracticeLines(data).map((line) => line.id)).toEqual(lines.map((line) => line.id));
    expect(deterministicStartingPath(data).map((edge) => edge.san)).toEqual(['e4', 'c6']);
  });

  it('finds the same deterministic prefix in a runtime Combined Black graph', () => {
    const dragon = fixture('black', [['e4', 'c5', 'Nf3', 'Nc6']], 'sicilian-dragon');
    const fourKnights = fixture('black', [['e4', 'c5', 'a3', 'Nc6']], 'four-knights-sicilian');
    const combined = combineRepertoires({
      id: 'complete-sicilian',
      title: 'Complete Sicilian',
      repertoireSide: 'black',
      openingIds: ['sicilian-dragon', 'four-knights-sicilian'],
      availableModes: ['book', 'practice', 'explorer'],
    }, [dragon, fourKnights]);

    expect(combined.openingSide).toBe('black');
    expect(deterministicStartingPath(combined).map((edge) => edge.san)).toEqual(['e4', 'c5']);
  });
});

describe('depth-bounded practice items', () => {
  it('deduplicates theory leaves that diverge only after the selected depth', () => {
    const data = fixture('white', [
      ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'e6', 'Nf3'],
      ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'c5', 'Nf3'],
      ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'g6', 'Nf3'],
      ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'Bf5', 'Nf3'],
    ]);

    const items = createPracticeItems(data, data.rootPosition, 3);
    expect(items).toHaveLength(1);
    expect(items[0]?.sans).toEqual(['d4', 'd5', 'Bf4', 'Nf6', 'e3']);
    expect(items[0]?.theoryLineageIds).toHaveLength(4);
  });

  it('keeps branches within the selected depth as separate items', () => {
    const data = fixture('white', [
      ['d4', 'd5', 'Bf4'],
      ['Nf3', 'd5', 'd4'],
    ]);

    expect(createPracticeItems(data, data.rootPosition, 2)).toHaveLength(2);
  });

  it('removes every identical leaf representation after its shared item is mastered', () => {
    const data = fixture('white', [
      ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'e6'],
      ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'c5'],
      ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'g6'],
      ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'Bf5'],
    ]);
    const items = createPracticeItems(data, data.rootPosition, 3);
    const progress = completePracticeLineRun({}, items[0]!.id, true);

    expect(items).toHaveLength(1);
    expect(chooseWeightedPracticeLine(items, progress, () => 0)).toBeNull();
  });

  it('weights the three deduplicated items rather than ten theory leaves', () => {
    const data = fixture('black', [
      ['e4', 'c6', 'd4', 'd5'],
      ['e4', 'c6', 'Nf3', 'd5'],
      ['e4', 'c6', 'c4', 'd5'],
      ['e4', 'c6', 'b3', 'd5'],
      ['d4', 'd5', 'c4', 'e6'],
      ['d4', 'd5', 'Nf3', 'Nf6'],
      ['d4', 'd5', 'Bf4', 'Nf6'],
      ['Nf3', 'Nf6', 'd4', 'd5'],
      ['Nf3', 'Nf6', 'c4', 'g6'],
      ['Nf3', 'Nf6', 'g3', 'g6'],
    ]);
    const items = createPracticeItems(data, data.rootPosition, 1);
    const progress = Object.fromEntries(items.map((item, index) => [
      item.id,
      [
        { mistakes: 0, cleanRuns: 0 },
        { mistakes: 1, cleanRuns: 0 },
        { mistakes: 8, cleanRuns: 0 },
      ][index]!,
    ]));

    expect(items).toHaveLength(3);
    expect(chooseWeightedPracticeLine(items, progress, () => 0.99)?.id).toBe(items[2]?.id);
  });

  it('reports three remaining items when one of four depth items is mastered', () => {
    const data = fixture('black', [
      ['e4', 'c6', 'd4', 'd5'],
      ['e4', 'c6', 'Nf3', 'd5'],
      ['d4', 'd5', 'c4', 'e6'],
      ['d4', 'd5', 'Nf3', 'Nf6'],
      ['Nf3', 'Nf6', 'd4', 'd5'],
      ['Nf3', 'Nf6', 'c4', 'g6'],
      ['c4', 'e5', 'Nc3', 'Nf6'],
      ['c4', 'e5', 'Nf3', 'Nc6'],
      ['c4', 'e5', 'g3', 'Nf6'],
      ['c4', 'e5', 'e3', 'Nf6'],
    ]);
    const items = createPracticeItems(data, data.rootPosition, 1);
    const progress = markPracticeLineUnderstood({}, items[0]!.id);

    expect(items).toHaveLength(4);
    expect(items.filter((item) => practiceLineProgress(progress, item.id).n > 0)).toHaveLength(3);
  });

  it('keeps a longer depth item active when its depth-three prefix is mastered', () => {
    const data = fixture('white', [
      ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'e6', 'Nf3'],
      ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'c5', 'Nf3'],
    ]);
    const depthThree = createPracticeItems(data, data.rootPosition, 3)[0]!;
    const depthFour = createPracticeItems(data, data.rootPosition, 4);
    const progress = markPracticeLineUnderstood({}, depthThree.id);

    expect(depthFour).toHaveLength(2);
    expect(depthFour.every((item) => item.id !== depthThree.id)).toBe(true);
    expect(depthFour.every((item) => practiceLineProgress(progress, item.id).n === 1)).toBe(true);
  });

  it('marks an already mastered item idempotently', () => {
    const data = fixture('black', [['e4', 'c6']]);
    const item = createPracticeItems(data, data.rootPosition, 1)[0]!;
    const first = markPracticeLineUnderstood({}, item.id);
    const second = markPracticeLineUnderstood(first, item.id);

    expect(practiceLineProgress(second, item.id)).toMatchObject({ n: 0, mastered: true });
  });

  it('prevents immediate repetition across deduplicated active items', () => {
    const data = fixture('black', [
      ['e4', 'c6', 'd4', 'd5'],
      ['e4', 'c6', 'Nf3', 'd5'],
      ['d4', 'd5', 'c4', 'e6'],
    ]);
    const items = createPracticeItems(data, data.rootPosition, 1);
    const previous = chooseWeightedPracticeLine(items, {}, () => 0)!;

    expect(items).toHaveLength(2);
    expect(chooseWeightedPracticeLine(items, {}, () => 0, previous.id)?.id).not.toBe(previous.id);
  });
});

describe('Random Move Recall candidates', () => {
  it('extracts one stable item per position and stored repertoire move', () => {
    const data = fixture('white', [
      ['d4', 'd5', 'Bf4'],
      ['d4', 'd5', 'Nf3'],
      ['d4', 'Nf6', 'Bf4'],
    ]);
    const items = createMovePracticeItems(data, [data.rootPosition], 2);

    expect(items.map((item) => item.san).sort()).toEqual(['Bf4', 'Bf4', 'Nf3', 'd4']);
    expect(items.filter((item) => item.position === data.rootPosition)).toHaveLength(1);
    expect(createMovePracticeItems(data, [data.rootPosition], 2).map((item) => item.id))
      .toEqual(items.map((item) => item.id));
  });

  it('limits candidates by repertoire decisions relative to each root', () => {
    const data = fixture('white', [[
      'd4', 'd5', 'Bf4', 'Nf6', 'e3', 'e6', 'Nf3',
    ]]);
    const laterRoot = positionAfter(['d4', 'd5']);

    expect(createMovePracticeItems(data, [data.rootPosition], 2).map((item) => item.san).sort())
      .toEqual(['Bf4', 'd4']);
    expect(createMovePracticeItems(data, [laterRoot], 2).map((item) => item.san).sort())
      .toEqual(['Bf4', 'e3']);
  });

  it('unions multiple starting positions without duplicating overlapping items', () => {
    const data = fixture('white', [[
      'd4', 'd5', 'Bf4', 'Nf6', 'e3', 'e6', 'Nf3',
    ]]);
    const laterRoot = positionAfter(['d4', 'd5']);
    const items = createMovePracticeItems(data, [data.rootPosition, laterRoot], 2);

    expect(items.map((item) => item.san).sort()).toEqual(['Bf4', 'd4', 'e3']);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  it('deduplicates identical theory leaves and accepts distinct stored moves at one position', () => {
    const data = fixture('white', [
      ['d4', 'd5', 'Bf4', 'Nf6'],
      ['d4', 'd5', 'Bf4', 'c5'],
      ['d4', 'd5', 'Nf3', 'Nf6'],
    ]);
    const items = createMovePracticeItems(data, [data.rootPosition], 2);
    const decision = positionAfter(['d4', 'd5']);

    expect(items.filter((item) => item.san === 'd4')).toHaveLength(1);
    expect(items.filter((item) => item.position === decision).map((item) => item.san).sort())
      .toEqual(['Bf4', 'Nf3']);
  });

  it('marks direct predecessor and successor recall items as adjacent', () => {
    const data = fixture('white', [[
      'd4', 'd5', 'Bf4', 'Nf6', 'e3', 'e6', 'Nf3',
    ]]);
    const items = createMovePracticeItems(data, [data.rootPosition], 4);
    const bySan = Object.fromEntries(items.map((item) => [item.san, item]));

    expect(bySan.d4?.adjacentItemIds).toContain(bySan.Bf4?.id);
    expect(bySan.Bf4?.adjacentItemIds).toEqual(expect.arrayContaining([bySan.d4?.id, bySan.e3?.id]));
    expect(bySan.d4?.adjacentItemIds).not.toContain(bySan.e3?.id);
  });

  it('relaxes adjacency exclusion when no unrelated active item exists', () => {
    const items = [{ id: 'a' }, { id: 'b' }];
    const result = selectPracticeItem(
      items,
      {},
      { skipsSinceSeen: {} },
      () => 0,
      'a',
      new Set(['b']),
    );

    expect(result.item?.id).toBe('b');
  });
});
