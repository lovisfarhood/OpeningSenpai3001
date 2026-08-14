import {
  normalizeFen,
  stableId,
  type AnnotationMarks,
  type CanonicalAnnotation,
  type CanonicalRepertoire,
  type SourceType,
} from '../domain/repertoire.js';
import type {
  LocalAdditionInput,
  LocalAnnotationContent,
} from '../storage/types.js';
import type {
  ChesslyStudyImport,
  RawImportedComment,
  ValidatedImportPackage,
} from './types.js';

interface ImportedReply {
  sourceType: SourceType;
  studyFolder: string;
  whiteTurnPosition: string;
  whiteMoveSan: string;
  blackTurnPosition: string;
  blackMoveSan: string;
  resultingWhiteTurnPosition: string;
  explanation: LocalAnnotationContent | null;
  plan: LocalAnnotationContent | null;
}

const SOURCE_RANK: Record<SourceType, number> = {
  user: 0,
  main: 1,
  bonus: 2,
};

function mergeMarks(
  comments: readonly RawImportedComment[],
  field: 'arrows' | 'highlights',
): AnnotationMarks | null {
  const marks = comments.map((comment) => comment[field]).filter(Boolean);
  if (marks.length === 0) {
    return null;
  }
  return {
    threats: [...new Set(marks.flatMap((item) => item?.threats ?? []))].sort(),
    opportunities: [
      ...new Set(marks.flatMap((item) => item?.opportunities ?? [])),
    ].sort(),
  };
}

function annotationContent(
  comments: readonly RawImportedComment[] | undefined,
): LocalAnnotationContent | null {
  if (!comments || comments.length === 0) {
    return null;
  }
  return {
    text: comments.map((comment) => comment.text).join('\n\n'),
    arrows: mergeMarks(comments, 'arrows'),
    highlights: mergeMarks(comments, 'highlights'),
  };
}

function studyReplies(study: ChesslyStudyImport): ImportedReply[] {
  const outgoing = new Map<string, typeof study.moves[string]>();
  for (const values of Object.values(study.moves)) {
    for (const move of values) {
      const key = normalizeFen(move.fen);
      outgoing.set(key, [...(outgoing.get(key) ?? []), move]);
    }
  }
  const replies: ImportedReply[] = [];
  for (const values of Object.values(study.moves)) {
    for (const whiteMove of values) {
      if (normalizeFen(whiteMove.fen).split(' ')[1] !== 'w') {
        continue;
      }
      const blackPosition = normalizeFen(whiteMove.nextFen);
      const possibleReplies = (outgoing.get(blackPosition) ?? []).filter(
        (reply) => reply.variationId === whiteMove.variationId,
      );
      for (const reply of possibleReplies) {
        if (normalizeFen(reply.fen).split(' ')[1] !== 'b') {
          continue;
        }
        replies.push({
          sourceType: study.sourceType,
          studyFolder: study.studyFolder,
          whiteTurnPosition: normalizeFen(whiteMove.fen),
          whiteMoveSan: whiteMove.san,
          blackTurnPosition: blackPosition,
          blackMoveSan: reply.san,
          resultingWhiteTurnPosition: normalizeFen(reply.nextFen),
          explanation: annotationContent(study.comments[reply.fen]),
          plan: annotationContent(study.comments[reply.nextFen]),
        });
      }
    }
  }
  return replies;
}

function annotationToContent(
  annotations: CanonicalAnnotation[],
): LocalAnnotationContent | null {
  if (annotations.length === 0) {
    return null;
  }
  return {
    text: annotations.map((annotation) => annotation.text).join('\n\n'),
    arrows: {
      threats: [
        ...new Set(
          annotations.flatMap(
            (annotation) => annotation.arrows?.threats ?? [],
          ),
        ),
      ].sort(),
      opportunities: [
        ...new Set(
          annotations.flatMap(
            (annotation) => annotation.arrows?.opportunities ?? [],
          ),
        ),
      ].sort(),
    },
    highlights: {
      threats: [
        ...new Set(
          annotations.flatMap(
            (annotation) => annotation.highlights?.threats ?? [],
          ),
        ),
      ].sort(),
      opportunities: [
        ...new Set(
          annotations.flatMap(
            (annotation) => annotation.highlights?.opportunities ?? [],
          ),
        ),
      ].sort(),
    },
  };
}

function canonicalReplies(
  imported: CanonicalRepertoire,
): ImportedReply[] {
  const replies: ImportedReply[] = [];
  for (const node of Object.values(imported.whiteTurnNodes)) {
    for (const whiteMove of node.moves) {
      for (const candidate of whiteMove.candidates) {
        const explanations = new Set(candidate.replyExplanationIds);
        const plans = new Set(candidate.resultingPlanIds);
        const sourceType = candidate.sourceTypes[0] ?? 'user';
        replies.push({
          sourceType,
          studyFolder: 'native-repertoire',
          whiteTurnPosition: node.position,
          whiteMoveSan: whiteMove.san,
          blackTurnPosition: candidate.blackTurnPosition,
          blackMoveSan: candidate.san,
          resultingWhiteTurnPosition:
            candidate.resultingWhiteTurnPosition,
          explanation: annotationToContent(
            (
              imported.positions[candidate.blackTurnPosition]?.annotations ?? []
            ).filter((annotation) => explanations.has(annotation.id)),
          ),
          plan: annotationToContent(
            (
              imported.positions[candidate.resultingWhiteTurnPosition]
                ?.annotations ?? []
            ).filter((annotation) => plans.has(annotation.id)),
          ),
        });
      }
    }
  }
  return replies;
}

function replySignature(reply: ImportedReply): string {
  return JSON.stringify([
    reply.whiteTurnPosition,
    reply.whiteMoveSan,
    reply.blackTurnPosition,
    reply.blackMoveSan,
    reply.resultingWhiteTurnPosition,
  ]);
}

function isInBase(
  reply: ImportedReply,
  existing: CanonicalRepertoire,
): boolean {
  const option = existing.whiteTurnNodes[reply.whiteTurnPosition]?.moves.find(
    (move) =>
      move.san === reply.whiteMoveSan &&
      move.blackTurnPosition === reply.blackTurnPosition,
  );
  return (
    option?.candidates.some(
      (candidate) =>
        candidate.san === reply.blackMoveSan &&
        candidate.resultingWhiteTurnPosition ===
          reply.resultingWhiteTurnPosition,
    ) ?? false
  );
}

export function importPackageToLocalAdditions(
  preview: ValidatedImportPackage,
  existing: CanonicalRepertoire,
): LocalAdditionInput[] {
  if (!preview.canApply || !preview.payload) {
    return [];
  }
  let importedReplies: ImportedReply[];
  if (preview.payload.kind === 'chessly-studies') {
    importedReplies = preview.payload.studies.flatMap(studyReplies);
  } else if (preview.payload.kind === 'native-repertoire') {
    importedReplies = canonicalReplies(preview.payload.repertoire);
  } else {
    return [];
  }

  const deduplicated = new Map<string, ImportedReply>();
  for (const reply of importedReplies) {
    const signature = replySignature(reply);
    const current = deduplicated.get(signature);
    if (
      !current ||
      SOURCE_RANK[reply.sourceType] < SOURCE_RANK[current.sourceType] ||
      (SOURCE_RANK[reply.sourceType] === SOURCE_RANK[current.sourceType] &&
        reply.studyFolder.localeCompare(current.studyFolder, 'en') < 0)
    ) {
      deduplicated.set(signature, reply);
    }
  }

  return [...deduplicated.values()]
    .filter((reply) => !isInBase(reply, existing))
    .sort(
      (left, right) =>
        left.whiteTurnPosition.localeCompare(right.whiteTurnPosition, 'en') ||
        left.whiteMoveSan.localeCompare(right.whiteMoveSan, 'en') ||
        SOURCE_RANK[left.sourceType] - SOURCE_RANK[right.sourceType] ||
        left.blackMoveSan.localeCompare(right.blackMoveSan, 'en'),
    )
    .map((reply) => {
      const baseOption = existing.whiteTurnNodes[
        reply.whiteTurnPosition
      ]?.moves.find((move) => move.san === reply.whiteMoveSan);
      const id = stableId('imported-addition', [
        reply.sourceType,
        reply.whiteTurnPosition,
        reply.whiteMoveSan,
        reply.blackMoveSan,
        reply.resultingWhiteTurnPosition,
      ]);
      return {
        id,
        sourceType: reply.sourceType,
        branchId: id,
        baseDecisionId: baseOption?.id ?? null,
        whiteTurnPosition: reply.whiteTurnPosition,
        whiteMoveSan: reply.whiteMoveSan,
        blackTurnPosition: reply.blackTurnPosition,
        replies: [
          {
            id,
            san: reply.blackMoveSan,
            resultingWhiteTurnPosition:
              reply.resultingWhiteTurnPosition,
            replyExplanation: reply.explanation,
            resultingPlan: reply.plan,
          },
        ],
      };
    });
}
