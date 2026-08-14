import type { LocalAddition } from '../storage/types.js';
import type { LocalBranch } from './session.js';

export function localAdditionsToBranches(
  additions: LocalAddition[],
): LocalBranch[] {
  return additions
    .flatMap((addition) =>
      addition.replies.map((reply) => ({
        id: reply.id,
        sourceType: addition.sourceType ?? 'user',
        startPosition: addition.whiteTurnPosition,
        whiteSan: addition.whiteMoveSan,
        blackSan: reply.san,
        resultingPosition: reply.resultingWhiteTurnPosition,
        explanation: reply.replyExplanation?.text ?? '',
        plans: reply.resultingPlan?.text ?? '',
        replyArrows: reply.replyExplanation?.arrows ?? null,
        replyHighlights: reply.replyExplanation?.highlights ?? null,
        resultingArrows: reply.resultingPlan?.arrows ?? null,
        resultingHighlights: reply.resultingPlan?.highlights ?? null,
      })),
    )
    .sort((left, right) => left.id.localeCompare(right.id, 'en'));
}
