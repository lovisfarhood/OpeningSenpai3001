import {
  activeRepertoireCandidate,
  repertoireTurn,
} from './practice.js';
import type {
  CanonicalEdge,
  CanonicalRepertoire,
  MoveOrigin,
  SourceType,
} from './repertoire.js';

export interface VariationLineage {
  /** Study URL first; legacy sources fall back to course/folder identity. */
  id: string;
  course: string;
  courseFolder: string;
  courseUrl?: string;
  chapter: string;
  study: string;
  studyFolder: string;
  chapterUrl?: string;
  studyUrl?: string;
  variationId: string;
  sourceTypes: readonly SourceType[];
  edgeIds: readonly string[];
}

export interface StoredContinuation {
  /** Stable source/SAN/target tuple, independent of record ordering. */
  id: string;
  san: string;
  sourcePosition: string;
  targetPosition: string;
  edgeIds: readonly string[];
  /** Lineages stored directly on this move. */
  directLineageIds: readonly string[];
  /** Unique lineages reachable through this move, including this move. */
  pathCount: number;
  /** Unique immediate stored branches at the resulting position. */
  downstreamBranchCount: number;
}

export interface StoredContinuationSummary {
  continuations: readonly StoredContinuation[];
  /** Unique source/SAN/target continuations at this position. */
  branchCount: number;
  /** Unique course/study/variationId lineages below this position. */
  pathCount: number;
}

export interface VariationIndex {
  readonly repertoire: CanonicalRepertoire;
  readonly outgoingEdgesByPosition: Readonly<
    Record<string, readonly CanonicalEdge[]>
  >;
  readonly storedContinuationsByPosition: Readonly<
    Record<string, readonly StoredContinuation[]>
  >;
  readonly practiceBranchesByPosition: Readonly<
    Record<string, readonly StoredContinuation[]>
  >;
  readonly remainingLineagesByPosition: Readonly<
    Record<string, readonly VariationLineage[]>
  >;
  readonly maximumTrainingDepthByPosition: Readonly<Record<string, number>>;
  readonly lineagesById: Readonly<Record<string, VariationLineage>>;
}

interface MutableLineage {
  id: string;
  course: string;
  courseFolder: string;
  courseUrl?: string;
  chapter: string;
  study: string;
  studyFolder: string;
  chapterUrl?: string;
  studyUrl?: string;
  variationId: string;
  sourceTypes: Set<SourceType>;
  edgeIds: Set<string>;
}

interface BaseContinuation {
  id: string;
  san: string;
  sourcePosition: string;
  targetPosition: string;
  edgeIds: string[];
  directLineageIds: string[];
}

interface ComponentGraph {
  componentByNode: Readonly<Record<string, number>>;
  nodesByComponent: readonly (readonly string[])[];
  outgoingComponents: readonly (readonly number[])[];
  topologicalOrder: readonly number[];
}

const SOURCE_ORDER: readonly SourceType[] = ['main', 'bonus', 'user'];

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en');
}

function lineageId(origin: MoveOrigin): string {
  return origin.studyUrl
    ? JSON.stringify(['study-url', origin.studyUrl, origin.variationId])
    : JSON.stringify([
        'folder-fallback',
        origin.courseUrl ?? null,
        origin.courseFolder,
        origin.studyFolder,
        origin.variationId,
      ]);
}

function continuationId(from: string, san: string, to: string): string {
  return JSON.stringify([from, san, to]);
}

function compareEdges(left: CanonicalEdge, right: CanonicalEdge): number {
  return (
    compareText(left.san, right.san) ||
    compareText(left.to, right.to) ||
    compareText(left.id, right.id)
  );
}

function compareLineages(
  left: VariationLineage,
  right: VariationLineage,
): number {
  return (
    compareText(left.course, right.course) ||
    compareText(left.study, right.study) ||
    compareText(left.variationId, right.variationId) ||
    compareText(left.id, right.id)
  );
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function normalizeAdjacency(
  nodes: readonly string[],
  adjacency: Readonly<Record<string, readonly string[]>>,
): Record<string, readonly string[]> {
  const nodeIds = new Set(nodes);
  return Object.fromEntries(
    nodes.map((node) => [
      node,
      uniqueSorted(
        (adjacency[node] ?? []).filter((target) => nodeIds.has(target)),
      ),
    ]),
  );
}

/**
 * Builds strongly connected components and their condensation DAG.
 * Condensing cycles makes reachability and maximum-depth queries finite and
 * deterministic even when normalized chess positions repeat.
 */
function buildComponentGraph(
  nodes: readonly string[],
  rawAdjacency: Readonly<Record<string, readonly string[]>>,
): ComponentGraph {
  const adjacency = normalizeAdjacency(nodes, rawAdjacency);
  const reverse: Record<string, string[]> = Object.fromEntries(
    nodes.map((node) => [node, []]),
  );
  for (const node of nodes) {
    for (const target of adjacency[node] ?? []) {
      reverse[target]?.push(node);
    }
  }
  for (const values of Object.values(reverse)) values.sort(compareText);

  const visited = new Set<string>();
  const finishOrder: string[] = [];
  for (const start of nodes) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack: Array<{ node: string; nextIndex: number }> = [
      { node: start, nextIndex: 0 },
    ];
    while (stack.length > 0) {
      const frame = stack.at(-1);
      if (!frame) break;
      const targets = adjacency[frame.node] ?? [];
      const target = targets[frame.nextIndex];
      if (target !== undefined) {
        frame.nextIndex += 1;
        if (!visited.has(target)) {
          visited.add(target);
          stack.push({ node: target, nextIndex: 0 });
        }
      } else {
        finishOrder.push(frame.node);
        stack.pop();
      }
    }
  }

  const componentByNode: Record<string, number> = {};
  const nodesByComponent: string[][] = [];
  for (let index = finishOrder.length - 1; index >= 0; index -= 1) {
    const start = finishOrder[index];
    if (start === undefined || componentByNode[start] !== undefined) continue;
    const component = nodesByComponent.length;
    const componentNodes: string[] = [];
    const stack = [start];
    componentByNode[start] = component;
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) continue;
      componentNodes.push(node);
      for (const source of reverse[node] ?? []) {
        if (componentByNode[source] === undefined) {
          componentByNode[source] = component;
          stack.push(source);
        }
      }
    }
    componentNodes.sort(compareText);
    nodesByComponent.push(componentNodes);
  }

  const outgoingSets = nodesByComponent.map(() => new Set<number>());
  for (const node of nodes) {
    const sourceComponent = componentByNode[node];
    if (sourceComponent === undefined) continue;
    for (const target of adjacency[node] ?? []) {
      const targetComponent = componentByNode[target];
      if (
        targetComponent !== undefined &&
        targetComponent !== sourceComponent
      ) {
        outgoingSets[sourceComponent]?.add(targetComponent);
      }
    }
  }
  const outgoingComponents = outgoingSets.map((set) =>
    [...set].sort((left, right) => left - right),
  );
  const indegrees = outgoingComponents.map(() => 0);
  for (const targets of outgoingComponents) {
    for (const target of targets) {
      indegrees[target] = (indegrees[target] ?? 0) + 1;
    }
  }
  const available = indegrees
    .map((degree, component) => ({ degree, component }))
    .filter(({ degree }) => degree === 0)
    .map(({ component }) => component)
    .sort((left, right) => right - left);
  const topologicalOrder: number[] = [];
  while (available.length > 0) {
    const component = available.pop();
    if (component === undefined) continue;
    topologicalOrder.push(component);
    for (const target of outgoingComponents[component] ?? []) {
      indegrees[target] = (indegrees[target] ?? 0) - 1;
      if (indegrees[target] === 0) {
        available.push(target);
        available.sort((left, right) => right - left);
      }
    }
  }

  return {
    componentByNode,
    nodesByComponent,
    outgoingComponents,
    topologicalOrder,
  };
}

function reachableLineages(
  nodes: readonly string[],
  componentGraph: ComponentGraph,
  outgoingEdges: Readonly<Record<string, readonly CanonicalEdge[]>>,
  lineageIdsByEdge: Readonly<Record<string, readonly string[]>>,
  lineagesById: Readonly<Record<string, VariationLineage>>,
): Record<string, readonly VariationLineage[]> {
  const idsByComponent = componentGraph.nodesByComponent.map(
    () => new Set<string>(),
  );
  for (const node of nodes) {
    const component = componentGraph.componentByNode[node];
    if (component === undefined) continue;
    for (const edge of outgoingEdges[node] ?? []) {
      for (const id of lineageIdsByEdge[edge.id] ?? []) {
        idsByComponent[component]?.add(id);
      }
    }
  }
  for (
    let index = componentGraph.topologicalOrder.length - 1;
    index >= 0;
    index -= 1
  ) {
    const component = componentGraph.topologicalOrder[index];
    if (component === undefined) continue;
    const ids = idsByComponent[component];
    if (!ids) continue;
    for (const target of componentGraph.outgoingComponents[component] ?? []) {
      for (const id of idsByComponent[target] ?? []) ids.add(id);
    }
  }

  return Object.fromEntries(
    nodes.map((node) => {
      const component = componentGraph.componentByNode[node];
      const ids = component === undefined ? [] : [...(idsByComponent[component] ?? [])];
      const lineages = ids
        .map((id) => lineagesById[id])
        .filter((lineage): lineage is VariationLineage => lineage !== undefined)
        .sort(compareLineages);
      return [node, lineages];
    }),
  );
}

function maximumDepths(
  repertoire: CanonicalRepertoire,
  nodes: readonly string[],
  practiceAdjacency: Readonly<Record<string, readonly string[]>>,
): Record<string, number> {
  if (repertoire.openingSide === 'unresolved') {
    return Object.fromEntries(nodes.map((node) => [node, 0]));
  }
  const components = buildComponentGraph(nodes, practiceAdjacency);
  const turn = repertoireTurn(repertoire);
  const componentWeights = components.nodesByComponent.map((componentNodes) =>
    componentNodes.reduce((total, position) => {
      const node = repertoire.positions[position];
      return total +
        (node?.turn === turn &&
        activeRepertoireCandidate(repertoire, position) !== null
          ? 1
          : 0);
    }, 0),
  );
  const depthByComponent = componentWeights.map(() => 0);
  for (
    let index = components.topologicalOrder.length - 1;
    index >= 0;
    index -= 1
  ) {
    const component = components.topologicalOrder[index];
    if (component === undefined) continue;
    const childDepth = Math.max(
      0,
      ...(components.outgoingComponents[component] ?? []).map(
        (target) => depthByComponent[target] ?? 0,
      ),
    );
    depthByComponent[component] =
      (componentWeights[component] ?? 0) + childDepth;
  }
  return Object.fromEntries(
    nodes.map((node) => [
      node,
      depthByComponent[components.componentByNode[node] ?? -1] ?? 0,
    ]),
  );
}

/** Build once per CanonicalRepertoire identity (for example with useMemo). */
export function createVariationIndex(
  repertoire: CanonicalRepertoire,
): VariationIndex {
  const nodes = Object.keys(repertoire.positions).sort(compareText);
  const nodeIds = new Set(nodes);
  const validEdges = Object.values(repertoire.edges)
    .filter(
      (edge) =>
        nodeIds.has(edge.from) &&
        nodeIds.has(edge.to) &&
        typeof edge.san === 'string' &&
        edge.san.length > 0,
    )
    .sort((left, right) =>
      compareText(left.from, right.from) || compareEdges(left, right),
    );
  const outgoingEdgesByPosition: Record<string, CanonicalEdge[]> =
    Object.fromEntries(nodes.map((node) => [node, []]));
  for (const edge of validEdges) {
    outgoingEdgesByPosition[edge.from]?.push(edge);
  }
  for (const edges of Object.values(outgoingEdgesByPosition)) {
    edges.sort(compareEdges);
  }

  const mutableLineages = new Map<string, MutableLineage>();
  const lineageIdsByEdge: Record<string, string[]> = {};
  for (const edge of validEdges) {
    const ids = new Set<string>();
    const origins = [...edge.sources].sort(
      (left, right) =>
        compareText(lineageId(left), lineageId(right)) ||
        left.variationIndex - right.variationIndex,
    );
    for (const origin of origins) {
      const id = lineageId(origin);
      ids.add(id);
      const existing = mutableLineages.get(id);
      if (existing) {
        existing.sourceTypes.add(origin.sourceType);
        existing.edgeIds.add(edge.id);
      } else {
        mutableLineages.set(id, {
          id,
          course: origin.course,
          courseFolder: origin.courseFolder,
          ...(origin.courseUrl === undefined
            ? {}
            : { courseUrl: origin.courseUrl }),
          chapter: origin.chapter,
          study: origin.study,
          studyFolder: origin.studyFolder,
          ...(origin.chapterUrl === undefined
            ? {}
            : { chapterUrl: origin.chapterUrl }),
          ...(origin.studyUrl === undefined
            ? {}
            : { studyUrl: origin.studyUrl }),
          variationId: origin.variationId,
          sourceTypes: new Set([origin.sourceType]),
          edgeIds: new Set([edge.id]),
        });
      }
    }
    lineageIdsByEdge[edge.id] = uniqueSorted(ids);
  }
  const lineages = [...mutableLineages.values()]
    .map<VariationLineage>((lineage) => ({
      id: lineage.id,
      course: lineage.course,
      courseFolder: lineage.courseFolder,
      ...(lineage.courseUrl === undefined
        ? {}
        : { courseUrl: lineage.courseUrl }),
      chapter: lineage.chapter,
      study: lineage.study,
      studyFolder: lineage.studyFolder,
      ...(lineage.chapterUrl === undefined
        ? {}
        : { chapterUrl: lineage.chapterUrl }),
      ...(lineage.studyUrl === undefined
        ? {}
        : { studyUrl: lineage.studyUrl }),
      variationId: lineage.variationId,
      sourceTypes: SOURCE_ORDER.filter((type) =>
        lineage.sourceTypes.has(type),
      ),
      edgeIds: uniqueSorted(lineage.edgeIds),
    }))
    .sort(compareLineages);
  const lineagesById: Record<string, VariationLineage> = Object.fromEntries(
    lineages.map((lineage) => [lineage.id, lineage]),
  );

  const storedAdjacency: Record<string, readonly string[]> = Object.fromEntries(
    nodes.map((node) => [
      node,
      uniqueSorted(
        (outgoingEdgesByPosition[node] ?? []).map((edge) => edge.to),
      ),
    ]),
  );
  const storedComponents = buildComponentGraph(nodes, storedAdjacency);
  const remainingLineagesByPosition = reachableLineages(
    nodes,
    storedComponents,
    outgoingEdgesByPosition,
    lineageIdsByEdge,
    lineagesById,
  );

  const baseContinuationsByPosition: Record<string, BaseContinuation[]> = {};
  for (const node of nodes) {
    const groups = new Map<string, BaseContinuation>();
    for (const edge of outgoingEdgesByPosition[node] ?? []) {
      const id = continuationId(edge.from, edge.san, edge.to);
      const existing = groups.get(id);
      if (existing) {
        existing.edgeIds.push(edge.id);
        existing.directLineageIds.push(...(lineageIdsByEdge[edge.id] ?? []));
      } else {
        groups.set(id, {
          id,
          san: edge.san,
          sourcePosition: edge.from,
          targetPosition: edge.to,
          edgeIds: [edge.id],
          directLineageIds: [...(lineageIdsByEdge[edge.id] ?? [])],
        });
      }
    }
    baseContinuationsByPosition[node] = [...groups.values()].sort(
      (left, right) =>
        compareText(left.san, right.san) ||
        compareText(left.targetPosition, right.targetPosition) ||
        compareText(left.id, right.id),
    );
  }

  const storedContinuationsByPosition: Record<
    string,
    readonly StoredContinuation[]
  > = Object.fromEntries(
    nodes.map((node) => [
      node,
      (baseContinuationsByPosition[node] ?? []).map((continuation) => {
        const pathIds = new Set(continuation.directLineageIds);
        for (const lineage of
          remainingLineagesByPosition[continuation.targetPosition] ?? []) {
          pathIds.add(lineage.id);
        }
        return {
          ...continuation,
          edgeIds: uniqueSorted(continuation.edgeIds),
          directLineageIds: uniqueSorted(continuation.directLineageIds),
          pathCount: pathIds.size,
          downstreamBranchCount:
            baseContinuationsByPosition[continuation.targetPosition]?.length ??
            0,
        };
      }),
    ]),
  );

  const practiceBranchesByPosition: Record<
    string,
    readonly StoredContinuation[]
  > = {};
  const practiceAdjacency: Record<string, readonly string[]> = {};
  const turn = repertoireTurn(repertoire);
  for (const node of nodes) {
    const position = repertoire.positions[node];
    if (!position || repertoire.openingSide === 'unresolved') {
      practiceBranchesByPosition[node] = [];
      practiceAdjacency[node] = [];
      continue;
    }
    if (position.turn === turn) {
      practiceBranchesByPosition[node] = [];
      const candidate = activeRepertoireCandidate(repertoire, node);
      practiceAdjacency[node] = candidate ? [candidate.resultingPosition] : [];
      continue;
    }
    const eligibleIds = new Set(
      (outgoingEdgesByPosition[node] ?? [])
        .filter(
          (edge) =>
            activeRepertoireCandidate(repertoire, edge.to) !== null,
        )
        .map((edge) => edge.id),
    );
    const branches = (storedContinuationsByPosition[node] ?? []).filter(
      (continuation) =>
        continuation.edgeIds.some((edgeId) => eligibleIds.has(edgeId)),
    );
    practiceBranchesByPosition[node] = branches;
    practiceAdjacency[node] = uniqueSorted(
      branches.map((branch) => branch.targetPosition),
    );
  }

  return {
    repertoire,
    outgoingEdgesByPosition,
    storedContinuationsByPosition,
    practiceBranchesByPosition,
    remainingLineagesByPosition,
    maximumTrainingDepthByPosition: maximumDepths(
      repertoire,
      nodes,
      practiceAdjacency,
    ),
    lineagesById,
  };
}

export const buildVariationIndex = createVariationIndex;

export function storedContinuations(
  index: VariationIndex,
  position: string,
): readonly StoredContinuation[] {
  return index.storedContinuationsByPosition[position] ?? [];
}

export function storedContinuationSummary(
  index: VariationIndex,
  position: string,
): StoredContinuationSummary {
  const continuations = storedContinuations(index, position);
  return {
    continuations,
    branchCount: continuations.length,
    pathCount: remainingLines(index, position).length,
  };
}

/** Opponent choices that satisfy the same rules as eligibleOpponentEdges. */
export function practiceBranches(
  index: VariationIndex,
  position: string,
): readonly StoredContinuation[] {
  return index.practiceBranchesByPosition[position] ?? [];
}

export function remainingLines(
  index: VariationIndex,
  position: string,
): readonly VariationLineage[] {
  return index.remainingLineagesByPosition[position] ?? [];
}

export function remainingLineCount(
  index: VariationIndex,
  position: string,
): number {
  return remainingLines(index, position).length;
}

export function isEndOfLine(
  index: VariationIndex,
  position: string,
): boolean {
  return storedContinuations(index, position).length === 0;
}

export function isPracticeEndOfLine(
  index: VariationIndex,
  position: string,
): boolean {
  const node = index.repertoire.positions[position];
  if (!node || index.repertoire.openingSide === 'unresolved') return true;
  if (node.turn === repertoireTurn(index.repertoire)) {
    return activeRepertoireCandidate(index.repertoire, position) === null;
  }
  return practiceBranches(index, position).length === 0;
}

/**
 * Counts repertoire decisions in the longest eligible continuation. Repeated
 * positions are condensed into one component, so cycles count each distinct
 * decision position once instead of producing an infinite depth.
 */
export function maximumTrainingDepth(
  index: VariationIndex,
  position: string,
): number {
  return index.maximumTrainingDepthByPosition[position] ?? 0;
}
