import type {
  CanonicalAnnotation,
  CanonicalRepertoire,
  SourceType,
} from '../domain/repertoire.js';
import { START_FEN, normalizeFen } from '../domain/repertoire.js';
import {
  IMPORT_PACKAGE_VERSION,
  type ImportIssue,
  type ImportPackageSourceType,
  type ImportPayload,
  type ImportStatistics,
  type RawImportedComment,
  type ValidatedImportPackage,
} from './types.js';

export interface GraphEdge {
  readonly from: string;
  readonly san: string;
  readonly to: string;
  readonly sourceType: SourceType;
}

export interface GraphComment {
  readonly position: string;
  readonly comment: RawImportedComment;
}

export interface ImportGraph {
  readonly positions: ReadonlySet<string>;
  readonly edges: readonly GraphEdge[];
  readonly comments: readonly GraphComment[];
  readonly duplicateOccurrences: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function issue(
  code: ImportIssue['code'],
  severity: ImportIssue['severity'],
  path: string,
  message: string,
  location: string | null = null,
): ImportIssue {
  return { code, severity, path, location, message };
}

export function emptyStatistics(): ImportStatistics {
  return {
    addedPositions: 0,
    addedMoves: 0,
    addedComments: 0,
    duplicates: 0,
    conflicts: 0,
    invalidFiles: 0,
    disconnectedGraphParts: 0,
    disconnectedPositions: 0,
  };
}

function marksKey(
  marks: RawImportedComment['arrows'] | RawImportedComment['highlights'],
): string {
  if (marks === null) {
    return 'null';
  }
  return JSON.stringify([
    [...marks.threats].sort(),
    [...marks.opportunities].sort(),
  ]);
}

export function commentKey(
  position: string,
  comment: RawImportedComment,
): string {
  return JSON.stringify([
    position,
    comment.text,
    marksKey(comment.arrows),
    marksKey(comment.highlights),
  ]);
}

export function edgeKey(edge: Pick<GraphEdge, 'from' | 'san' | 'to'>): string {
  return JSON.stringify([edge.from, edge.san, edge.to]);
}

function moveChoiceKey(edge: Pick<GraphEdge, 'from' | 'san'>): string {
  return JSON.stringify([edge.from, edge.san]);
}

function canonicalComment(
  position: string,
  annotation: CanonicalAnnotation,
): GraphComment {
  return {
    position,
    comment: {
      text: annotation.text,
      arrows: annotation.arrows,
      highlights: annotation.highlights,
    },
  };
}

export function graphFromRepertoire(
  repertoire: CanonicalRepertoire,
): ImportGraph {
  const positions = new Set(Object.keys(repertoire.positions));
  const edges = Object.values(repertoire.edges).map(
    (edge): GraphEdge => ({
      from: edge.from,
      san: edge.san,
      to: edge.to,
      sourceType: edge.sources[0]?.sourceType ?? 'user',
    }),
  );
  const comments = Object.values(repertoire.positions).flatMap((position) =>
    position.annotations.map((annotation) =>
      canonicalComment(position.normalizedFen, annotation),
    ),
  );

  return {
    positions,
    edges,
    comments,
    duplicateOccurrences:
      repertoire.summary.deduplicatedEdgeOccurrences ?? 0,
  };
}

function existingReachablePositions(
  repertoire: CanonicalRepertoire | undefined,
): Set<string> {
  if (!repertoire) {
    return new Set();
  }
  return new Set(
    Object.values(repertoire.positions)
      .filter((position) => position.reachableFromRoot)
      .map((position) => position.normalizedFen),
  );
}

function disconnectedMetrics(
  imported: ImportGraph,
  existing: CanonicalRepertoire | undefined,
): Pick<
  ImportStatistics,
  'disconnectedGraphParts' | 'disconnectedPositions'
> {
  if (imported.positions.size === 0) {
    return { disconnectedGraphParts: 0, disconnectedPositions: 0 };
  }

  const importedPositions = new Set(imported.positions);
  const directed = new Map<string, Set<string>>();
  const undirected = new Map<string, Set<string>>();
  for (const position of importedPositions) {
    directed.set(position, new Set());
    undirected.set(position, new Set());
  }

  for (const edge of imported.edges) {
    directed.get(edge.from)?.add(edge.to);
    if (importedPositions.has(edge.from) && importedPositions.has(edge.to)) {
      undirected.get(edge.from)?.add(edge.to);
      undirected.get(edge.to)?.add(edge.from);
    }
  }

  const reachable = existingReachablePositions(existing);
  try {
    const root = normalizeFen(existing?.rootPosition ?? START_FEN);
    if (importedPositions.has(root)) {
      reachable.add(root);
    }
  } catch {
    // A malformed existing root is ignored; native validation reports it.
  }

  const queue = [...reachable].filter((position) =>
    importedPositions.has(position),
  );
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current) {
      continue;
    }
    for (const target of directed.get(current) ?? []) {
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }

  const disconnected = new Set(
    [...importedPositions].filter((position) => !reachable.has(position)),
  );
  const disconnectedPositions = disconnected.size;
  let disconnectedGraphParts = 0;
  while (disconnected.size > 0) {
    const first = disconnected.values().next().value as string | undefined;
    if (!first) {
      break;
    }
    disconnectedGraphParts += 1;
    disconnected.delete(first);
    const componentQueue = [first];
    for (let index = 0; index < componentQueue.length; index += 1) {
      const current = componentQueue[index];
      if (!current) {
        continue;
      }
      for (const neighbour of undirected.get(current) ?? []) {
        if (disconnected.delete(neighbour)) {
          componentQueue.push(neighbour);
        }
      }
    }
  }

  return {
    disconnectedGraphParts,
    disconnectedPositions,
  };
}

function conflictKeys(
  imported: ImportGraph,
  existingGraph: ImportGraph | null,
): Set<string> {
  const conflicts = new Set<string>();
  const allEdges = existingGraph
    ? [...existingGraph.edges, ...imported.edges]
    : [...imported.edges];
  const importedEdgeKeys = new Set(imported.edges.map(edgeKey));

  const targetsByChoice = new Map<string, Set<string>>();
  const blackReplies = new Map<string, Set<string>>();
  for (const edge of allEdges) {
    const choice = moveChoiceKey(edge);
    const targets = targetsByChoice.get(choice) ?? new Set<string>();
    targets.add(edge.to);
    targetsByChoice.set(choice, targets);

    const turn = edge.from.split(' ')[1];
    if (turn === 'b') {
      const replies = blackReplies.get(edge.from) ?? new Set<string>();
      replies.add(edgeKey(edge));
      blackReplies.set(edge.from, replies);
    }
  }

  for (const [choice, targets] of targetsByChoice) {
    if (targets.size <= 1) {
      continue;
    }
    const involvedInImport = allEdges.some(
      (edge) =>
        moveChoiceKey(edge) === choice && importedEdgeKeys.has(edgeKey(edge)),
    );
    if (involvedInImport) {
      conflicts.add(`transition:${choice}`);
    }
  }

  for (const [position, replies] of blackReplies) {
    if (replies.size <= 1) {
      continue;
    }
    const involvedInImport = imported.edges.some(
      (edge) => edge.from === position,
    );
    if (involvedInImport) {
      conflicts.add(`reply:${position}`);
    }
  }
  return conflicts;
}

export function calculateStatistics(
  imported: ImportGraph,
  existing: CanonicalRepertoire | undefined,
  invalidFiles: number,
): ImportStatistics {
  const existingGraph = existing ? graphFromRepertoire(existing) : null;
  const existingPositions = existingGraph?.positions ?? new Set<string>();
  const existingEdges = new Set(existingGraph?.edges.map(edgeKey) ?? []);
  const existingComments = new Set(
    existingGraph?.comments.map(({ position, comment }) =>
      commentKey(position, comment),
    ) ?? [],
  );

  const uniqueEdges = new Set<string>();
  let duplicateEdgesAgainstExisting = 0;
  for (const edge of imported.edges) {
    const key = edgeKey(edge);
    uniqueEdges.add(key);
    if (existingEdges.has(key)) {
      duplicateEdgesAgainstExisting += 1;
    }
  }

  const uniqueComments = new Set<string>();
  let duplicateCommentsAgainstExisting = 0;
  for (const { position, comment } of imported.comments) {
    const key = commentKey(position, comment);
    uniqueComments.add(key);
    if (existingComments.has(key)) {
      duplicateCommentsAgainstExisting += 1;
    }
  }

  const addedMoves = [...uniqueEdges].filter(
    (key) => !existingEdges.has(key),
  ).length;
  const addedComments = [...uniqueComments].filter(
    (key) => !existingComments.has(key),
  ).length;
  const disconnected = disconnectedMetrics(imported, existing);

  return {
    addedPositions: [...imported.positions].filter(
      (position) => !existingPositions.has(position),
    ).length,
    addedMoves,
    addedComments,
    duplicates:
      imported.duplicateOccurrences +
      duplicateEdgesAgainstExisting +
      duplicateCommentsAgainstExisting,
    conflicts: conflictKeys(imported, existingGraph).size,
    invalidFiles,
    ...disconnected,
  };
}

function detectedSourceType(
  sourceTypes: ReadonlySet<SourceType>,
): ImportPackageSourceType {
  if (sourceTypes.size !== 1) {
    return 'mixed';
  }
  return sourceTypes.values().next().value ?? 'mixed';
}

export function buildPackage(input: {
  inputKind: ValidatedImportPackage['inputKind'];
  sourceTypes: ReadonlySet<SourceType>;
  issues: readonly ImportIssue[];
  statistics: ImportStatistics;
  payload: ImportPayload | null;
  blocking?: boolean;
}): ValidatedImportPackage {
  const blocking =
    input.blocking === true ||
    input.payload === null ||
    input.issues.some((item) => item.severity === 'error');
  return {
    packageVersion: IMPORT_PACKAGE_VERSION,
    inputKind: input.inputKind,
    sourceType: detectedSourceType(input.sourceTypes),
    status: blocking ? 'invalid' : 'ready',
    canApply: !blocking,
    requiresConfirmation: true,
    overwriteExisting: false,
    sourcePriority: ['main', 'bonus', 'user'],
    statistics: input.statistics,
    issues: input.issues,
    payload: input.payload,
  };
}
