import { Chess, type Move } from 'chess.js';

import {
  START_FEN,
  normalizeFen,
  stableId,
  type AnnotationMarks,
  type CanonicalRepertoire,
  type ReplyCandidate,
  type WhiteMoveOption,
} from './repertoire.js';

export type SessionStatus =
  | 'ready'
  | 'waiting'
  | 'unknown'
  | 'conflict'
  | 'missing-reply'
  | 'error';

export interface LocalBranch {
  id: string;
  sourceType: 'main' | 'bonus' | 'user';
  startPosition: string;
  whiteSan: string;
  blackSan: string;
  resultingPosition: string;
  explanation: string;
  plans: string;
  replyArrows?: AnnotationMarks | null;
  replyHighlights?: AnnotationMarks | null;
  resultingArrows?: AnnotationMarks | null;
  resultingHighlights?: AnnotationMarks | null;
}

export interface SessionResponse {
  whiteSan: string;
  blackSan: string;
  decisionId: string | null;
  candidateId: string | null;
  blackTurnPosition: string;
  resultingWhiteTurnPosition: string;
  replyExplanationIds: string[];
  resultingPlanIds: string[];
  manual: boolean;
}

export interface HistoryEntry {
  id: string;
  beforeFen: string;
  beforePosition: string;
  afterWhiteFen: string;
  blackTurnPosition: string;
  afterBlackFen: string;
  resultingPosition: string;
  whiteSan: string;
  blackSan: string;
  response: SessionResponse;
}

export interface PendingDecision {
  beforeFen: string;
  beforePosition: string;
  afterWhiteFen: string;
  blackTurnPosition: string;
  whiteSan: string;
  option: WhiteMoveOption | null;
  candidateId: string | null;
  localBranch: LocalBranch | null;
  localBranches: LocalBranch[];
  localDecisionId: string | null;
}

export interface SessionState {
  fullFen: string;
  currentPosition: string;
  status: SessionStatus;
  message: string | null;
  history: HistoryEntry[];
  historyIndex: number;
  pending: PendingDecision | null;
  response: SessionResponse | null;
}

export type ConflictSelections = Record<string, string>;

export interface WhiteMoveInput {
  from: string;
  to: string;
  promotion?: 'q' | 'r' | 'b' | 'n';
}

export interface SessionTransition {
  accepted: boolean;
  state: SessionState;
}

export interface ManualReplyResult {
  state: SessionState;
  branch: LocalBranch | null;
}

export function createInitialSession(): SessionState {
  return {
    fullFen: START_FEN,
    currentPosition: normalizeFen(START_FEN),
    status: 'ready',
    message: null,
    history: [],
    historyIndex: 0,
    pending: null,
    response: null,
  };
}

function selectedCandidate(
  option: WhiteMoveOption,
  selections: ConflictSelections,
): ReplyCandidate | null {
  const localSelection = selections[option.id];
  const selectedId =
    localSelection &&
    option.candidates.some((candidate) => candidate.id === localSelection)
      ? localSelection
      : option.selectedReplyId;
  return (
    option.candidates.find((candidate) => candidate.id === selectedId) ?? null
  );
}

function findLocalBranches(
  branches: LocalBranch[],
  position: string,
  whiteSan: string,
): LocalBranch[] {
  return branches
    .filter(
      (branch) =>
        branch.startPosition === position && branch.whiteSan === whiteSan,
    )
    .sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

function highestPriorityLocalBranches(branches: LocalBranch[]): LocalBranch[] {
  for (const sourceType of ['user', 'main', 'bonus'] as const) {
    const candidates = branches.filter(
      (branch) => branch.sourceType === sourceType,
    );
    if (candidates.length > 0) {
      return candidates;
    }
  }
  return [];
}

function moveWhite(fen: string, input: WhiteMoveInput): Move | null {
  const chess = new Chess(fen);
  if (chess.turn() !== 'w') {
    return null;
  }
  try {
    return chess.move({
      from: input.from,
      to: input.to,
      promotion: input.promotion ?? 'q',
    });
  } catch {
    return null;
  }
}

export function playWhiteMove(
  state: SessionState,
  input: WhiteMoveInput,
  repertoire: CanonicalRepertoire,
  selections: ConflictSelections = {},
  localBranches: LocalBranch[] = [],
): SessionTransition {
  if (state.pending || state.status === 'waiting') {
    return { accepted: false, state };
  }

  const chess = new Chess(state.fullFen);
  const move = moveWhite(state.fullFen, input);
  if (!move) {
    return { accepted: false, state };
  }
  chess.move({
    from: input.from,
    to: input.to,
    promotion: input.promotion ?? 'q',
  });
  const afterWhiteFen = chess.fen();
  const node = repertoire.whiteTurnNodes[state.currentPosition];
  const option = node?.moves.find((item) => item.san === move.san) ?? null;
  const matchingLocalBranches = findLocalBranches(
    localBranches,
    state.currentPosition,
    move.san,
  );
  const localDecisionId =
    matchingLocalBranches.length > 0
      ? option?.id ??
        stableId('local-decision', [state.currentPosition, move.san])
      : null;
  const selectedLocalBranchId = localDecisionId
    ? selections[localDecisionId]
    : undefined;
  const explicitlySelectedLocalBranch =
    matchingLocalBranches.find(
      (branch) => branch.id === selectedLocalBranchId,
    ) ?? null;
  const blackTurnPosition =
    option?.blackTurnPosition ?? normalizeFen(afterWhiteFen);
  const basePending: PendingDecision = {
    beforeFen: state.fullFen,
    beforePosition: state.currentPosition,
    afterWhiteFen,
    blackTurnPosition,
    whiteSan: move.san,
    option,
    candidateId: null,
    localBranch: explicitlySelectedLocalBranch,
    localBranches: matchingLocalBranches,
    localDecisionId,
  };

  if (explicitlySelectedLocalBranch) {
    return {
      accepted: true,
      state: {
        ...state,
        fullFen: afterWhiteFen,
        status: 'waiting',
        message: null,
        pending: basePending,
        response: null,
      },
    };
  }

  const candidate = option ? selectedCandidate(option, selections) : null;
  if (candidate) {
    const explicitBaseSelection =
      selections[option?.id ?? ''] === candidate.id;
    if (!explicitBaseSelection) {
      const userBranches = matchingLocalBranches.filter(
        (branch) => branch.sourceType === 'user',
      );
      if (userBranches.length === 1 && userBranches[0]) {
        return {
          accepted: true,
          state: {
            ...state,
            fullFen: afterWhiteFen,
            status: 'waiting',
            message: null,
            pending: {
              ...basePending,
              localBranch: userBranches[0],
            },
            response: null,
          },
        };
      }
      const samePriorityBranches = matchingLocalBranches.filter(
        (branch) =>
          (candidate.sourceTypes.includes('main') &&
            branch.sourceType === 'main') ||
          (!candidate.sourceTypes.includes('main') &&
            candidate.sourceTypes.includes('bonus') &&
            branch.sourceType === 'bonus'),
      );
      const differentSamePriority = samePriorityBranches.filter(
        (branch) =>
          branch.blackSan !== candidate.san ||
          branch.resultingPosition !==
            candidate.resultingWhiteTurnPosition,
      );
      if (userBranches.length > 1 || differentSamePriority.length > 0) {
        return {
          accepted: true,
          state: {
            ...state,
            fullFen: afterWhiteFen,
            status: 'conflict',
            message:
              'Mehrere gleichrangige schwarze Antworten sind vorhanden. Bitte wähle eine Standardantwort.',
            pending: basePending,
            response: null,
          },
        };
      }
    }
    return {
      accepted: true,
      state: {
        ...state,
        fullFen: afterWhiteFen,
        status: 'waiting',
        message: null,
        pending: {
          ...basePending,
          candidateId: candidate.id,
        },
        response: null,
      },
    };
  }

  if (option && option.candidates.length > 0) {
    return {
      accepted: true,
      state: {
        ...state,
        fullFen: afterWhiteFen,
        status: 'conflict',
        message:
          'Mehrere schwarze Antworten sind vorhanden. Bitte wähle eine Standardantwort.',
        pending: basePending,
        response: null,
      },
    };
  }

  const eligibleLocalBranches = highestPriorityLocalBranches(
    matchingLocalBranches,
  );
  if (eligibleLocalBranches.length === 1 && eligibleLocalBranches[0]) {
    return {
      accepted: true,
      state: {
        ...state,
        fullFen: afterWhiteFen,
        status: 'waiting',
        message: null,
        pending: {
          ...basePending,
          localBranch: eligibleLocalBranches[0],
        },
        response: null,
      },
    };
  }
  if (eligibleLocalBranches.length > 1) {
    return {
      accepted: true,
      state: {
        ...state,
        fullFen: afterWhiteFen,
        status: 'conflict',
        message:
          'Mehrere gleichrangige importierte oder lokale Antworten sind vorhanden. Bitte wähle eine Standardantwort.',
        pending: basePending,
        response: null,
      },
    };
  }

  if (!option) {
    return {
      accepted: true,
      state: {
        ...state,
        fullFen: afterWhiteFen,
        status: 'unknown',
        message: 'Dieser weiße Zug ist noch nicht im Repertoire enthalten.',
        pending: basePending,
        response: null,
      },
    };
  }

  return {
    accepted: true,
    state: {
      ...state,
      fullFen: afterWhiteFen,
      status: 'missing-reply',
      message:
        'Für diesen weißen Zug ist noch keine schwarze Repertoireantwort gespeichert.',
      pending: basePending,
      response: null,
    },
  };
}

export function choosePendingCandidate(
  state: SessionState,
  candidateId: string,
): SessionState {
  const option = state.pending?.option;
  if (
    !state.pending ||
    !option ||
    !option.candidates.some((candidate) => candidate.id === candidateId)
  ) {
    return state;
  }
  return {
    ...state,
    status: 'waiting',
    message: null,
    pending: {
      ...state.pending,
      candidateId,
    },
  };
}

export function choosePendingLocalBranch(
  state: SessionState,
  branchId: string,
): SessionState {
  const pending = state.pending;
  const localBranch = pending?.localBranches.find(
    (branch) => branch.id === branchId,
  );
  if (!pending || !localBranch) {
    return state;
  }
  return {
    ...state,
    status: 'waiting',
    message: null,
    pending: {
      ...pending,
      localBranch,
    },
  };
}

function appendCompletedTurn(
  state: SessionState,
  afterBlackFen: string,
  resultingPosition: string,
  blackSan: string,
  response: SessionResponse,
): SessionState {
  const pending = state.pending;
  if (!pending) {
    return state;
  }
  const entry: HistoryEntry = {
    id: stableId('history', [
      pending.beforePosition,
      pending.whiteSan,
      blackSan,
      state.historyIndex,
    ]),
    beforeFen: pending.beforeFen,
    beforePosition: pending.beforePosition,
    afterWhiteFen: pending.afterWhiteFen,
    blackTurnPosition: pending.blackTurnPosition,
    afterBlackFen,
    resultingPosition,
    whiteSan: pending.whiteSan,
    blackSan,
    response,
  };
  const history = [...state.history.slice(0, state.historyIndex), entry];
  return {
    ...state,
    fullFen: afterBlackFen,
    currentPosition: resultingPosition,
    status: 'ready',
    message: null,
    history,
    historyIndex: history.length,
    pending: null,
    response,
  };
}

export function playPendingBlackReply(
  state: SessionState,
  _repertoire: CanonicalRepertoire,
): SessionState {
  const pending = state.pending;
  if (!pending || state.status !== 'waiting') {
    return state;
  }

  let blackSan: string;
  let resultingPosition: string;
  let response: SessionResponse;

  if (pending.localBranch) {
    blackSan = pending.localBranch.blackSan;
    resultingPosition = pending.localBranch.resultingPosition;
    response = {
      whiteSan: pending.whiteSan,
      blackSan,
      decisionId: pending.localDecisionId,
      candidateId: pending.localBranch.id,
      blackTurnPosition: pending.blackTurnPosition,
      resultingWhiteTurnPosition: resultingPosition,
      replyExplanationIds: [],
      resultingPlanIds: [],
      manual: true,
    };
  } else {
    const option = pending.option;
    const candidate = option?.candidates.find(
      (item) => item.id === pending.candidateId,
    );
    if (!option || !candidate) {
      return {
        ...state,
        status: 'error',
        message: 'Die ausgewählte Repertoireantwort ist nicht mehr verfügbar.',
      };
    }
    blackSan = candidate.san;
    resultingPosition = candidate.resultingWhiteTurnPosition;
    response = {
      whiteSan: pending.whiteSan,
      blackSan,
      decisionId: option.id,
      candidateId: candidate.id,
      blackTurnPosition: candidate.blackTurnPosition,
      resultingWhiteTurnPosition: candidate.resultingWhiteTurnPosition,
      replyExplanationIds: candidate.replyExplanationIds,
      resultingPlanIds: candidate.resultingPlanIds,
      manual: false,
    };
  }

  try {
    const chess = new Chess(pending.afterWhiteFen);
    const move = chess.move(blackSan, { strict: true });
    return appendCompletedTurn(
      state,
      chess.fen(),
      resultingPosition,
      move.san,
      response,
    );
  } catch (error) {
    return {
      ...state,
      status: 'error',
      message:
        error instanceof Error
          ? `Schwarze Antwort konnte nicht ausgeführt werden: ${error.message}`
          : 'Schwarze Antwort konnte nicht ausgeführt werden.',
    };
  }
}

export function addManualReply(
  state: SessionState,
  blackSan: string,
  explanation = '',
  plans = '',
): ManualReplyResult {
  const pending = state.pending;
  if (!pending || !['unknown', 'missing-reply', 'conflict'].includes(state.status)) {
    return { state, branch: null };
  }
  try {
    const chess = new Chess(pending.afterWhiteFen);
    const move = chess.move(blackSan, { strict: true });
    const resultingPosition = normalizeFen(chess.fen());
    const branch: LocalBranch = {
      id: stableId('local-branch', [
        pending.beforePosition,
        pending.whiteSan,
        move.san,
      ]),
      sourceType: 'user',
      startPosition: pending.beforePosition,
      whiteSan: pending.whiteSan,
      blackSan: move.san,
      resultingPosition,
      explanation,
      plans,
      replyArrows: null,
      replyHighlights: null,
      resultingArrows: null,
      resultingHighlights: null,
    };
    const response: SessionResponse = {
      whiteSan: pending.whiteSan,
      blackSan: move.san,
      decisionId:
        pending.localDecisionId ??
        pending.option?.id ??
        stableId('local-decision', [
          pending.beforePosition,
          pending.whiteSan,
        ]),
      candidateId: branch.id,
      blackTurnPosition: pending.blackTurnPosition,
      resultingWhiteTurnPosition: resultingPosition,
      replyExplanationIds: [],
      resultingPlanIds: [],
      manual: true,
    };
    return {
      state: appendCompletedTurn(
        state,
        chess.fen(),
        resultingPosition,
        move.san,
        response,
      ),
      branch,
    };
  } catch (error) {
    return {
      branch: null,
      state: {
        ...state,
        status: 'error',
        message:
          error instanceof Error
            ? `Ungültige schwarze Antwort: ${error.message}`
            : 'Ungültige schwarze Antwort.',
      },
    };
  }
}

function responseAt(history: HistoryEntry[], historyIndex: number): SessionResponse | null {
  return historyIndex > 0 ? history[historyIndex - 1]?.response ?? null : null;
}

export function undoFullMove(state: SessionState): SessionState {
  if (state.pending) {
    return {
      ...state,
      fullFen: state.pending.beforeFen,
      currentPosition: state.pending.beforePosition,
      status: 'ready',
      message: null,
      pending: null,
      response: responseAt(state.history, state.historyIndex),
    };
  }
  if (state.historyIndex === 0) {
    return state;
  }
  const entry = state.history[state.historyIndex - 1];
  if (!entry) {
    return state;
  }
  const historyIndex = state.historyIndex - 1;
  return {
    ...state,
    fullFen: entry.beforeFen,
    currentPosition: entry.beforePosition,
    status: 'ready',
    message: null,
    historyIndex,
    pending: null,
    response: responseAt(state.history, historyIndex),
  };
}

export function forwardFullMove(state: SessionState): SessionState {
  if (state.pending || state.historyIndex >= state.history.length) {
    return state;
  }
  const entry = state.history[state.historyIndex];
  if (!entry) {
    return state;
  }
  return {
    ...state,
    fullFen: entry.afterBlackFen,
    currentPosition: entry.resultingPosition,
    status: 'ready',
    message: null,
    historyIndex: state.historyIndex + 1,
    pending: null,
    response: entry.response,
  };
}

export function restartSession(): SessionState {
  return createInitialSession();
}

export function sessionPgn(state: SessionState): string {
  const chess = new Chess();
  for (const entry of state.history.slice(0, state.historyIndex)) {
    chess.move(entry.whiteSan, { strict: true });
    chess.move(entry.blackSan, { strict: true });
  }
  return chess.pgn();
}

export function currentLineSans(state: SessionState): string[] {
  const sans = state.history
    .slice(0, state.historyIndex)
    .flatMap((entry) => [entry.whiteSan, entry.blackSan]);
  if (state.pending) {
    sans.push(state.pending.whiteSan);
  }
  return sans;
}

export function hydrateSession(value: unknown): SessionState {
  if (!value || typeof value !== 'object') {
    return createInitialSession();
  }
  const candidate = value as Partial<SessionState>;
  if (
    typeof candidate.fullFen !== 'string' ||
    typeof candidate.currentPosition !== 'string' ||
    !Array.isArray(candidate.history) ||
    typeof candidate.historyIndex !== 'number'
  ) {
    return createInitialSession();
  }
  try {
    new Chess(candidate.fullFen);
  } catch {
    return createInitialSession();
  }
  const historyIndex = Math.max(
    0,
    Math.min(Math.trunc(candidate.historyIndex), candidate.history.length),
  );
  return {
    fullFen: candidate.fullFen,
    currentPosition: candidate.currentPosition,
    status: 'ready',
    message: null,
    history: candidate.history,
    historyIndex,
    pending: null,
    response: responseAt(candidate.history, historyIndex),
  };
}
