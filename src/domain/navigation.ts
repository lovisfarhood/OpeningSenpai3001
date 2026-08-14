import { Chess } from 'chess.js';

import type { NavigationState } from '../storage/types.js';
import type { CanonicalRepertoire } from './repertoire.js';
import {
  choosePendingCandidate,
  choosePendingLocalBranch,
  createInitialSession,
  forwardFullMove,
  playPendingBlackReply,
  playWhiteMove,
  undoFullMove,
  type ConflictSelections,
  type LocalBranch,
  type SessionState,
} from './session.js';

export function toNavigationState(
  session: SessionState,
  now = new Date().toISOString(),
): NavigationState {
  return {
    currentPosition: session.currentPosition,
    history: session.history.map((entry) => ({
      whiteTurnPosition: entry.beforePosition,
      whiteMoveSan: entry.whiteSan,
      blackTurnPosition: entry.blackTurnPosition,
      blackMoveSan: entry.blackSan,
      resultingWhiteTurnPosition: entry.resultingPosition,
      decisionId: entry.response.decisionId,
      replyCandidateId: entry.response.candidateId,
    })),
    historyIndex: session.historyIndex - 1,
    updatedAt: now,
  };
}

export function restoreNavigationState(
  navigation: NavigationState | null,
  repertoire: CanonicalRepertoire,
  selections: ConflictSelections,
  localBranches: LocalBranch[],
): SessionState {
  if (!navigation) {
    return createInitialSession();
  }
  let state = createInitialSession();

  try {
    for (const stored of navigation.history) {
      if (state.currentPosition !== stored.whiteTurnPosition) {
        return state;
      }
      const chess = new Chess(state.fullFen);
      const whiteMove = chess.move(stored.whiteMoveSan, { strict: true });
      const transition = playWhiteMove(
        state,
        {
          from: whiteMove.from,
          to: whiteMove.to,
          ...(whiteMove.promotion === 'q' ||
          whiteMove.promotion === 'r' ||
          whiteMove.promotion === 'b' ||
          whiteMove.promotion === 'n'
            ? { promotion: whiteMove.promotion }
            : {}),
        },
        repertoire,
        selections,
        localBranches,
      );
      if (!transition.accepted) {
        return state;
      }
      let waitingState = transition.state;
      if (stored.replyCandidateId) {
        const isLocalCandidate =
          waitingState.pending?.localBranches.some(
            (branch) => branch.id === stored.replyCandidateId,
          ) ?? false;
        waitingState = isLocalCandidate
          ? choosePendingLocalBranch(waitingState, stored.replyCandidateId)
          : choosePendingCandidate(waitingState, stored.replyCandidateId);
      }
      const completed = playPendingBlackReply(waitingState, repertoire);
      if (
        completed.historyIndex !== state.historyIndex + 1 ||
        completed.response?.blackSan !== stored.blackMoveSan
      ) {
        return state;
      }
      state = completed;
    }
  } catch {
    return state;
  }

  const targetHistoryIndex = Math.max(
    0,
    Math.min(navigation.historyIndex + 1, state.history.length),
  );
  while (state.historyIndex > targetHistoryIndex) {
    state = undoFullMove(state);
  }
  while (state.historyIndex < targetHistoryIndex) {
    state = forwardFullMove(state);
  }
  return state;
}
