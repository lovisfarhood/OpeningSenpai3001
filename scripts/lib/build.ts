import { Chess, validateFen } from 'chess.js';

import {
  FORMAT_VERSION,
  START_FEN,
  annotationId,
  decisionId,
  edgeId,
  fenTurn,
  normalizeFen,
  stableId,
  type AnnotationMarks,
  type AnnotationOrigin,
  type CanonicalAnnotation,
  type CanonicalEdge,
  type CanonicalPosition,
  type CanonicalRepertoire,
  type ConflictStatus,
  type MoveOrigin,
  type ReplyCandidate,
  type RepertoireDecisionNode,
  type RepertoireMoveCandidate,
  type SourceType,
  type WhiteMoveOption,
  type WhiteTurnNode,
} from '../../src/domain/repertoire.js';
import type {
  AuditIssue,
  AuditMetrics,
  BuildResult,
  ConflictReport,
  DecisionConflict,
  DuplicateEdgeGroup,
} from './audit-types.js';
import type { LoadedSources, LoadedStudy } from './build-input.js';
import type { RawComment, RawMove } from './raw-types.js';
import {
  compareAnnotationOrigins,
  compareAnnotations,
  compareMoveOrigins,
  compareSourceTypes,
  compareText,
  sortRecord,
} from './sort.js';

interface EdgeBuilder {
  edge: CanonicalEdge;
  originKeys: Set<string>;
  occurrences: number;
}

interface AnnotationBuilder {
  annotation: CanonicalAnnotation;
  originKeys: Set<string>;
}

interface PositionBuilder {
  fullFens: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRawMove(value: unknown): value is RawMove {
  return (
    isRecord(value) &&
    typeof value.fen === 'string' &&
    typeof value.san === 'string' &&
    typeof value.nextFen === 'string' &&
    typeof value.variationId === 'string' &&
    typeof value.variationIndex === 'number' &&
    Number.isFinite(value.variationIndex)
  );
}

function parseMarks(
  value: unknown,
  kind: 'arrow' | 'highlight',
): AnnotationMarks | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const threats = value.threats;
  const opportunities = value.opportunities;
  if (
    !Array.isArray(threats) ||
    !threats.every((item) => typeof item === 'string') ||
    !Array.isArray(opportunities) ||
    !opportunities.every((item) => typeof item === 'string')
  ) {
    return undefined;
  }
  const pattern =
    kind === 'arrow'
      ? /^[a-h][1-8]-[a-h][1-8]$/
      : /^[a-h][1-8]$/;
  if (
    !threats.every((item) => pattern.test(item)) ||
    !opportunities.every((item) => pattern.test(item))
  ) {
    return undefined;
  }
  return {
    threats: [...threats],
    opportunities: [...opportunities],
  };
}

function parseRawComment(value: unknown): RawComment | null {
  if (!isRecord(value) || typeof value.text !== 'string') {
    return null;
  }
  const arrows = parseMarks(value.arrows, 'arrow');
  const highlights = parseMarks(value.highlights, 'highlight');
  if (arrows === undefined || highlights === undefined) {
    return null;
  }
  return {
    text: value.text,
    arrows,
    highlights,
  };
}

function issue(
  study: LoadedStudy,
  file: string,
  location: string,
  message: string,
): AuditIssue {
  return {
    sourceType: study.sourceType,
    studyFolder: study.studyFolder,
    file,
    location,
    message,
  };
}

function moveOrigin(study: LoadedStudy, move: RawMove): MoveOrigin {
  const originWithoutId = {
    sourceType: study.sourceType,
    courseFolder: study.courseFolder,
    studyFolder: study.studyFolder,
    ...study.metadata,
    variationId: move.variationId,
    variationIndex: move.variationIndex,
    rawFen: move.fen,
    rawNextFen: move.nextFen,
  };
  return {
    id: stableId('origin', [
      originWithoutId.sourceType,
      originWithoutId.courseFolder,
      originWithoutId.studyFolder,
      originWithoutId.variationId,
      originWithoutId.variationIndex,
      originWithoutId.rawFen,
      originWithoutId.rawNextFen,
    ]),
    ...originWithoutId,
  };
}

function annotationOrigin(study: LoadedStudy, rawFen: string): AnnotationOrigin {
  return {
    sourceType: study.sourceType,
    courseFolder: study.courseFolder,
    studyFolder: study.studyFolder,
    ...study.metadata,
    rawFen,
  };
}

function moveOriginKey(origin: MoveOrigin): string {
  return origin.id;
}

function annotationOriginKey(origin: AnnotationOrigin): string {
  return JSON.stringify([
    origin.sourceType,
    origin.courseFolder,
    origin.studyFolder,
    origin.rawFen,
  ]);
}

function lineageKey(origin: MoveOrigin): string {
  return JSON.stringify([
    origin.sourceType,
    origin.courseFolder,
    origin.studyFolder,
    origin.variationId,
  ]);
}

function studyKey(
  origin: Pick<MoveOrigin | AnnotationOrigin, 'sourceType' | 'courseFolder' | 'studyFolder'>,
): string {
  return JSON.stringify([
    origin.sourceType,
    origin.courseFolder,
    origin.studyFolder,
  ]);
}

function nominalEnPassantSquare(move: {
  from: string;
  to: string;
  isBigPawn(): boolean;
}): string {
  if (!move.isBigPawn()) {
    return '-';
  }
  const file = move.from[0];
  const fromRank = Number(move.from[1]);
  const toRank = Number(move.to[1]);
  return `${file}${(fromRank + toRank) / 2}`;
}

function validateTransition(move: RawMove): {
  ok: boolean;
  sanError: string | null;
  nextFenError: string | null;
} {
  let chess: Chess;
  try {
    chess = new Chess(move.fen);
  } catch (error) {
    return {
      ok: false,
      sanError: error instanceof Error ? error.message : String(error),
      nextFenError: null,
    };
  }

  try {
    const applied = chess.move(move.san, { strict: true });
    const expectedFields = chess.fen().split(' ');
    expectedFields[3] = nominalEnPassantSquare(applied);
    const expectedFen = expectedFields.join(' ');
    if (expectedFen !== move.nextFen) {
      return {
        ok: false,
        sanError: null,
        nextFenError: `Erwartet ${expectedFen}, erhalten ${move.nextFen}`,
      };
    }
    return { ok: true, sanError: null, nextFenError: null };
  } catch (error) {
    return {
      ok: false,
      sanError: error instanceof Error ? error.message : String(error),
      nextFenError: null,
    };
  }
}

function originSourceTypes(origins: MoveOrigin[]): SourceType[] {
  return [...new Set(origins.map((origin) => origin.sourceType))].sort(
    compareSourceTypes,
  );
}

function candidateRank(candidate: ReplyCandidate): number {
  if (candidate.sourceTypes.includes('main')) {
    return 0;
  }
  if (candidate.sourceTypes.includes('bonus')) {
    return 1;
  }
  return 2;
}

function chooseCandidate(candidates: ReplyCandidate[]): {
  selectedReplyId: string | null;
  status: ConflictStatus;
} {
  if (candidates.length === 0) {
    return { selectedReplyId: null, status: 'missing-reply' };
  }

  for (const sourceType of ['main', 'bonus', 'user'] as const) {
    const eligible = candidates.filter((candidate) =>
      candidate.sourceTypes.includes(sourceType),
    );
    if (eligible.length === 0) {
      continue;
    }
    if (eligible.length > 1) {
      return { selectedReplyId: null, status: 'unresolved' };
    }
    const selected = eligible[0];
    if (!selected) {
      break;
    }
    return {
      selectedReplyId: selected.id,
      status:
        candidates.length > 1 ? 'resolved-by-source-priority' : 'resolved',
    };
  }

  return { selectedReplyId: null, status: 'missing-reply' };
}

function filterAnnotationsForCandidate(
  annotations: CanonicalAnnotation[],
  sources: MoveOrigin[],
  phase: 'before-reply' | 'after-reply',
): CanonicalAnnotation[] {
  const compatibleStudies = new Set(sources.map(studyKey));
  const compatibleRawFens = new Set(
    sources.map((source) =>
      phase === 'before-reply' ? source.rawFen : source.rawNextFen,
    ),
  );
  return annotations
    .map((annotation) => {
      const compatibleSources = annotation.sources.filter(
        (source) =>
          compatibleStudies.has(studyKey(source)) &&
          compatibleRawFens.has(source.rawFen),
      );
      if (compatibleSources.length === 0) {
        return null;
      }
      return {
        ...annotation,
        sources: compatibleSources.sort(compareAnnotationOrigins),
      };
    })
    .filter((annotation): annotation is CanonicalAnnotation => annotation !== null)
    .sort(compareAnnotations);
}

function toDecisionConflict(
  option: WhiteMoveOption,
  position: string,
  edgeRecord: Record<string, CanonicalEdge>,
): DecisionConflict {
  return {
    decisionId: option.id,
    position,
    whiteMove: option.san,
    status: option.conflictStatus,
    selectedReplyId: option.selectedReplyId,
    candidates: option.candidates.map((candidate) => {
      const sourceIds = new Set(candidate.sourceOriginIds);
      const sources = (edgeRecord[candidate.replyEdgeId]?.sources ?? []).filter(
        (source) => sourceIds.has(source.id),
      );
      return {
        id: candidate.id,
        san: candidate.san,
        resultingPosition: candidate.resultingWhiteTurnPosition,
        sourceTypes: candidate.sourceTypes,
        studies: [...new Set(sources.map((source) => source.studyFolder))].sort(
          compareText,
        ),
      };
    }),
  };
}

export interface BuildCanonicalRepertoireOptions {
  openingId?: string;
  title?: string;
  repertoireSide?: 'white' | 'black' | 'unresolved';
  sourcePath?: string;
  bonusSourcePath?: string;
}

export function buildCanonicalRepertoire(
  loaded: LoadedSources,
  options: BuildCanonicalRepertoireOptions = {},
): BuildResult {
  const sourcePath = options.sourcePath ?? 'local-browser-import';
  const bonusSourcePath = options.bonusSourcePath ?? `${sourcePath}-bonus`;
  const invalidJson: AuditIssue[] = [];
  const invalidFens: AuditIssue[] = [];
  const invalidSan: AuditIssue[] = [];
  const invalidNextFen: AuditIssue[] = [];
  const keyFenMismatches: AuditIssue[] = [];
  const invalidMoveEntries: AuditIssue[] = [];
  const invalidCommentEntries: AuditIssue[] = [];

  const fullFens = new Set<string>();
  const normalizedFens = new Set<string>();
  const fullFenCommentPositions = new Set<string>();
  const normalizedCommentPositions = new Set<string>();
  const variationIds = new Set<string>();
  const variationIndexValues = new Set<number>();
  const positionBuilders = new Map<string, PositionBuilder>();
  const edgeBuilders = new Map<string, EdgeBuilder>();
  const annotationBuildersByPosition = new Map<
    string,
    Map<string, AnnotationBuilder>
  >();

  let validMovesJson = 0;
  let validCommentsJson = 0;
  let rawMoveEntries = 0;
  let variationIndexOccurrences = 0;
  let commentObjects = 0;
  let arrows = 0;
  let highlights = 0;
  let arrowCategoryCollisions = 0;
  let highlightCategoryCollisions = 0;

  const registerFen = (
    fen: string,
    study: LoadedStudy,
    file: string,
    location: string,
  ): string | null => {
    fullFens.add(fen);
    const validation = validateFen(fen);
    if (!validation.ok) {
      invalidFens.push(
        issue(study, file, location, validation.error || 'Ungültige FEN.'),
      );
      return null;
    }
    const normalized = normalizeFen(fen);
    normalizedFens.add(normalized);
    const position = positionBuilders.get(normalized) ?? {
      fullFens: new Set<string>(),
    };
    position.fullFens.add(fen);
    positionBuilders.set(normalized, position);
    return normalized;
  };

  for (const study of loaded.studies) {
    if (study.movesParseError) {
      invalidJson.push(
        issue(study, 'moves.json', '$', study.movesParseError),
      );
    } else {
      validMovesJson += 1;
    }
    if (study.commentsParseError) {
      invalidJson.push(
        issue(study, 'comments.json', '$', study.commentsParseError),
      );
    } else {
      validCommentsJson += 1;
    }

    if (study.moves) {
      const moveEntries = Object.entries(study.moves).sort(([left], [right]) =>
        compareText(left, right),
      );
      for (const [fenKey, values] of moveEntries) {
        registerFen(fenKey, study, 'moves.json', fenKey);
        if (!Array.isArray(values)) {
          invalidMoveEntries.push(
            issue(study, 'moves.json', fenKey, 'Der FEN-Wert ist kein Array.'),
          );
          continue;
        }
        for (const [index, value] of values.entries()) {
          rawMoveEntries += 1;
          const location = `${fenKey}[${index}]`;
          if (!isRawMove(value)) {
            invalidMoveEntries.push(
              issue(study, 'moves.json', location, 'Ungültiges Move-Objekt.'),
            );
            continue;
          }
          variationIds.add(value.variationId);
          variationIndexValues.add(value.variationIndex);
          variationIndexOccurrences += 1;

          const source = registerFen(
            value.fen,
            study,
            'moves.json',
            `${location}.fen`,
          );
          const target = registerFen(
            value.nextFen,
            study,
            'moves.json',
            `${location}.nextFen`,
          );
          if (fenKey !== value.fen) {
            keyFenMismatches.push(
              issue(
                study,
                'moves.json',
                location,
                `Objektschlüssel und entry.fen unterscheiden sich: ${fenKey} != ${value.fen}`,
              ),
            );
          }
          if (!source || !target) {
            continue;
          }

          const transition = validateTransition(value);
          if (transition.sanError) {
            invalidSan.push(
              issue(study, 'moves.json', `${location}.san`, transition.sanError),
            );
            continue;
          }
          if (transition.nextFenError) {
            invalidNextFen.push(
              issue(
                study,
                'moves.json',
                `${location}.nextFen`,
                transition.nextFenError,
              ),
            );
            continue;
          }

          const id = edgeId(source, value.san, target);
          const origin = moveOrigin(study, value);
          const builder = edgeBuilders.get(id) ?? {
            edge: {
              id,
              from: source,
              san: value.san,
              to: target,
              sources: [],
            },
            originKeys: new Set<string>(),
            occurrences: 0,
          };
          builder.occurrences += 1;
          const originKey = moveOriginKey(origin);
          if (!builder.originKeys.has(originKey)) {
            builder.originKeys.add(originKey);
            builder.edge.sources.push(origin);
          }
          edgeBuilders.set(id, builder);
        }
      }
    }

    if (study.comments) {
      const commentEntries = Object.entries(study.comments).sort(
        ([left], [right]) => compareText(left, right),
      );
      for (const [rawFen, values] of commentEntries) {
        const normalized = registerFen(
          rawFen,
          study,
          'comments.json',
          rawFen,
        );
        if (!Array.isArray(values)) {
          invalidCommentEntries.push(
            issue(
              study,
              'comments.json',
              rawFen,
              'Der FEN-Wert ist kein Array.',
            ),
          );
          continue;
        }
        if (values.length > 0) {
          fullFenCommentPositions.add(rawFen);
          if (normalized) {
            normalizedCommentPositions.add(normalized);
          }
        }
        for (const [index, value] of values.entries()) {
          const location = `${rawFen}[${index}]`;
          const comment = parseRawComment(value);
          if (!comment || !normalized) {
            invalidCommentEntries.push(
              issue(
                study,
                'comments.json',
                location,
                'Ungültiges Kommentarobjekt.',
              ),
            );
            continue;
          }
          commentObjects += 1;
          arrows +=
            (comment.arrows?.threats.length ?? 0) +
            (comment.arrows?.opportunities.length ?? 0);
          highlights +=
            (comment.highlights?.threats.length ?? 0) +
            (comment.highlights?.opportunities.length ?? 0);
          if (
            comment.arrows &&
            comment.arrows.threats.some((coordinate) =>
              comment.arrows?.opportunities.includes(coordinate),
            )
          ) {
            arrowCategoryCollisions += 1;
          }
          if (
            comment.highlights &&
            comment.highlights.threats.some((square) =>
              comment.highlights?.opportunities.includes(square),
            )
          ) {
            highlightCategoryCollisions += 1;
          }

          const id = annotationId(
            normalized,
            comment.text,
            comment.arrows,
            comment.highlights,
          );
          const perPosition =
            annotationBuildersByPosition.get(normalized) ??
            new Map<string, AnnotationBuilder>();
          const origin = annotationOrigin(study, rawFen);
          const builder = perPosition.get(id) ?? {
            annotation: {
              id,
              normalizedFen: normalized,
              text: comment.text,
              arrows: comment.arrows,
              highlights: comment.highlights,
              sources: [],
            },
            originKeys: new Set<string>(),
          };
          const originKey = annotationOriginKey(origin);
          if (!builder.originKeys.has(originKey)) {
            builder.originKeys.add(originKey);
            builder.annotation.sources.push(origin);
          }
          perPosition.set(id, builder);
          annotationBuildersByPosition.set(normalized, perPosition);
        }
      }
    }
  }

  const edges = [...edgeBuilders.values()]
    .map((builder) => ({
      ...builder.edge,
      sources: builder.edge.sources.sort(compareMoveOrigins),
    }))
    .sort(
      (left, right) =>
        compareText(left.from, right.from) ||
        compareText(left.san, right.san) ||
        compareText(left.to, right.to),
    );
  const edgeRecord = sortRecord(edges.map((edge) => [edge.id, edge] as const));

  const annotationsByPosition = new Map<string, CanonicalAnnotation[]>();
  for (const [position, builders] of annotationBuildersByPosition.entries()) {
    annotationsByPosition.set(
      position,
      [...builders.values()]
        .map((builder) => ({
          ...builder.annotation,
          sources: builder.annotation.sources.sort(compareAnnotationOrigins),
        }))
        .sort(compareAnnotations),
    );
  }

  const outgoing = new Map<string, CanonicalEdge[]>();
  const incoming = new Map<string, CanonicalEdge[]>();
  for (const edge of edges) {
    const outgoingEdges = outgoing.get(edge.from) ?? [];
    outgoingEdges.push(edge);
    outgoing.set(edge.from, outgoingEdges);
    const incomingEdges = incoming.get(edge.to) ?? [];
    incomingEdges.push(edge);
    incoming.set(edge.to, incomingEdges);
  }
  for (const values of outgoing.values()) {
    values.sort(
      (left, right) =>
        compareText(left.san, right.san) || compareText(left.to, right.to),
    );
  }

  const rootPosition = normalizeFen(START_FEN);
  const reachable = new Set<string>();
  const queue = [rootPosition];
  while (queue.length > 0) {
    const position = queue.shift();
    if (!position || reachable.has(position)) {
      continue;
    }
    reachable.add(position);
    for (const edge of outgoing.get(position) ?? []) {
      if (!reachable.has(edge.to)) {
        queue.push(edge.to);
      }
    }
  }

  const positions = new Map<string, CanonicalPosition>();
  for (const [normalizedFen, builder] of positionBuilders.entries()) {
    positions.set(normalizedFen, {
      id: normalizedFen,
      normalizedFen,
      turn: fenTurn([...builder.fullFens].sort(compareText)[0] ?? normalizedFen),
      fullFens: [...builder.fullFens].sort(compareText),
      annotations: annotationsByPosition.get(normalizedFen) ?? [],
      reachableFromRoot: reachable.has(normalizedFen),
    });
  }

  const whiteTurnNodes = new Map<string, WhiteTurnNode>();
  let mainCourseConflicts = 0;
  let unresolvedConflicts = 0;
  let completeDecisionUnits = 0;
  let incompleteDecisionUnits = 0;
  let resolvedBySourcePriority = 0;

  for (const position of [...positions.values()]
    .filter((item) => item.turn === 'w' && item.reachableFromRoot)
    .sort((left, right) => compareText(left.id, right.id))) {
    const whiteMoves = (outgoing.get(position.id) ?? []).filter(
      (edge) => positions.get(edge.to)?.turn === 'b',
    );
    const options: WhiteMoveOption[] = [];

    for (const whiteEdge of whiteMoves) {
      const lineages = new Set(whiteEdge.sources.map(lineageKey));
      const replyEdges = (outgoing.get(whiteEdge.to) ?? []).filter(
        (edge) => positions.get(edge.to)?.turn === 'w',
      );
      const candidates = replyEdges
        .map((replyEdge): ReplyCandidate => {
          const pairedSources = replyEdge.sources.filter((origin) =>
            lineages.has(lineageKey(origin)),
          );
          const sources =
            pairedSources.length > 0 ? pairedSources : replyEdge.sources;
          return {
            id: stableId('reply', [whiteEdge.id, replyEdge.id]),
            replyEdgeId: replyEdge.id,
            san: replyEdge.san,
            blackTurnPosition: whiteEdge.to,
            resultingWhiteTurnPosition: replyEdge.to,
            sourceTypes: originSourceTypes(sources),
            sourceOriginIds: [...sources]
              .sort(compareMoveOrigins)
              .map((source) => source.id),
            replyExplanationIds: filterAnnotationsForCandidate(
              annotationsByPosition.get(whiteEdge.to) ?? [],
              sources,
              'before-reply',
            ).map((annotation) => annotation.id),
            resultingPlanIds: filterAnnotationsForCandidate(
              annotationsByPosition.get(replyEdge.to) ?? [],
              sources,
              'after-reply',
            ).map((annotation) => annotation.id),
          };
        })
        .sort(
          (left, right) =>
            candidateRank(left) - candidateRank(right) ||
            compareText(left.san, right.san) ||
            compareText(
              left.resultingWhiteTurnPosition,
              right.resultingWhiteTurnPosition,
            ),
        );

      const selection = chooseCandidate(candidates);
      const option: WhiteMoveOption = {
        id: decisionId(position.id, whiteEdge.san),
        whiteEdgeId: whiteEdge.id,
        san: whiteEdge.san,
        blackTurnPosition: whiteEdge.to,
        selectedReplyId: selection.selectedReplyId,
        conflictStatus: selection.status,
        localSelectionAllowed:
          selection.status === 'unresolved' || candidates.length > 1,
        candidates,
      };
      options.push(option);

      const mainCandidates = candidates.filter((candidate) =>
        candidate.sourceTypes.includes('main'),
      );
      if (mainCandidates.length > 1) {
        mainCourseConflicts += 1;
      }
      if (selection.status === 'unresolved') {
        unresolvedConflicts += 1;
      }
      if (selection.status === 'resolved-by-source-priority') {
        resolvedBySourcePriority += 1;
      }
      if (candidates.length === 0) {
        incompleteDecisionUnits += 1;
      } else {
        completeDecisionUnits += 1;
      }
    }

    options.sort(
      (left, right) =>
        compareText(left.san, right.san) ||
        compareText(left.blackTurnPosition, right.blackTurnPosition),
    );
    whiteTurnNodes.set(position.id, {
      id: stableId('white-node', position.id),
      position: position.id,
      moves: options,
    });
  }

  let withPre = 0;
  let withPost = 0;
  let withBoth = 0;
  let onlyPre = 0;
  let onlyPost = 0;
  let withoutComments = 0;
  for (const node of whiteTurnNodes.values()) {
    for (const option of node.moves) {
      for (const candidate of option.candidates) {
        const pre = candidate.replyExplanationIds.length > 0;
        const post = candidate.resultingPlanIds.length > 0;
        if (pre) {
          withPre += 1;
        }
        if (post) {
          withPost += 1;
        }
        if (pre && post) {
          withBoth += 1;
        } else if (pre) {
          onlyPre += 1;
        } else if (post) {
          onlyPost += 1;
        } else {
          withoutComments += 1;
        }
      }
    }
  }

  const disconnectedPositions = [...positions.keys()]
    .filter((position) => !reachable.has(position))
    .sort(compareText);
  const disconnectedEdges = edges
    .filter((edge) => !reachable.has(edge.from))
    .map((edge) => edge.id)
    .sort(compareText);
  const terminalTargetPositions = [...incoming.keys()].filter(
    (position) => (outgoing.get(position)?.length ?? 0) === 0,
  ).length;

  const duplicateGroups: DuplicateEdgeGroup[] = [...edgeBuilders.values()]
    .filter((builder) => builder.occurrences > 1)
    .map((builder) => ({
      edgeId: builder.edge.id,
      from: builder.edge.from,
      san: builder.edge.san,
      to: builder.edge.to,
      occurrences: builder.occurrences,
      studies: [...new Set(builder.edge.sources.map((source) => source.studyFolder))].sort(
        compareText,
      ),
      variationIds: [
        ...new Set(builder.edge.sources.map((source) => source.variationId)),
      ].sort(compareText),
    }))
    .sort(
      (left, right) =>
        right.occurrences - left.occurrences ||
        compareText(left.edgeId, right.edgeId),
    );
  const deduplicatedEdgeOccurrences = [...edgeBuilders.values()].reduce(
    (total, builder) => total + builder.occurrences - 1,
    0,
  );

  const allOptions = [...whiteTurnNodes.values()].flatMap((node) =>
    node.moves.map((option) => ({ node, option })),
  );
  const conflicts = allOptions
    .filter(({ option }) => option.candidates.length > 1)
    .map(({ node, option }) =>
      toDecisionConflict(option, node.position, edgeRecord),
    );
  const missingReplies = allOptions
    .filter(({ option }) => option.conflictStatus === 'missing-reply')
    .map(({ node, option }) =>
      toDecisionConflict(option, node.position, edgeRecord),
    );

  const bonusStatus = loaded.bonusPresent
    ? 'Bonusdaten vorhanden und durch die Pipeline verarbeitet.'
    : 'Bonusdaten noch nicht vorhanden; Haupt-/Bonus-Vergleich derzeit nicht ausführbar.';
  const metrics: AuditMetrics = {
    studyFolders: loaded.studies.length,
    mainStudyFolders: loaded.studies.filter(
      (study) => study.sourceType === 'main',
    ).length,
    bonusStudyFolders: loaded.studies.filter(
      (study) => study.sourceType === 'bonus',
    ).length,
    validMovesJson,
    validCommentsJson,
    distinctFullFens: fullFens.size,
    distinctNormalizedFens: normalizedFens.size,
    rawMoveEntries,
    distinctVariationIds: variationIds.size,
    variationIndexOccurrences,
    distinctVariationIndexValues: variationIndexValues.size,
    fullFenPositionsWithComments: fullFenCommentPositions.size,
    normalizedPositionsWithComments: normalizedCommentPositions.size,
    commentObjects,
    arrows,
    highlights,
    arrowCategoryCollisions,
    highlightCategoryCollisions,
    invalidJsonFiles: invalidJson.length,
    invalidFens: invalidFens.length,
    invalidSanMoves: invalidSan.length,
    invalidNextFenTransitions: invalidNextFen.length,
    keyFenMismatches: keyFenMismatches.length,
    disconnectedPositions: disconnectedPositions.length,
    disconnectedEdges: disconnectedEdges.length,
    nextFenReferencesWithoutReachableConnection: disconnectedEdges.length,
    terminalTargetPositions,
    canonicalEdges: edges.length,
    duplicateEdgeGroups: duplicateGroups.length,
    deduplicatedEdgeOccurrences,
    positionsWithMultipleOutgoingMoves: [...outgoing.values()].filter(
      (value) => value.length > 1,
    ).length,
    whitePositionsWithMultipleMoves: [...outgoing.entries()].filter(
      ([positionId, value]) =>
        positions.get(positionId)?.turn === 'w' && value.length > 1,
    ).length,
    blackPositionsWithMultipleReplies: [...outgoing.entries()].filter(
      ([positionId, value]) =>
        positions.get(positionId)?.turn === 'b' && value.length > 1,
    ).length,
    whiteTurnPositions: [...positions.values()].filter(
      (position) => position.turn === 'w' && position.reachableFromRoot,
    ).length,
    blackTurnPositions: [...positions.values()].filter(
      (position) => position.turn === 'b' && position.reachableFromRoot,
    ).length,
    whiteDecisionKeys: allOptions.length,
    completeDecisionUnits,
    incompleteDecisionUnits,
    mainCourseConflicts,
    unresolvedConflicts,
    decisionsWithPreReplyComments: withPre,
    decisionsWithPostReplyComments: withPost,
    decisionsWithBothCommentTypes: withBoth,
    decisionsWithOnlyPreReplyComments: onlyPre,
    decisionsWithOnlyPostReplyComments: onlyPost,
    decisionsWithoutComments: withoutComments,
  };

  const repertoireTurn = options.repertoireSide === 'white' ? 'w' : 'b';
  const repertoireDecisionNodes = new Map<string, RepertoireDecisionNode>();
  if (options.repertoireSide !== 'unresolved') {
    for (const position of [...positions.values()].filter(
      (item) => item.reachableFromRoot && item.turn === repertoireTurn,
    )) {
      const candidates: RepertoireMoveCandidate[] = (outgoing.get(position.id) ?? []).map((edge) => ({
        id: stableId('repertoire-candidate', [position.id, edge.id]),
        edgeId: edge.id,
        san: edge.san,
        resultingPosition: edge.to,
        sourceTypes: originSourceTypes(edge.sources),
        explanationIds: filterAnnotationsForCandidate(
          annotationsByPosition.get(position.id) ?? [],
          edge.sources,
          'before-reply',
        ).map((annotation) => annotation.id),
        planIds: filterAnnotationsForCandidate(
          annotationsByPosition.get(edge.to) ?? [],
          edge.sources,
          'after-reply',
        ).map((annotation) => annotation.id),
      }));
      const ranked = candidates
        .map((candidate) => ({ candidate, rank: Math.min(...candidate.sourceTypes.map((type) => ['user', 'main', 'bonus'].indexOf(type))) }))
        .sort((left, right) => left.rank - right.rank || compareText(left.candidate.san, right.candidate.san));
      const bestRank = ranked[0]?.rank;
      const best = ranked.filter((item) => item.rank === bestRank);
      const selectedCandidateId = best.length === 1 ? best[0]?.candidate.id ?? null : null;
      repertoireDecisionNodes.set(position.id, {
        id: stableId('repertoire-decision', [options.openingId ?? 'caro-kann', position.id]),
        position: position.id,
        selectedCandidateId,
        conflictStatus: candidates.length === 0 ? 'missing-reply' : selectedCandidateId ? (candidates.length > 1 ? 'resolved-by-source-priority' : 'resolved') : 'unresolved',
        candidates,
      });
    }
  }

  const repertoire: CanonicalRepertoire = {
    formatVersion: FORMAT_VERSION,
    generatorVersion: '1.0.0',
    title: options.title ?? 'Caro-Kann Defense',
    dataSource: {
      sourceFingerprint: loaded.sourceFingerprint,
      main: {
        type: 'main',
        path: `${sourcePath}/`,
        present: true,
        studyCount: metrics.mainStudyFolders,
      },
      bonus: {
        type: 'bonus',
        path: `${bonusSourcePath}/`,
        present: loaded.bonusPresent,
        studyCount: metrics.bonusStudyFolders,
        status: bonusStatus,
      },
      priority: ['user', 'main', 'bonus'],
    },
    openingId: options.openingId ?? 'caro-kann',
    openingSide: options.repertoireSide ?? 'black',
    rootPosition,
    summary: {
      studies: metrics.studyFolders,
      positions: positions.size,
      reachablePositions: reachable.size,
      rawMoveEntries,
      canonicalEdges: edges.length,
      deduplicatedEdgeOccurrences,
      whiteTurnNodes: whiteTurnNodes.size,
      activeWhiteDecisions: completeDecisionUnits,
      incompleteWhiteDecisions: incompleteDecisionUnits,
      mainCourseConflicts,
      unresolvedConflicts,
      commentObjects,
      arrows,
      highlights,
    },
    topology: {
      terminalPositions: [...positions.values()]
        .filter(
          (position) =>
            position.reachableFromRoot &&
            (outgoing.get(position.id)?.length ?? 0) === 0,
        )
        .map((position) => position.id)
        .sort(compareText),
      transpositionPositions: [...positions.values()]
        .filter(
          (position) =>
            position.reachableFromRoot &&
            (incoming.get(position.id)?.length ?? 0) > 1,
        )
        .map((position) => position.id)
        .sort(compareText),
    },
    positions: sortRecord(positions.entries()),
    edges: edgeRecord,
    whiteTurnNodes: sortRecord(whiteTurnNodes.entries()),
    repertoireDecisionNodes: sortRecord(repertoireDecisionNodes.entries()),
  };

  const conflictReport: ConflictReport = {
    formatVersion: '1.0.0',
    sourceFingerprint: loaded.sourceFingerprint,
    bonusDataPresent: loaded.bonusPresent,
    bonusStatus,
    summary: {
      mainCourseConflicts,
      unresolvedConflicts,
      missingReplies: missingReplies.length,
      resolvedBySourcePriority,
    },
    conflicts,
    missingReplies,
  };

  return {
    repertoire,
    metrics,
    issues: {
      invalidJson,
      invalidFens,
      invalidSan,
      invalidNextFen,
      keyFenMismatches,
      invalidMoveEntries,
      invalidCommentEntries,
      disconnectedPositions,
      disconnectedEdges,
    },
    duplicateGroups,
    conflictReport,
  };
}
