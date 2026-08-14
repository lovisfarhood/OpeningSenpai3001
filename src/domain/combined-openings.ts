import type { OpeningIndexEntry } from '../data/repertoire.js';
import {
  stableId,
  type CanonicalAnnotation,
  type CanonicalEdge,
  type CanonicalPosition,
  type CanonicalRepertoire,
  type RepertoireDecisionNode,
  type RepertoireMoveCandidate,
  type WhiteMoveOption,
  type WhiteTurnNode,
} from './repertoire.js';

export interface CombinedOpening {
  id: string;
  title: string;
  repertoireSide: 'white' | 'black' | 'both';
  /** Stable references only. No source graph is serialized into a collection. */
  openingIds: readonly string[];
  availableModes: readonly ('book' | 'practice' | 'explorer')[];
}

interface CombinedDefinition extends Omit<CombinedOpening, 'availableModes'> {
  explorerOnly?: boolean;
}

/**
 * Deliberately explicit: membership must be reviewed when course IDs change.
 * Never infer a repertoire family from a display title.
 */
export const COMBINED_OPENING_DEFINITIONS: readonly CombinedDefinition[] = [
  {
    id: 'complete-1-e4',
    title: 'Complete 1.e4',
    repertoireSide: 'white',
    openingIds: [
      'vienna-game',
      '1-e4-part-2-sicilian',
      '1-e4-part-3-caro-etc',
    ],
  },
  {
    id: 'complete-dutch',
    title: 'Complete Dutch',
    repertoireSide: 'black',
    openingIds: [
      'dutch-defense-sidelines',
      'stonewall-dutch',
      'the-gotham-dutch',
      'the-leningrad-dutch',
    ],
  },
  {
    id: 'complete-sicilian',
    title: 'Complete Sicilian',
    repertoireSide: 'black',
    openingIds: [
      'four-knights-sicilian',
      'anti-sicilians-for-black',
      'sicilian-dragon',
    ],
  },
  {
    id: 'complete-kings-indian',
    title: "Complete King's Indian",
    repertoireSide: 'black',
    openingIds: ['kings-indian-defense'],
  },
  {
    id: 'complete-white-repertoire',
    title: 'Complete White Repertoire',
    repertoireSide: 'white',
    openingIds: [],
    explorerOnly: true,
  },
  {
    id: 'complete-black-repertoire',
    title: 'Complete Black Repertoire',
    repertoireSide: 'black',
    openingIds: [],
    explorerOnly: true,
  },
  {
    id: 'full-repertoire-explorer',
    title: 'Full Repertoire Explorer',
    repertoireSide: 'both',
    openingIds: [],
    explorerOnly: true,
  },
] as const;

export function createCombinedOpenings(
  openings: readonly OpeningIndexEntry[],
): CombinedOpening[] {
  const known = new Set(openings.map((opening) => opening.id));
  return COMBINED_OPENING_DEFINITIONS.flatMap((definition) => {
    const configuredIds = definition.explorerOnly
      ? openings
          .filter((opening) => definition.repertoireSide === 'both' || opening.repertoireSide === definition.repertoireSide)
          .map((opening) => opening.id)
      : definition.openingIds.filter((id) => known.has(id));
    if (configuredIds.length === 0) return [];
    return [{
      id: definition.id,
      title: definition.title,
      repertoireSide: definition.repertoireSide,
      openingIds: configuredIds,
      availableModes: definition.explorerOnly
        ? ['explorer']
        : ['book', 'practice', 'explorer'],
    }];
  });
}

function mergeById<T extends { id: string }>(values: readonly T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function mergePosition(left: CanonicalPosition | undefined, right: CanonicalPosition): CanonicalPosition {
  if (!left) return { ...right, fullFens: [...right.fullFens], annotations: [...right.annotations] };
  return {
    ...left,
    fullFens: [...new Set([...left.fullFens, ...right.fullFens])],
    annotations: mergeById<CanonicalAnnotation>([...left.annotations, ...right.annotations]),
    reachableFromRoot: left.reachableFromRoot || right.reachableFromRoot,
  };
}

function mergeEdge(left: CanonicalEdge | undefined, right: CanonicalEdge): CanonicalEdge {
  return left
    ? { ...left, sources: mergeById([...left.sources, ...right.sources]) }
    : { ...right, sources: [...right.sources] };
}

function candidateKey(candidate: RepertoireMoveCandidate): string {
  return JSON.stringify([candidate.edgeId, candidate.san, candidate.resultingPosition]);
}

function mergeDecision(
  position: string,
  values: readonly RepertoireDecisionNode[],
): RepertoireDecisionNode {
  const candidates = [...new Map(
    values.flatMap((value) => value.candidates).map((candidate) => [candidateKey(candidate), candidate]),
  ).values()];
  return {
    id: stableId('combined-decision', [position, candidates.map(candidateKey).sort()]),
    position,
    selectedCandidateId: candidates.length === 1 ? candidates[0]?.id ?? null : null,
    conflictStatus: candidates.length === 1 ? 'resolved' : 'unresolved',
    candidates,
  };
}

function mergeWhiteNode(position: string, values: readonly WhiteTurnNode[]): WhiteTurnNode {
  const moves = [...new Map(
    values.flatMap((value) => value.moves).map((move: WhiteMoveOption) => [
      JSON.stringify([move.whiteEdgeId, move.san, move.blackTurnPosition]),
      move,
    ]),
  ).values()];
  return { id: stableId('combined-white-node', position), position, moves };
}

/**
 * Creates an in-memory view for Book/Practice. Source packs remain independent,
 * lazily loaded objects; no combined raw or processed data is written.
 */
export function combineRepertoires(
  definition: CombinedOpening,
  repertoires: readonly CanonicalRepertoire[],
): CanonicalRepertoire {
  if (definition.repertoireSide === 'both') {
    throw new Error(`${definition.title} is Explorer-only and cannot be combined for Book or Practice.`);
  }
  const matching = repertoires.filter(
    (repertoire) => repertoire.openingSide === definition.repertoireSide,
  );
  const first = matching[0];
  if (!first) throw new Error(`Combined opening ${definition.title} has no compatible graph.`);
  const positions: Record<string, CanonicalPosition> = {};
  const edges: Record<string, CanonicalEdge> = {};
  const decisionGroups = new Map<string, RepertoireDecisionNode[]>();
  const whiteGroups = new Map<string, WhiteTurnNode[]>();
  for (const repertoire of matching) {
    for (const position of Object.values(repertoire.positions)) {
      positions[position.id] = mergePosition(positions[position.id], position);
    }
    for (const edge of Object.values(repertoire.edges)) {
      edges[edge.id] = mergeEdge(edges[edge.id], edge);
    }
    for (const decision of Object.values(repertoire.repertoireDecisionNodes)) {
      decisionGroups.set(decision.position, [...(decisionGroups.get(decision.position) ?? []), decision]);
    }
    for (const node of Object.values(repertoire.whiteTurnNodes)) {
      whiteGroups.set(node.position, [...(whiteGroups.get(node.position) ?? []), node]);
    }
  }
  const repertoireDecisionNodes = Object.fromEntries(
    [...decisionGroups].map(([position, values]) => [position, mergeDecision(position, values)]),
  );
  const whiteTurnNodes = Object.fromEntries(
    [...whiteGroups].map(([position, values]) => [position, mergeWhiteNode(position, values)]),
  );
  const summaries = matching.map((item) => item.summary);
  return {
    ...first,
    title: definition.title,
    openingId: definition.id,
    openingSide: definition.repertoireSide,
    dataSource: {
      ...first.dataSource,
      sourceFingerprint: stableId('combined-source', definition.openingIds),
    },
    positions,
    edges,
    repertoireDecisionNodes,
    whiteTurnNodes,
    topology: {
      terminalPositions: [...new Set(matching.flatMap((item) => item.topology.terminalPositions))],
      transpositionPositions: [...new Set(matching.flatMap((item) => item.topology.transpositionPositions))],
    },
    summary: {
      studies: summaries.reduce((sum, item) => sum + item.studies, 0),
      positions: Object.keys(positions).length,
      reachablePositions: Object.values(positions).filter((item) => item.reachableFromRoot).length,
      rawMoveEntries: summaries.reduce((sum, item) => sum + item.rawMoveEntries, 0),
      canonicalEdges: Object.keys(edges).length,
      deduplicatedEdgeOccurrences: summaries.reduce((sum, item) => sum + item.deduplicatedEdgeOccurrences, 0),
      whiteTurnNodes: Object.keys(whiteTurnNodes).length,
      activeWhiteDecisions: Object.keys(repertoireDecisionNodes).length,
      incompleteWhiteDecisions: Object.values(repertoireDecisionNodes).filter((item) => !item.selectedCandidateId).length,
      mainCourseConflicts: summaries.reduce((sum, item) => sum + item.mainCourseConflicts, 0),
      unresolvedConflicts: Object.values(repertoireDecisionNodes).filter((item) => item.conflictStatus === 'unresolved').length,
      commentObjects: summaries.reduce((sum, item) => sum + item.commentObjects, 0),
      arrows: summaries.reduce((sum, item) => sum + item.arrows, 0),
      highlights: summaries.reduce((sum, item) => sum + item.highlights, 0),
    },
  };
}
