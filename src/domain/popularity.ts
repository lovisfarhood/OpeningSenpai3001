import type {
  CanonicalEdge,
  CanonicalRepertoire,
} from './repertoire.js';

export const POPULARITY_FORMAT_VERSION = 2 as const;

export interface ImportanceOrderEntry {
  rank: number;
  position: string;
  /** Maximum probability of reaching this position while playing the repertoire. */
  repertoireConditionedReach: number;
  /** Incoming edge factor: 1 for our move, conditional probability for the opponent. */
  moveProbabilityFactor: number;
  parentReach: number;
  moveGames: number;
  parentGames: number;
  repertoireMove: boolean;
  parentPositions: readonly string[];
  triggeringEdgeIds: readonly string[];
  sources: readonly string[];
}

export interface PopularityPack {
  formatVersion: typeof POPULARITY_FORMAT_VERSION;
  openingId: string;
  source: 'lichess-opening-explorer';
  retrievedAt: string;
  filters: {
    variant: 'standard';
    speeds: 'all';
    ratings: 'all';
    since: '1952-01';
    until: '3000-12';
  };
  coverage: {
    repertoireParentPositions: number;
    cachedParentPositions: number;
    inferredZeroParentPositions: number;
    missingParentPositions: number;
    failedRequests: number;
  };
  edgeGames: Readonly<Record<string, number>>;
  positionGames: Readonly<Record<string, number>>;
  defaultRootPositions: readonly string[];
  importanceOrder: readonly ImportanceOrderEntry[];
}

export interface ImportanceScopeSummary {
  positions: number;
  branches: number;
  deepestBranchPlies: number;
  lowestRepertoireReach: number;
  maximumPositions: number;
}

export interface ImportanceScope {
  repertoire: CanonicalRepertoire;
  order: readonly ImportanceOrderEntry[];
  selectedPositions: ReadonlySet<string>;
  selectedEdgeIds: ReadonlySet<string>;
  summary: ImportanceScopeSummary;
}

/** Discrete user-selectable budgets, with the exact reachable maximum retained. */
export function importanceBudgetOptions(reachableMax: number): number[] {
  const maximum = Number.isFinite(reachableMax)
    ? Math.max(0, Math.floor(reachableMax))
    : 0;
  if (maximum === 0) return [];
  const step = maximum > 100 ? 50 : 10;
  const options: number[] = [];
  for (let value = step; value <= maximum; value += step) options.push(value);
  if (options.at(-1) !== maximum) options.push(maximum);
  return options;
}

/** Normalizes legacy or scope-relative values to the nearest valid budget. */
export function normalizeImportanceBudget(
  value: number,
  reachableMax: number,
): number {
  const options = importanceBudgetOptions(reachableMax);
  if (options.length === 0) return 0;
  const requested = Number.isFinite(value) ? value : options[0]!;
  return options.reduce((nearest, candidate) => {
    const candidateDistance = Math.abs(candidate - requested);
    const nearestDistance = Math.abs(nearest - requested);
    return candidateDistance < nearestDistance ? candidate : nearest;
  });
}

interface FrontierCandidate {
  edge: CanonicalEdge;
  repertoireConditionedReach: number;
  moveProbabilityFactor: number;
  parentReach: number;
  moveGames: number;
  parentGames: number;
  repertoireMove: boolean;
}

function finiteGames(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value ?? 0 : 0;
}

/**
 * Public builds store Lichess position counts under opaque deterministic keys
 * so the hosted shell does not reveal repertoire FENs before a user imports
 * their own course data.
 */
export function publicPositionKey(position: string): string {
  const hash = (seed: number): number => {
    let value = seed >>> 0;
    for (let index = 0; index < position.length; index += 1) {
      value ^= position.charCodeAt(index);
      value = Math.imul(value, 0x01000193);
    }
    return value >>> 0;
  };
  const first = hash(0x811c9dc5).toString(16).padStart(8, '0');
  const second = hash(0x9e3779b9).toString(16).padStart(8, '0');
  return `position_${first}${second}`;
}

function compareCandidates(
  left: FrontierCandidate,
  right: FrontierCandidate,
): number {
  return (
    right.repertoireConditionedReach - left.repertoireConditionedReach ||
    right.moveProbabilityFactor - left.moveProbabilityFactor ||
    right.parentReach - left.parentReach ||
    right.parentGames - left.parentGames ||
    right.moveGames - left.moveGames ||
    left.edge.to.localeCompare(right.edge.to, 'en') ||
    left.edge.san.localeCompare(right.edge.san, 'en') ||
    left.edge.id.localeCompare(right.edge.id, 'en')
  );
}

function repertoireTurn(repertoire: CanonicalRepertoire): 'w' | 'b' {
  return repertoire.openingSide === 'black' ? 'b' : 'w';
}

function candidateForEdge(
  repertoire: CanonicalRepertoire,
  edge: CanonicalEdge,
  parentReach: number,
  edgeGames: Readonly<Record<string, number>>,
  positionGames: Readonly<Record<string, number>>,
): FrontierCandidate {
  const moveGames = finiteGames(edgeGames[edge.id]);
  const parentGames = finiteGames(
    positionGames[edge.from] ?? positionGames[publicPositionKey(edge.from)],
  );
  const repertoireMove = repertoire.positions[edge.from]?.turn === repertoireTurn(repertoire);
  const moveProbabilityFactor = repertoireMove
    ? 1
    : parentGames > 0
      ? Math.min(1, moveGames / parentGames)
      : 0;
  return {
    edge,
    repertoireConditionedReach: parentReach * moveProbabilityFactor,
    moveProbabilityFactor,
    parentReach,
    moveGames,
    parentGames,
    repertoireMove,
  };
}

function outgoingEdges(
  repertoire: CanonicalRepertoire,
): ReadonlyMap<string, readonly CanonicalEdge[]> {
  const result = new Map<string, CanonicalEdge[]>();
  for (const edge of Object.values(repertoire.edges)) {
    if (
      repertoire.positions[edge.from]?.reachableFromRoot !== true ||
      repertoire.positions[edge.to]?.reachableFromRoot !== true
    ) {
      continue;
    }
    const values = result.get(edge.from) ?? [];
    values.push(edge);
    result.set(edge.from, values);
  }
  for (const values of result.values()) {
    values.sort((left, right) => left.id.localeCompare(right.id, 'en'));
  }
  return result;
}

function entrySources(
  repertoire: CanonicalRepertoire,
  edgeIds: readonly string[],
): string[] {
  return [...new Set(edgeIds.flatMap((edgeId) =>
    (repertoire.edges[edgeId]?.sources ?? []).map((source) => source.courseFolder),
  ))].sort((left, right) => left.localeCompare(right, 'en'));
}

/**
 * Creates the deterministic best-first expansion sequence. Roots are already
 * present context and therefore never consume an Importance position slot.
 */
export function buildImportanceOrder(
  repertoire: CanonicalRepertoire,
  rootPositions: readonly string[],
  edgeGames: Readonly<Record<string, number>>,
  positionGames: Readonly<Record<string, number>> = {},
): ImportanceOrderEntry[] {
  const roots = [...new Set(rootPositions)].filter(
    (position) => repertoire.positions[position]?.reachableFromRoot === true,
  );
  const selected = new Set(roots);
  const expanded = new Set<string>();
  const outgoing = outgoingEdges(repertoire);
  const inbound = new Map<string, CanonicalEdge[]>();
  for (const edge of Object.values(repertoire.edges)) {
    const values = inbound.get(edge.to) ?? [];
    values.push(edge);
    inbound.set(edge.to, values);
  }
  const frontier: FrontierCandidate[] = [];
  const order: ImportanceOrderEntry[] = [];
  const reachByPosition = new Map<string, number>(
    roots.map((root) => [root, 1] as const),
  );

  const expand = (position: string) => {
    if (expanded.has(position)) return;
    expanded.add(position);
    const parentReach = reachByPosition.get(position) ?? 0;
    for (const edge of outgoing.get(position) ?? []) {
      frontier.push(candidateForEdge(
        repertoire,
        edge,
        parentReach,
        edgeGames,
        positionGames,
      ));
    }
  };
  roots.forEach(expand);

  while (frontier.length > 0) {
    frontier.sort(compareCandidates);
    const candidate = frontier.shift();
    if (!candidate) break;
    const position = candidate.edge.to;
    if (selected.has(position)) continue;
    selected.add(position);
    reachByPosition.set(position, candidate.repertoireConditionedReach);

    const inboundEligible = (inbound.get(position) ?? [])
      .filter((edge) => edge.to === position && selected.has(edge.from))
      .sort((left, right) => left.id.localeCompare(right.id, 'en'));
    const triggeringEdgeIds = inboundEligible.length > 0
      ? inboundEligible.map((edge) => edge.id)
      : [candidate.edge.id];
    order.push({
      rank: order.length + 1,
      position,
      repertoireConditionedReach: candidate.repertoireConditionedReach,
      moveProbabilityFactor: candidate.moveProbabilityFactor,
      parentReach: candidate.parentReach,
      moveGames: candidate.moveGames,
      parentGames: candidate.parentGames,
      repertoireMove: candidate.repertoireMove,
      parentPositions: [...new Set(inboundEligible.map((edge) => edge.from))]
        .sort((left, right) => left.localeCompare(right, 'en')),
      triggeringEdgeIds,
      sources: entrySources(repertoire, triggeringEdgeIds),
    });
    expand(position);
  }

  return order;
}

function scopedRepertoire(
  repertoire: CanonicalRepertoire,
  rootPositions: readonly string[],
  selectedPositions: ReadonlySet<string>,
): { repertoire: CanonicalRepertoire; selectedEdgeIds: Set<string> } {
  const includedPositions = new Set([...rootPositions, ...selectedPositions]);
  const selectedEdges = Object.values(repertoire.edges).filter(
    (edge) => includedPositions.has(edge.from) && includedPositions.has(edge.to),
  );
  const selectedEdgeIds = new Set(selectedEdges.map((edge) => edge.id));
  const positions = Object.fromEntries(
    [...includedPositions].flatMap((position) => {
      const node = repertoire.positions[position];
      return node ? [[position, node] as const] : [];
    }),
  );
  const edges = Object.fromEntries(selectedEdges.map((edge) => [edge.id, edge]));
  const repertoireDecisionNodes = Object.fromEntries(
    Object.entries(repertoire.repertoireDecisionNodes).flatMap(([position, decision]) => {
      if (!includedPositions.has(position)) return [];
      const candidates = decision.candidates.filter((candidate) =>
        selectedEdgeIds.has(candidate.edgeId),
      );
      if (candidates.length === 0) return [];
      const selectedCandidateId = candidates.some(
        (candidate) => candidate.id === decision.selectedCandidateId,
      )
        ? decision.selectedCandidateId
        : null;
      return [[position, { ...decision, candidates, selectedCandidateId }] as const];
    }),
  );
  const whiteTurnNodes = Object.fromEntries(
    Object.entries(repertoire.whiteTurnNodes).flatMap(([position, node]) => {
      if (!includedPositions.has(position)) return [];
      const moves = node.moves.filter((move) => selectedEdgeIds.has(move.whiteEdgeId));
      return moves.length > 0 ? [[position, { ...node, moves }] as const] : [];
    }),
  );

  return {
    selectedEdgeIds,
    repertoire: {
      ...repertoire,
      positions,
      edges,
      repertoireDecisionNodes,
      whiteTurnNodes,
      topology: {
        terminalPositions: [...includedPositions].filter(
          (position) => !selectedEdges.some((edge) => edge.from === position),
        ),
        transpositionPositions: repertoire.topology.transpositionPositions.filter(
          (position) => includedPositions.has(position),
        ),
      },
      summary: {
        ...repertoire.summary,
        positions: includedPositions.size,
        reachablePositions: includedPositions.size,
        canonicalEdges: selectedEdges.length,
      },
    },
  };
}

function deepestBranchPlies(
  edges: readonly CanonicalEdge[],
  roots: readonly string[],
): number {
  const outgoing = new Map<string, CanonicalEdge[]>();
  for (const edge of edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  }
  const visit = (position: string, visiting: ReadonlySet<string>): number => {
    if (visiting.has(position)) return 0;
    const nextVisiting = new Set(visiting).add(position);
    return Math.max(
      0,
      ...(outgoing.get(position) ?? []).map(
        (edge) => 1 + visit(edge.to, nextVisiting),
      ),
    );
  };
  return Math.max(0, ...roots.map((root) => visit(root, new Set())));
}

export function createImportanceScope(
  repertoire: CanonicalRepertoire,
  rootPositions: readonly string[],
  requestedPositions: number,
  popularity: Pick<PopularityPack, 'edgeGames' | 'positionGames' | 'importanceOrder' | 'defaultRootPositions'>,
): ImportanceScope {
  const roots = [...new Set(rootPositions)];
  const defaultRoots = [...popularity.defaultRootPositions];
  const usePrecomputed = roots.length === defaultRoots.length &&
    roots.every((root, index) => root === defaultRoots[index]);
  const order = usePrecomputed
    ? [...popularity.importanceOrder]
    : buildImportanceOrder(
        repertoire,
        roots,
        popularity.edgeGames,
        popularity.positionGames,
      );
  const budget = Math.min(
    Math.max(0, Math.floor(requestedPositions)),
    order.length,
  );
  const selectedEntries = order.slice(0, budget);
  const selectedPositions = new Set(selectedEntries.map((entry) => entry.position));
  const scoped = scopedRepertoire(repertoire, roots, selectedPositions);
  const selectedEdges = Object.values(scoped.repertoire.edges);
  const representedBranches = new Set(
    selectedEdges.map((edge) => edge.from).filter((position) =>
      selectedEdges.filter((edge) => edge.from === position).length > 1,
    ),
  );

  return {
    ...scoped,
    order,
    selectedPositions,
    summary: {
      positions: selectedPositions.size,
      branches: representedBranches.size,
      deepestBranchPlies: deepestBranchPlies(selectedEdges, roots),
      lowestRepertoireReach: selectedEntries.length > 0
        ? Math.min(...selectedEntries.map((entry) => entry.repertoireConditionedReach))
        : 0,
      maximumPositions: order.length,
    },
  };
}

export function isPopularityPack(value: unknown): value is PopularityPack {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pack = value as Partial<PopularityPack>;
  return pack.formatVersion === POPULARITY_FORMAT_VERSION &&
    typeof pack.openingId === 'string' &&
    pack.source === 'lichess-opening-explorer' &&
    typeof pack.edgeGames === 'object' && pack.edgeGames !== null &&
    typeof pack.positionGames === 'object' && pack.positionGames !== null &&
    Array.isArray(pack.defaultRootPositions) &&
    Array.isArray(pack.importanceOrder) &&
    pack.importanceOrder.every((value, index) => {
      const entry = value as Partial<ImportanceOrderEntry>;
      return entry.rank === index + 1 &&
        typeof entry.position === 'string' &&
        typeof entry.repertoireConditionedReach === 'number' &&
        Number.isFinite(entry.repertoireConditionedReach) &&
        entry.repertoireConditionedReach >= 0 &&
        entry.repertoireConditionedReach <= 1 &&
        typeof entry.moveProbabilityFactor === 'number' &&
        Number.isFinite(entry.moveProbabilityFactor) &&
        entry.moveProbabilityFactor >= 0 &&
        entry.moveProbabilityFactor <= 1 &&
        typeof entry.parentReach === 'number' &&
        Number.isFinite(entry.parentReach) &&
        entry.parentReach >= 0 &&
        entry.parentReach <= 1 &&
        typeof entry.moveGames === 'number' &&
        Number.isSafeInteger(entry.moveGames) &&
        entry.moveGames >= 0 &&
        typeof entry.parentGames === 'number' &&
        Number.isSafeInteger(entry.parentGames) &&
        entry.parentGames >= 0 &&
        typeof entry.repertoireMove === 'boolean' &&
        Array.isArray(entry.parentPositions) &&
        Array.isArray(entry.triggeringEdgeIds) &&
        Array.isArray(entry.sources);
    });
}
