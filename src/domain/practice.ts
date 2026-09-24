import { Chess } from 'chess.js';

import type {
  CanonicalEdge,
  CanonicalRepertoire,
  RepertoireMoveCandidate,
} from './repertoire.js';
import { stableId } from './repertoire.js';
import { createVariationIndex } from './variations.js';

export interface PracticeShuffleState {
  seed: number;
  bags: Record<string, string[]>;
  lastChoices?: Record<string, string>;
}

export const PRACTICE_AGING_FACTOR = 0.15;

export interface PracticeSchedulerState {
  skipsSinceSeen: Record<string, number>;
}

export interface PracticeItem {
  id: string;
  openingId: string;
  rootPosition: string;
  endPosition: string;
  trainingDepth: number;
  edgeIds: readonly string[];
  sans: readonly string[];
  /** Deterministic representative used only to continue beyond this exercise. */
  theoryEdgeIds: readonly string[];
  theoryLineageIds: readonly string[];
}

export interface CreatePracticeItemsOptions {
  /** Use the complete path present in a pre-scoped graph instead of decision depth. */
  boundary?: 'decision-depth' | 'scope-end';
  /** Full stored theory used only to append the next repertoire response. */
  continuationRepertoire?: CanonicalRepertoire;
}

export interface MovePracticeItem {
  id: string;
  openingId: string;
  position: string;
  fen: string;
  edgeId: string;
  san: string;
  from: string;
  to: string;
  targetPosition: string;
  adjacentItemIds: readonly string[];
}

/** Kept as a compatibility name for callers that display a practice line. */
export type PracticeLine = PracticeItem;

export interface PracticeLineProgress {
  mistakes: number;
  cleanRuns: number;
  required: number;
  n: number;
  mastered: boolean;
}

export interface StoredPracticeProgress {
  mistakes: number;
  cleanRuns: number;
}

export type PracticeLineProgressMap = Record<string, StoredPracticeProgress>;

const DEFAULT_LINE_PROGRESS: Readonly<PracticeLineProgress> = {
  mistakes: 0,
  cleanRuns: 0,
  required: 1,
  n: 1,
  mastered: false,
};

export function requiredCleanRuns(mistakes: number): number {
  const normalized = Number.isSafeInteger(mistakes) && mistakes > 0
    ? mistakes
    : 0;
  return normalized === 0 ? 1 : Math.ceil(Math.sqrt(2 * normalized));
}

function storedProgress(progress: PracticeLineProgress): StoredPracticeProgress {
  return { mistakes: progress.mistakes, cleanRuns: progress.cleanRuns };
}

export function practiceLineProgress(
  progress: Readonly<PracticeLineProgressMap>,
  lineId: string,
): PracticeLineProgress {
  const value = progress[lineId];
  if (
    !value ||
    !Number.isSafeInteger(value.mistakes) ||
    value.mistakes < 0 ||
    !Number.isSafeInteger(value.cleanRuns) ||
    value.cleanRuns < 0
  ) {
    return { ...DEFAULT_LINE_PROGRESS };
  }
  const required = requiredCleanRuns(value.mistakes);
  const n = Math.max(0, required - value.cleanRuns);
  return {
    mistakes: value.mistakes,
    cleanRuns: value.cleanRuns,
    required,
    n,
    mastered: n === 0,
  };
}

export function penalizePracticeLine(
  progress: Readonly<PracticeLineProgressMap>,
  lineId: string,
): PracticeLineProgressMap {
  const current = practiceLineProgress(progress, lineId);
  return {
    ...progress,
    [lineId]: {
      mistakes: current.mistakes + 1,
      cleanRuns: current.cleanRuns,
    },
  };
}

export function completePracticeLineRun(
  progress: Readonly<PracticeLineProgressMap>,
  lineId: string,
  clean: boolean,
): PracticeLineProgressMap {
  const current = practiceLineProgress(progress, lineId);
  if (!clean) return { ...progress, [lineId]: storedProgress(current) };
  return {
    ...progress,
    [lineId]: {
      mistakes: current.mistakes,
      cleanRuns: current.cleanRuns + 1,
    },
  };
}

export function markPracticeLineUnderstood(
  progress: Readonly<PracticeLineProgressMap>,
  lineId: string,
): PracticeLineProgressMap {
  const current = practiceLineProgress(progress, lineId);
  return {
    ...progress,
    [lineId]: {
      mistakes: current.mistakes,
      cleanRuns: Math.max(current.cleanRuns, current.required),
    },
  };
}

export function resetPracticeItemProgress(
  progress: Readonly<PracticeLineProgressMap>,
  itemIds: Iterable<string>,
): PracticeLineProgressMap {
  const resetIds = new Set(itemIds);
  return Object.fromEntries(
    Object.entries(progress).filter(([id]) => !resetIds.has(id)),
  );
}

interface CompleteTheoryLine {
  edgeIds: string[];
  lineageId: string;
}

function completeTheoryLines(
  repertoire: CanonicalRepertoire,
  rootPosition: string,
): CompleteTheoryLine[] {
  const index = createVariationIndex(repertoire);
  const lines: CompleteTheoryLine[] = [];
  for (const lineage of index.remainingLineagesByPosition[rootPosition] ?? []) {
    const lineageEdges = new Set(lineage.edgeIds);
    const edgeIds: string[] = [];
    let position = rootPosition;
    const visited = new Set<string>();
    while (!visited.has(position)) {
      visited.add(position);
      const candidates = (index.outgoingEdgesByPosition[position] ?? [])
        .filter((edge) => lineageEdges.has(edge.id));
      const edge = candidates[0];
      if (!edge) break;
      edgeIds.push(edge.id);
      position = edge.to;
    }
    if (edgeIds.length === 0) continue;
    lines.push({
      edgeIds,
      lineageId: lineage.id,
    });
  }
  return lines;
}

function edgePathSignature(
  repertoire: CanonicalRepertoire,
  edgeIds: readonly string[],
): readonly unknown[] {
  return edgeIds.map((id) => {
    const edge = repertoire.edges[id];
    return edge ? [edge.from, edge.san, edge.to] : id;
  });
}

function practicePrefix(
  repertoire: CanonicalRepertoire,
  edgeIds: readonly string[],
  trainingDepth: number,
): string[] {
  const repertoireTurn = repertoire.openingSide === 'white' ? 'w' : 'b';
  const prefix: string[] = [];
  let decisions = 0;
  for (const edgeId of edgeIds) {
    const edge = repertoire.edges[edgeId];
    if (!edge) break;
    prefix.push(edgeId);
    if (repertoire.positions[edge.from]?.turn === repertoireTurn) {
      decisions += 1;
      if (decisions >= trainingDepth) break;
    }
  }
  return prefix;
}

function finishAfterRepertoireMove(
  repertoire: CanonicalRepertoire,
  edgeIds: readonly string[],
): string[] {
  const prefix = [...edgeIds];
  const endPosition = repertoire.edges[prefix.at(-1) ?? '']?.to;
  if (!endPosition) return prefix;
  if (repertoire.positions[endPosition]?.turn !== repertoireTurn(repertoire)) {
    return prefix;
  }
  const response = activeRepertoireCandidate(repertoire, endPosition);
  return response ? [...prefix, response.edgeId] : prefix;
}

function isStrictFinalizedPrefix(
  repertoire: CanonicalRepertoire,
  shorter: readonly string[],
  longer: readonly string[],
): boolean {
  if (shorter.length >= longer.length) return false;
  return shorter.every((edgeId, index) => {
    const left = repertoire.edges[edgeId];
    const right = repertoire.edges[longer[index] ?? ''];
    if (!left || !right) return edgeId === longer[index];
    return (
      left.from === right.from &&
      left.san === right.san &&
      left.to === right.to
    );
  });
}

/**
 * Builds one stable item per unique path visible at the configured depth.
 * Later theory branches and source-lineage order never affect item identity.
 */
export function createPracticeItems(
  repertoire: CanonicalRepertoire,
  rootPosition = repertoire.rootPosition,
  trainingDepth = maximumPracticeDepth(repertoire, rootPosition),
  options: CreatePracticeItemsOptions = {},
): PracticeItem[] {
  const normalizedDepth = Math.max(1, trainingDepth);
  const executionRepertoire = options.continuationRepertoire ?? repertoire;
  const grouped = new Map<string, {
    prefix: string[];
    representative: CompleteTheoryLine;
    lineageIds: Set<string>;
  }>();

  for (const theoryLine of completeTheoryLines(repertoire, rootPosition)) {
    const nominalPrefix = options.boundary === 'scope-end'
      ? theoryLine.edgeIds
      : practicePrefix(repertoire, theoryLine.edgeIds, normalizedDepth);
    const prefix = finishAfterRepertoireMove(executionRepertoire, nominalPrefix);
    if (prefix.length === 0) continue;
    // Extension happens before grouping: the final trained path is the sole
    // deduplication and identity boundary, never the formal scope cutoff.
    const signature = JSON.stringify(edgePathSignature(executionRepertoire, prefix));
    const existing = grouped.get(signature);
    if (!existing) {
      grouped.set(signature, {
        prefix,
        representative: theoryLine,
        lineageIds: new Set([theoryLine.lineageId]),
      });
      continue;
    }
    existing.lineageIds.add(theoryLine.lineageId);
    const currentSignature = JSON.stringify(edgePathSignature(executionRepertoire, existing.representative.edgeIds));
    const candidateSignature = JSON.stringify(edgePathSignature(executionRepertoire, theoryLine.edgeIds));
    if (
      theoryLine.edgeIds.length > existing.representative.edgeIds.length ||
      (theoryLine.edgeIds.length === existing.representative.edgeIds.length && candidateSignature < currentSignature)
    ) {
      existing.representative = theoryLine;
    }
  }

  const finalizedGroups = [...grouped.values()];
  const redundantPrefixes = new Set<number>();

  for (const [index, candidate] of finalizedGroups.entries()) {
    const extensions = finalizedGroups.filter(
      (other, otherIndex) =>
        otherIndex !== index &&
        isStrictFinalizedPrefix(
          executionRepertoire,
          candidate.prefix,
          other.prefix,
        ),
    );
    if (extensions.length === 0) continue;

    // A shorter finalized sequence teaches no additional move when an
    // otherwise identical longer sequence is already present in this scope.
    // Keep only the maximal sequence(s), but preserve source lineage metadata.
    redundantPrefixes.add(index);
    for (const extension of extensions) {
      for (const lineageId of candidate.lineageIds) {
        extension.lineageIds.add(lineageId);
      }
    }
  }

  return finalizedGroups
    .filter((_, index) => !redundantPrefixes.has(index))
    .map<PracticeItem>(({ prefix, representative, lineageIds }) => {
      const endPosition = executionRepertoire.edges[prefix.at(-1) ?? '']?.to ?? rootPosition;
      const theoryEdgeIds = representative.edgeIds.length >= prefix.length
        ? representative.edgeIds
        : prefix;
      return {
        id: stableId('practice-item-v3', [
          repertoire.openingId,
          edgePathSignature(executionRepertoire, prefix),
        ]),
        openingId: repertoire.openingId,
        rootPosition,
        endPosition,
        trainingDepth: normalizedDepth,
        edgeIds: prefix,
        sans: prefix.flatMap((id) => executionRepertoire.edges[id]?.san ?? []),
        theoryEdgeIds,
        theoryLineageIds: [...lineageIds].sort((left, right) => left.localeCompare(right, 'en')),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

/** One Random Recall item per canonical position and stored repertoire move. */
export function createMovePracticeItems(
  repertoire: CanonicalRepertoire,
  rootPositions: readonly string[] = [repertoire.rootPosition],
  trainingDepth = Math.max(...rootPositions.map((root) => maximumPracticeDepth(repertoire, root))),
): MovePracticeItem[] {
  const normalizedDepth = Math.max(1, trainingDepth);
  const mutable = new Map<string, MovePracticeItem & { adjacent: Set<string> }>();
  const turn = repertoireTurn(repertoire);

  for (const rootPosition of new Set(rootPositions)) {
    for (const theoryLine of completeTheoryLines(repertoire, rootPosition)) {
      let decisions = 0;
      let previousItemId: string | null = null;
      for (const edgeId of theoryLine.edgeIds) {
        const edge = repertoire.edges[edgeId];
        if (!edge) break;
        if (repertoire.positions[edge.from]?.turn !== turn) continue;
        if (decisions >= normalizedDepth) break;
        decisions += 1;
        const fen = repertoire.positions[edge.from]?.fullFens[0] ?? edge.from;
        let coordinates: { from: string; to: string } | null = null;
        try {
          const move = new Chess(fen).move(edge.san, { strict: true });
          coordinates = { from: move.from, to: move.to };
        } catch {
          // Invalid canonical moves are rejected by the data validator; skip defensively.
        }
        if (!coordinates) continue;
        const id = stableId('move-practice-v1', [
          repertoire.openingId,
          edge.from,
          edge.san,
          edge.to,
        ]);
        const item = mutable.get(id) ?? {
          id,
          openingId: repertoire.openingId,
          position: edge.from,
          fen,
          edgeId: edge.id,
          san: edge.san,
          from: coordinates.from,
          to: coordinates.to,
          targetPosition: edge.to,
          adjacentItemIds: [],
          adjacent: new Set<string>(),
        };
        if (previousItemId) {
          item.adjacent.add(previousItemId);
          mutable.get(previousItemId)?.adjacent.add(id);
        }
        mutable.set(id, item);
        previousItemId = id;
      }
    }
  }

  return [...mutable.values()].map(({ adjacent, ...item }) => ({
    ...item,
    adjacentItemIds: [...adjacent].sort((left, right) => left.localeCompare(right, 'en')),
  })).sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

/** @deprecated Prefer createPracticeItems to make the depth semantics explicit. */
export function createPracticeLines(
  repertoire: CanonicalRepertoire,
  rootPosition = repertoire.rootPosition,
  trainingDepth = maximumPracticeDepth(repertoire, rootPosition),
): PracticeLine[] {
  return createPracticeItems(repertoire, rootPosition, trainingDepth);
}

export function chooseWeightedPracticeLine(
  lines: readonly PracticeLine[],
  progress: Readonly<PracticeLineProgressMap>,
  random: () => number = Math.random,
  previousLineId?: string | null,
): PracticeLine | null {
  return selectPracticeItem(
    lines,
    progress,
    { skipsSinceSeen: {} },
    random,
    previousLineId,
  ).item;
}

export function practiceSelectionWeight(
  remainingMasteryDebt: number,
  skipsSinceSeen: number,
): number {
  const baseWeight = Math.max(1, remainingMasteryDebt);
  const normalizedSkips = Number.isSafeInteger(skipsSinceSeen)
    ? Math.max(0, skipsSinceSeen)
    : 0;
  return baseWeight * (1 + PRACTICE_AGING_FACTOR * normalizedSkips);
}

export function selectPracticeItem<T extends { id: string }>(
  items: readonly T[],
  progress: Readonly<PracticeLineProgressMap>,
  scheduler: Readonly<PracticeSchedulerState>,
  random: () => number = Math.random,
  previousItemId?: string | null,
  temporarilyExcludedIds: ReadonlySet<string> = new Set(),
): { item: T | null; state: PracticeSchedulerState } {
  const active = items.filter(
    (item) => practiceLineProgress(progress, item.id).n > 0,
  );
  if (active.length === 0) return { item: null, state: { skipsSinceSeen: {} } };
  const withoutPrevious = active.length > 1 && previousItemId
    ? active.filter((item) => item.id !== previousItemId)
    : active;
  const withoutRelated = withoutPrevious.filter(
    (item) => !temporarilyExcludedIds.has(item.id),
  );
  const eligible = withoutRelated.length > 0 ? withoutRelated : withoutPrevious;
  const total = eligible.reduce(
    (sum, item) => sum + practiceSelectionWeight(
      practiceLineProgress(progress, item.id).n,
      scheduler.skipsSinceSeen[item.id] ?? 0,
    ),
    0,
  );
  const sample = Math.min(Math.max(random(), 0), 0.999999999999) * total;
  let cursor = 0;
  let selected = eligible.at(-1) ?? null;
  for (const item of eligible) {
    cursor += practiceSelectionWeight(
      practiceLineProgress(progress, item.id).n,
      scheduler.skipsSinceSeen[item.id] ?? 0,
    );
    if (sample < cursor) {
      selected = item;
      break;
    }
  }
  const skipsSinceSeen = Object.fromEntries(active.map((item) => [
    item.id,
    item.id === selected?.id ? 0 : (scheduler.skipsSinceSeen[item.id] ?? 0) + 1,
  ]));
  return { item: selected, state: { skipsSinceSeen } };
}

export const chooseWeightedPracticeItem = chooseWeightedPracticeLine;

/** Follow the only stored continuation, regardless of side, until a real branch. */
export function deterministicStartingPath(
  repertoire: CanonicalRepertoire,
  rootPosition = repertoire.rootPosition,
): CanonicalEdge[] {
  const index = createVariationIndex(repertoire);
  const path: CanonicalEdge[] = [];
  const visited = new Set<string>();
  let position = rootPosition;
  while (!visited.has(position)) {
    visited.add(position);
    const continuations = index.storedContinuationsByPosition[position] ?? [];
    if (continuations.length !== 1) break;
    const edge = repertoire.edges[continuations[0]!.edgeIds[0]!];
    if (!edge) break;
    path.push(edge);
    position = edge.to;
  }
  return path;
}

export type PracticeProgressEvent =
  | 'correct-repertoire-move'
  | 'shown-solution'
  | 'incorrect-move'
  | 'opponent-move'
  | 'hint';

export type PracticeCompletionReason =
  | 'target-depth-reached'
  | 'stored-line-ended'
  | 'no-valid-opponent-continuation'
  | 'unresolved-repertoire-decision'
  | 'user-ended-exercise';

interface PracticeGraphIndex {
  outgoing: Map<string, CanonicalEdge[]>;
}

const practiceGraphIndexes = new WeakMap<CanonicalRepertoire, PracticeGraphIndex>();

function practiceGraphIndex(repertoire: CanonicalRepertoire): PracticeGraphIndex {
  const cached = practiceGraphIndexes.get(repertoire);
  if (cached) return cached;
  const outgoing = new Map<string, CanonicalEdge[]>();
  for (const edge of Object.values(repertoire.edges)) {
    const edges = outgoing.get(edge.from) ?? [];
    edges.push(edge);
    outgoing.set(edge.from, edges);
  }
  for (const edges of outgoing.values()) {
    edges.sort((left, right) => left.id.localeCompare(right.id, 'en'));
  }
  const index = { outgoing };
  practiceGraphIndexes.set(repertoire, index);
  return index;
}

export function advancePracticeProgress(
  completed: number,
  event: PracticeProgressEvent,
): number {
  return event === 'correct-repertoire-move' || event === 'shown-solution'
    ? completed + 1
    : completed;
}

export function repertoireTurn(repertoire: CanonicalRepertoire): 'w' | 'b' {
  return repertoire.openingSide === 'white' ? 'w' : 'b';
}

export function activeRepertoireCandidate(
  repertoire: CanonicalRepertoire,
  position: string,
): RepertoireMoveCandidate | null {
  if (repertoire.openingSide === 'unresolved') return null;
  const positionNode = repertoire.positions[position];
  if (!positionNode || positionNode.turn !== repertoireTurn(repertoire)) {
    return null;
  }
  const decision = repertoire.repertoireDecisionNodes[position];
  if (!decision || decision.position !== position || !decision.selectedCandidateId) {
    return null;
  }
  const candidate = decision.candidates.find(
    (item) => item.id === decision.selectedCandidateId,
  );
  if (!candidate) return null;
  const edge = repertoire.edges[candidate.edgeId];
  const resultingPosition = repertoire.positions[candidate.resultingPosition];
  if (
    !edge ||
    !resultingPosition ||
    edge.from !== position ||
    edge.to !== candidate.resultingPosition ||
    edge.san !== candidate.san ||
    resultingPosition.turn === positionNode.turn
  ) {
    return null;
  }
  return candidate;
}

export function eligibleOpponentEdges(
  repertoire: CanonicalRepertoire,
  position: string,
): CanonicalEdge[] {
  const positionNode = repertoire.positions[position];
  if (
    repertoire.openingSide === 'unresolved' ||
    !positionNode ||
    positionNode.turn === repertoireTurn(repertoire)
  ) {
    return [];
  }
  return (practiceGraphIndex(repertoire).outgoing.get(position) ?? [])
    .filter(
      (edge) =>
        activeRepertoireCandidate(repertoire, edge.to) !== null,
    )
    .slice();
}

export function canContinuePracticeLine(
  repertoire: CanonicalRepertoire,
  position: string,
): boolean {
  const positionNode = repertoire.positions[position];
  if (!positionNode || repertoire.openingSide === 'unresolved') return false;
  return positionNode.turn === repertoireTurn(repertoire)
    ? activeRepertoireCandidate(repertoire, position) !== null
    : eligibleOpponentEdges(repertoire, position).length > 0;
}

export function canStartPracticeExercise(
  repertoire: CanonicalRepertoire,
  rootPosition: string,
): boolean {
  return canContinuePracticeLine(repertoire, rootPosition);
}

export function classifyPracticeCompletion(
  repertoire: CanonicalRepertoire,
  position: string,
  targetDepthReached: boolean,
  userEnded = false,
): PracticeCompletionReason | null {
  if (userEnded) return 'user-ended-exercise';
  const positionNode = repertoire.positions[position];
  if (!positionNode) return 'stored-line-ended';

  if (positionNode.turn === repertoireTurn(repertoire)) {
    if (activeRepertoireCandidate(repertoire, position)) {
      return targetDepthReached ? 'target-depth-reached' : null;
    }
    const decision = repertoire.repertoireDecisionNodes[position];
    return decision && decision.candidates.length > 0
      ? 'unresolved-repertoire-decision'
      : 'stored-line-ended';
  }

  if (eligibleOpponentEdges(repertoire, position).length > 0) {
    return targetDepthReached ? 'target-depth-reached' : null;
  }
  const hasStoredOpponentEdge =
    (practiceGraphIndex(repertoire).outgoing.get(position)?.length ?? 0) > 0;
  return hasStoredOpponentEdge
    ? 'no-valid-opponent-continuation'
    : 'stored-line-ended';
}

function nextRandom(seed: number): number {
  let state = seed || 0x5eed1234;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

export function chooseOpponentEdge(
  repertoire: CanonicalRepertoire,
  position: string,
  state: PracticeShuffleState,
): { edge: CanonicalEdge | null; state: PracticeShuffleState } {
  const eligible = eligibleOpponentEdges(repertoire, position);
  if (eligible.length === 0) return { edge: null, state };
  const eligibleIds = new Set(eligible.map((edge) => edge.id));
  let bag = [
    ...new Set(
      (state.bags[position] ?? []).filter((id) => eligibleIds.has(id)),
    ),
  ];
  let seed = state.seed;
  if (bag.length === 0) {
    bag = eligible.map((edge) => edge.id);
    for (let index = bag.length - 1; index > 0; index -= 1) {
      seed = nextRandom(seed);
      const swapIndex = seed % (index + 1);
      [bag[index], bag[swapIndex]] = [bag[swapIndex]!, bag[index]!];
    }
    const lastChoice = state.lastChoices?.[position];
    if (bag.length > 1 && bag.at(-1) === lastChoice) {
      const alternativeIndex = bag.findIndex((id) => id !== lastChoice);
      [bag[alternativeIndex], bag[bag.length - 1]] = [
        bag[bag.length - 1]!,
        bag[alternativeIndex]!,
      ];
    }
  }
  const edgeId = bag.at(-1);
  const edge = eligible.find((candidate) => candidate.id === edgeId) ?? null;
  return {
    edge,
    state: {
      ...state,
      seed,
      bags: { ...state.bags, [position]: bag.slice(0, -1) },
      ...(edge
        ? {
            lastChoices: {
              ...state.lastChoices,
              [position]: edge.id,
            },
          }
        : {}),
    },
  };
}

export function maximumPracticeDepth(
  repertoire: CanonicalRepertoire,
  rootPosition: string,
): number {
  const turn = repertoireTurn(repertoire);
  const memo = new Map<string, number>();
  const visit = (position: string, visiting: Set<string>): number => {
    if (memo.has(position)) return memo.get(position) ?? 0;
    if (visiting.has(position)) return 0;
    const nextVisiting = new Set(visiting).add(position);
    const node = repertoire.positions[position];
    if (!node) return 0;
    let result = 0;
    if (node.turn === turn) {
      const candidate = activeRepertoireCandidate(repertoire, position);
      result = candidate ? 1 + visit(candidate.resultingPosition, nextVisiting) : 0;
    } else {
      result = Math.max(
        0,
        ...eligibleOpponentEdges(repertoire, position).map((edge) =>
          visit(edge.to, nextVisiting),
        ),
      );
    }
    memo.set(position, result);
    return result;
  };
  return visit(rootPosition, new Set());
}
