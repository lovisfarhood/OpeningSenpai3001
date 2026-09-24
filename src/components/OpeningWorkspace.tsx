import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';

import type { CanonicalEdge, CanonicalRepertoire, RepertoireMoveCandidate } from '../domain/repertoire.js';
import { annotationsAfterEdge } from '../domain/annotations.js';
import {
  advancePracticeProgress,
  completePracticeLineRun,
  createPracticeItems,
  createMovePracticeItems,
  deterministicStartingPath,
  maximumPracticeDepth,
  markPracticeLineUnderstood,
  penalizePracticeLine,
  practiceLineProgress,
  pruneNestedPracticeItems,
  resetPracticeItemProgress,
  selectPracticeItem,
  classifyPracticeCompletion,
  type PracticeLine,
  type PracticeLineProgressMap,
  type PracticeCompletionReason,
  type PracticeSchedulerState,
} from '../domain/practice.js';
import {
  buildImportanceOrder,
  createImportanceScope,
  importanceBudgetOptions,
  normalizeImportanceBudget,
  type PopularityPack,
} from '../domain/popularity.js';
import {
  createVariationIndex,
  maximumTrainingDepth,
  storedContinuations,
  type VariationIndex,
} from '../domain/variations.js';
import {
  RepertoireBoard,
  type BoardLayerArrow,
  type ChesslyBoardAnnotation,
  type PromotionPiece,
} from './RepertoireBoard.js';
import { MoveList } from './MoveList.js';
import {
  ArrowLegend,
  StoredContinuations,
  VariationSummary,
} from './VariationSummary.js';
import { ExplorerWorkspace } from './ExplorerWorkspace.js';
import { RandomRecallSession } from './RandomRecallSession.js';
import { UserStateStore } from '../storage/user-state.js';

export type OpeningWorkspaceMode = 'book' | 'practice' | 'explorer';
type PracticeTrainingMode = 'full-lines' | 'random-recall';
type PracticeScopeMode = 'fixed-depth' | 'importance';
interface Ply { fen: string; position: string; edgeId: string; san: string; automatic: boolean; }
interface Stats { attempted: number; firstTry: number; mistakes: number; hint1: number; hint2: number; completed: number; }
interface PracticeCompletion { reason: PracticeCompletionReason; canContinueCurrentLine: boolean; }
interface MoveTimerState { key: string | null; duration: number; remaining: number; timedOut: boolean; }
const EMPTY_STATS: Stats = { attempted: 0, firstTry: 0, mistakes: 0, hint1: 0, hint2: 0, completed: 0 };
const REACH_PERCENT_FORMAT = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 2,
});

const COMPLETION_LABELS: Record<PracticeCompletionReason, string> = {
  'target-depth-reached': 'Target depth reached',
  'stored-line-ended': 'Stored line ended',
  'no-valid-opponent-continuation': 'No valid opponent continuation',
  'unresolved-repertoire-decision': 'Unresolved repertoire decision',
  'user-ended-exercise': 'Exercise ended by user',
};

function restoredPracticeSetup(
  repertoire: CanonicalRepertoire,
  store: UserStateStore,
): { paths: CanonicalEdge[][]; depth: number; max: boolean } {
  const stored = store.getPracticeStartingPositions(repertoire.openingId);
  type LegacyPracticeSetup = { edgeIds?: unknown; depth?: unknown; max?: unknown };
  let legacy: LegacyPracticeSetup | null = null;
  try {
    legacy = JSON.parse(localStorage.getItem(`interactive-chessbook:practice:v2:${repertoire.openingId}`) ?? 'null') as LegacyPracticeSetup | null;
  } catch { /* Invalid legacy state is ignored. */ }
  const legacyIds = Array.isArray(legacy?.edgeIds)
    ? legacy.edgeIds.filter((id): id is string => typeof id === 'string')
    : null;
  const defaultIds = deterministicStartingPath(repertoire).map((edge) => edge.id);
  const idPaths = stored.length > 0
    ? stored.map((position) => position.edgeIds)
    : [legacyIds ?? defaultIds];
  const paths = idPaths.map((ids) => {
    const path: CanonicalEdge[] = [];
    let position = repertoire.rootPosition;
    for (const id of ids) {
      const edge = repertoire.edges[id];
      if (!edge || edge.from !== position) break;
      path.push(edge);
      position = edge.to;
    }
    return path;
  });
  if (stored.length === 0 && !legacyIds) {
    const index = createVariationIndex(repertoire);
    const path = paths[0] ?? [];
    let position = path.at(-1)?.to ?? repertoire.rootPosition;
    while (path.length > 0 && maximumTrainingDepth(index, position) === 0) {
      path.pop();
      position = path.at(-1)?.to ?? repertoire.rootPosition;
    }
  }
  return {
    paths,
    depth: typeof legacy?.depth === 'number' && legacy.depth > 0 ? Math.floor(legacy.depth) : 3,
    max: legacy?.max === true,
  };
}

function fullFen(repertoire: CanonicalRepertoire, position: string): string {
  return repertoire.positions[position]?.fullFens[0] ?? position;
}

function moveCoordinates(fen: string, san: string): { from: string; to: string } | null {
  try {
    const move = new Chess(fen).move(san, { strict: true });
    return { from: move.from, to: move.to };
  } catch { return null; }
}

function storedMoveArrows(
  repertoire: CanonicalRepertoire,
  variationIndex: VariationIndex,
  position: string,
): BoardLayerArrow[] {
  const fen = fullFen(repertoire, position);
  const repertoireSide = repertoire.openingSide === 'white' ? 'w' : 'b';
  const role = repertoire.positions[position]?.turn === repertoireSide
    ? 'repertoire'
    : 'opponent';
  return storedContinuations(variationIndex, position).flatMap(
    (continuation) => {
      const coordinates = moveCoordinates(fen, continuation.san);
      return coordinates
        ? [{
            id: continuation.id,
            fromSquare: coordinates.from,
            toSquare: coordinates.to,
            san: continuation.san,
            role,
          }]
        : [];
    },
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement &&
    target.matches('input, textarea, select, [contenteditable="true"]');
}

interface PickerNavigation {
  path: CanonicalEdge[];
  redo: CanonicalEdge[];
}

function PositionPicker({
  repertoire,
  variationIndex,
  initialPath,
  onConfirm,
  onCancel,
  soundEnabled,
  onSoundToggle,
}: {
  repertoire: CanonicalRepertoire;
  variationIndex: VariationIndex;
  initialPath: CanonicalEdge[];
  onConfirm: (edges: CanonicalEdge[]) => void;
  onCancel: () => void;
  soundEnabled: boolean;
  onSoundToggle: () => void;
}) {
  const [showArrows, setShowArrows] = useState(true);
  const [navigation, setNavigation] = useState<PickerNavigation>({
    path: initialPath,
    redo: [],
  });
  const [message, setMessage] = useState('Move both sides to choose a stored position.');
  const { path, redo } = navigation;
  const position = path.at(-1)?.to ?? repertoire.rootPosition;
  const fen = fullFen(repertoire, position);
  const side = repertoire.positions[position]?.turn === 'b' ? 'black' : 'white';
  const variationArrows = useMemo(
    () => storedMoveArrows(repertoire, variationIndex, position),
    [position, repertoire, variationIndex],
  );
  const visibleAnnotations = useMemo(
    () => annotationsAfterEdge(repertoire, path.at(-1)),
    [path, repertoire],
  );

  const navigateBack = useCallback((amount: number) => {
    setNavigation((current) => {
      const count = Math.min(amount, current.path.length);
      if (count === 0) return current;
      const split = current.path.length - count;
      return {
        path: current.path.slice(0, split),
        redo: [...current.path.slice(split), ...current.redo],
      };
    });
    setMessage('Reviewing an earlier stored position.');
  }, []);

  const navigateForward = useCallback((amount: number) => {
    setNavigation((current) => {
      const count = Math.min(amount, current.redo.length);
      if (count === 0) return current;
      return {
        path: [...current.path, ...current.redo.slice(0, count)],
        redo: current.redo.slice(count),
      };
    });
    setMessage('Stored path restored.');
  }, []);

  const navigateHome = useCallback(() => {
    setNavigation((current) => ({
      path: [],
      redo: [...current.path, ...current.redo],
    }));
    setMessage('Opening root selected.');
  }, []);

  const navigateEnd = useCallback(() => {
    setNavigation((current) => ({
      path: [...current.path, ...current.redo],
      redo: [],
    }));
    setMessage('Latest entered position selected.');
  }, []);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const amount = event.shiftKey ? 2 : 1;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        navigateBack(amount);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        navigateForward(amount);
      } else if (event.key === 'Home') {
        event.preventDefault();
        navigateHome();
      } else if (event.key === 'End') {
        event.preventDefault();
        navigateEnd();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [navigateBack, navigateEnd, navigateForward, navigateHome, onCancel]);

  const move = (from: string, to: string, promotion: PromotionPiece | undefined): boolean => {
    let san: string;
    try { san = new Chess(fen).move({ from, to, promotion: promotion ?? 'q' }).san; } catch { return false; }
    const edge = Object.values(repertoire.edges).find((candidate) => candidate.from === position && candidate.san === san);
    if (!edge) { setMessage('This legal move is not included in the selected opening.'); return false; }
    setNavigation((current) => ({ path: [...current.path, edge], redo: [] }));
    setMessage('Stored path accepted.');
    return true;
  };
  return (
    <div
      className="picker-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Choose starting position on board"
    >
      <section className="picker-card">
        <h2>Choose starting position on board</h2>
        <p role="status">{message}</p>
        <div className="picker-board">
          <RepertoireBoard
            fen={fen}
            orientation={repertoire.openingSide === 'white' ? 'white' : 'black'}
            inputSide={side}
            onWhiteMove={move}
            storedVariationArrows={variationArrows}
            showArrows={showArrows}
            showStoredVariationArrows={showArrows}
            soundEnabled={soundEnabled}
          />
          <ArrowLegend stored />
        </div>
        <div className="picker-settings">
          <VariationSummary
            index={variationIndex}
            position={position}
            showMaximumDepth
          />
          <details className="position-notes">
            <summary>Annotations / Notes ({visibleAnnotations.length})</summary>
            {visibleAnnotations.map((note) => <p key={note.id}>{note.text}</p>)}
          </details>
          <p aria-label="Selected move sequence">
            {path.map((edge) => edge.san).join(' ') || 'Opening root'}
          </p>
          <div className="picker-actions">
            <button aria-pressed={showArrows} onClick={() => setShowArrows((value) => !value)}>
              Arrows
            </button>
            <button aria-pressed={soundEnabled} onClick={onSoundToggle}>Sound</button>
            <button disabled={!path.length} onClick={() => navigateBack(1)}>
              Previous move
            </button>
            <button disabled={!redo.length} onClick={() => navigateForward(1)}>
              Next move
            </button>
            <button onClick={() => setNavigation({ path: [], redo: [] })}>
              Reset
            </button>
            <button className="primary" onClick={() => onConfirm(path)}>
              Confirm position
            </button>
            <button onClick={onCancel}>Cancel</button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function OpeningWorkspace({
  repertoire,
  popularityPack = null,
  initialMode = 'book',
  onExit,
  explorerSources,
  random = Math.random,
}: {
  repertoire: CanonicalRepertoire;
  popularityPack?: PopularityPack | null;
  initialMode?: OpeningWorkspaceMode;
  onExit?: () => void;
  explorerSources?: Parameters<typeof ExplorerWorkspace>[0]['sources'];
  random?: () => number;
}) {
  const userState = useMemo(() => new UserStateStore(), []);
  const initialPracticeSetup = useMemo(
    () => restoredPracticeSetup(repertoire, userState),
    [repertoire, userState],
  );
  const variationIndex = useMemo(
    () => createVariationIndex(repertoire),
    [repertoire],
  );
  const [mode, setMode] = useState<OpeningWorkspaceMode>(initialMode);
  const [trainingMode, setTrainingMode] = useState<PracticeTrainingMode>('full-lines');
  const [scopeMode, setScopeMode] = useState<PracticeScopeMode>('fixed-depth');
  const [started, setStarted] = useState(initialMode === 'book');
  const [depth, setDepth] = useState(initialPracticeSetup.depth);
  const [useMaximumDepth, setUseMaximumDepth] = useState(initialPracticeSetup.max);
  const [importancePositions, setImportancePositions] = useState(30);
  const [history, setHistory] = useState<Ply[]>([]);
  const [viewIndex, setViewIndex] = useState(-1);
  const [position, setPosition] = useState(repertoire.rootPosition);
  const [status, setStatus] = useState(
    initialMode === 'book'
      ? 'Your opponent is to move'
      : 'Configure your practice session',
  );
  const [mistake, setMistake] = useState<string | null>(null);
  const [hints, setHints] = useState<0 | 1 | 2>(0);
  const [segmentDecisions, setSegmentDecisions] = useState(0);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [firstTry, setFirstTry] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editingStartingPath, setEditingStartingPath] = useState<number | null>(null);
  const [startingPaths, setStartingPaths] = useState<CanonicalEdge[][]>(initialPracticeSetup.paths);
  const [activeCandidate, setActiveCandidate] = useState<RepertoireMoveCandidate | null>(null);
  const [completion, setCompletion] = useState<PracticeCompletion | null>(null);
  const [lineProgress, setLineProgress] = useState<PracticeLineProgressMap>(
    () => userState.getPracticeLineProgress(repertoire.openingId),
  );
  const [moveProgress, setMoveProgress] = useState<PracticeLineProgressMap>(
    () => userState.getPracticeMoveProgress(repertoire.openingId),
  );
  const [activeLine, setActiveLine] = useState<PracticeLine | null>(null);
  const [activeItemHistoryStart, setActiveItemHistoryStart] = useState(initialPracticeSetup.paths[0]?.length ?? 0);
  const [previousLineId, setPreviousLineId] = useState<string | null>(null);
  const [runFailed, setRunFailed] = useState(false);
  const [exploringPractice, setExploringPractice] = useState(false);
  const [showArrows, setShowArrows] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [scheduler, setScheduler] = useState<PracticeSchedulerState>({ skipsSinceSeen: {} });
  const [moveTimerSeconds, setMoveTimerSeconds] = useState(0);
  const [timerState, setTimerState] = useState<MoveTimerState>({ key: null, duration: 0, remaining: 0, timedOut: false });
  const [documentVisible, setDocumentVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  const [resetProgressOpen, setResetProgressOpen] = useState(false);
  const [masteryReward, setMasteryReward] = useState(false);
  const completionRecorded = useRef(false);
  const repertoireTurn = repertoire.openingSide === 'white' ? 'w' : 'b';
  const latestIndex = history.length - 1;
  const viewingLatest = viewIndex === latestIndex;
  const viewedPosition =
    viewIndex >= 0
      ? history[viewIndex]?.position ?? position
      : repertoire.rootPosition;
  const currentFen =
    viewIndex >= 0
      ? history[viewIndex]?.fen ?? fullFen(repertoire, viewedPosition)
      : fullFen(repertoire, repertoire.rootPosition);
  const viewedTurn = repertoire.positions[viewedPosition]?.turn;
  const turn = repertoire.positions[position]?.turn;
  const currentDecision = repertoire.repertoireDecisionNodes[position];
  const practiceRoots = useMemo(
    () => [...new Set(startingPaths.map((path) => path.at(-1)?.to ?? repertoire.rootPosition))],
    [repertoire.rootPosition, startingPaths],
  );
  const maximumDepth = useMemo(
    () => Math.max(1, ...practiceRoots.map((root) => maximumTrainingDepth(variationIndex, root))),
    [practiceRoots, variationIndex],
  );
  const targetDepth = useMaximumDepth ? maximumDepth : Math.min(depth, maximumDepth);
  const importanceOrder = useMemo(
    () => {
      if (!popularityPack) return [];
      const defaultRoots = popularityPack.defaultRootPositions;
      const usesDefaultRoots = practiceRoots.length === defaultRoots.length &&
        practiceRoots.every((root, index) => root === defaultRoots[index]);
      return usesDefaultRoots
        ? popularityPack.importanceOrder
        : buildImportanceOrder(
            repertoire,
            practiceRoots,
            popularityPack.edgeGames,
            popularityPack.positionGames,
          );
    },
    [popularityPack, practiceRoots, repertoire],
  );
  const maximumImportancePositions = importanceOrder.length;
  const importanceBudgets = useMemo(
    () => importanceBudgetOptions(maximumImportancePositions),
    [maximumImportancePositions],
  );
  const targetImportancePositions = normalizeImportanceBudget(
    importancePositions,
    maximumImportancePositions,
  );
  const importanceBudgetIndex = Math.max(
    0,
    importanceBudgets.indexOf(targetImportancePositions),
  );
  const importanceScope = useMemo(
    () => popularityPack
      ? createImportanceScope(
          repertoire,
          practiceRoots,
          targetImportancePositions,
          popularityPack,
        )
      : null,
    [popularityPack, practiceRoots, repertoire, targetImportancePositions],
  );
  const practiceRepertoire = scopeMode === 'importance' && importanceScope
    ? importanceScope.repertoire
    : repertoire;
  const practiceDepthLimit = scopeMode === 'importance'
    ? Math.max(
        1,
        ...practiceRoots.map((root) => maximumPracticeDepth(practiceRepertoire, root)),
      )
    : targetDepth;
  const practiceContextSansByRoot = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const path of startingPaths) {
      const root = path.at(-1)?.to ?? repertoire.rootPosition;
      result[root] ??= path.map((edge) => edge.san);
    }
    return result;
  }, [repertoire.rootPosition, startingPaths]);
  const practiceLines = useMemo(
    () => {
      const items = [...new Map(practiceRoots.flatMap((root) =>
        createPracticeItems(
          practiceRepertoire,
          root,
          practiceDepthLimit,
          scopeMode === 'importance'
            ? { boundary: 'scope-end', continuationRepertoire: repertoire }
            : undefined,
        ),
      ).map((item) => [item.id, item])).values()];
      return pruneNestedPracticeItems(items, practiceContextSansByRoot);
    },
    [
      practiceContextSansByRoot,
      practiceDepthLimit,
      practiceRepertoire,
      practiceRoots,
      repertoire,
      scopeMode,
    ],
  );
  const movePracticeItems = useMemo(
    () => createMovePracticeItems(practiceRepertoire, practiceRoots, practiceDepthLimit),
    [practiceDepthLimit, practiceRepertoire, practiceRoots],
  );
  const exercisePly = Math.max(0, history.length - activeItemHistoryStart);
  const expectedPracticeEdge = activeLine
    ? repertoire.edges[activeLine.edgeIds[exercisePly] ?? ''] ?? null
    : null;
  const activePracticeLineCount = practiceLines.filter(
    (line) => practiceLineProgress(lineProgress, line.id).n > 0,
  ).length;
  const activeMovePracticeCount = movePracticeItems.filter(
    (item) => practiceLineProgress(moveProgress, item.id).n > 0,
  ).length;
  const canStartNextVariation = practiceLines.some(
    (line) => practiceLineProgress(lineProgress, line.id).n > 0,
  );
  const activeLineMastered = activeLine
    ? practiceLineProgress(lineProgress, activeLine.id).n === 0
    : false;
  const masteredPracticeLineCount = practiceLines.length - activePracticeLineCount;
  const masteryPercent = practiceLines.length > 0
    ? Math.round(masteredPracticeLineCount / practiceLines.length * 100)
    : 0;
  const timerTaskKey = mode === 'practice' && started && activeLine && expectedPracticeEdge && turn === repertoireTurn
    ? `${activeLine.id}:${exercisePly}:${position}`
    : null;
  const liveContinuations = storedContinuations(variationIndex, position);

  const reset = useCallback((nextMode: OpeningWorkspaceMode, completionReason: PracticeCompletionReason | null = null) => {
    setMode(nextMode); setStarted(nextMode === 'book'); setHistory([]);
    setPosition(repertoire.rootPosition); setViewIndex(-1); setStatus(nextMode === 'book' ? 'Your opponent is to move' : nextMode === 'practice' ? 'Configure your practice session' : 'Explore all stored theory');
    setMistake(null); setHints(0); setSegmentDecisions(0); setStats(EMPTY_STATS); setFirstTry(true); setActiveCandidate(null);
    setActiveLine(null); setActiveItemHistoryStart(0); setRunFailed(false); setExploringPractice(false);
    setCompletion(nextMode === 'practice' && completionReason ? { reason: completionReason, canContinueCurrentLine: false } : null);
    completionRecorded.current = false;
  }, [repertoire.rootPosition]);

  const applyEdge = useCallback((edge: CanonicalEdge, automatic: boolean, candidate: RepertoireMoveCandidate | null = null) => {
    setHistory((items) => {
      const next = [...items, { fen: fullFen(repertoire, edge.to), position: edge.to, edgeId: edge.id, san: edge.san, automatic }];
      setViewIndex(next.length - 1);
      return next;
    });
    setPosition(edge.to); setHints(0);
    setActiveCandidate(candidate);
  }, [repertoire]);

  const triggerMasteryReward = useCallback(() => {
    setMasteryReward(true);
  }, []);

  const recordPracticeMistake = useCallback((message?: string) => {
    setRunFailed(true);
    setFirstTry(false);
    setStats((value) => ({ ...value, mistakes: value.mistakes + 1 }));
    if (message) {
      setMistake(message);
      setStatus(message);
    }
    if (!activeLine) return;
    setLineProgress((current) => {
      const next = penalizePracticeLine(current, activeLine.id);
      userState.setPracticeLineProgress(repertoire.openingId, next);
      return next;
    });
  }, [activeLine, repertoire.openingId, userState]);

  const completeExercise = useCallback((reason: PracticeCompletionReason) => {
    if (completionRecorded.current) return;
    completionRecorded.current = true;
    setCompletion({
      reason,
      canContinueCurrentLine: Boolean(activeLine && activeLine.theoryEdgeIds.length > activeLine.edgeIds.length),
    });
    if (activeLine) {
      setLineProgress((current) => {
        const before = practiceLineProgress(current, activeLine.id);
        const next = completePracticeLineRun(current, activeLine.id, !runFailed);
        userState.setPracticeLineProgress(repertoire.openingId, next);
        if (before.n > 0 && practiceLineProgress(next, activeLine.id).n === 0) {
          triggerMasteryReward();
        }
        return next;
      });
    }
    setStats((value) => ({ ...value, completed: value.completed + 1 }));
    setStatus(reason === 'unresolved-repertoire-decision' ? 'Unresolved repertoire decision' : 'Line complete');
  }, [activeLine, repertoire.openingId, runFailed, triggerMasteryReward, userState]);

  useEffect(() => {
    if (!mistake) return;
    const timer = window.setTimeout(() => setMistake(null), 900);
    return () => window.clearTimeout(timer);
  }, [mistake]);

  useEffect(() => {
    if (!masteryReward) return;
    const timer = window.setTimeout(() => setMasteryReward(false), 950);
    return () => window.clearTimeout(timer);
  }, [masteryReward]);

  useEffect(() => {
    const updateVisibility = () => setDocumentVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  useEffect(() => {
    setTimerState((current) => {
      if (timerTaskKey === current.key && current.duration === moveTimerSeconds) {
        return current;
      }
      return {
        key: timerTaskKey,
        duration: moveTimerSeconds,
        remaining: timerTaskKey && moveTimerSeconds > 0 ? moveTimerSeconds : 0,
        timedOut: false,
      };
    });
  }, [moveTimerSeconds, timerTaskKey]);

  useEffect(() => {
    const timerActive = Boolean(
      timerTaskKey &&
      timerState.key === timerTaskKey &&
      moveTimerSeconds > 0 &&
      timerState.remaining > 0 &&
      !timerState.timedOut &&
      viewingLatest &&
      documentVisible &&
      !pickerOpen &&
      !resetProgressOpen &&
      !exploringPractice &&
      !completion,
    );
    if (!timerActive) return;
    const timer = window.setTimeout(() => {
      setTimerState((current) => current.key === timerTaskKey
        ? { ...current, remaining: Math.max(0, current.remaining - 1) }
        : current);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [completion, documentVisible, exploringPractice, moveTimerSeconds, pickerOpen, resetProgressOpen, timerState, timerTaskKey, viewingLatest]);

  useEffect(() => {
    if (
      !timerTaskKey ||
      timerState.key !== timerTaskKey ||
      timerState.remaining !== 0 ||
      timerState.timedOut ||
      moveTimerSeconds === 0
    ) return;
    setTimerState((current) => current.key === timerTaskKey
      ? { ...current, timedOut: true }
      : current);
    recordPracticeMistake("Time's up");
  }, [moveTimerSeconds, recordPracticeMistake, timerState, timerTaskKey]);

  useEffect(() => {
    if (!started || !viewingLatest || completion) return;
    if (mode === 'book' && turn === repertoireTurn) {
      if (liveContinuations.length === 0) {
        setStatus('Line complete');
        return;
      }
      if (liveContinuations.length > 1) {
        setStatus('Choose one of the stored repertoire branches');
        return;
      }
      const edge = repertoire.edges[liveContinuations[0]!.edgeIds[0]!];
      if (!edge) return;
      setStatus('The book is responding');
      const candidate = currentDecision?.candidates.find((item) => item.edgeId === edge.id) ?? null;
      const timer = window.setTimeout(() => { applyEdge(edge, true, candidate); setStatus('Your opponent is to move'); }, 350);
      return () => window.clearTimeout(timer);
    }
    if (mode === 'practice' && activeLine) {
      if (!expectedPracticeEdge || expectedPracticeEdge.from !== position) {
        completeExercise(
          segmentDecisions >= practiceDepthLimit &&
          activeLine.theoryEdgeIds.length > activeLine.edgeIds.length
            ? 'target-depth-reached'
            : 'stored-line-ended',
        );
        return;
      }
      if (turn !== repertoireTurn) {
        const timer = window.setTimeout(() => {
          applyEdge(expectedPracticeEdge, true);
          setFirstTry(true);
          setStatus('Play your repertoire move');
        }, 350);
        return () => window.clearTimeout(timer);
      }
      setStatus((current) => current === 'Not in this line — try again' || current === "Time's up"
        ? current
        : 'Play your repertoire move');
    }
  }, [activeLine, applyEdge, completeExercise, completion, currentDecision, expectedPracticeEdge, liveContinuations, mode, position, practiceDepthLimit, repertoire.edges, repertoireTurn, segmentDecisions, started, turn, viewingLatest]);

  const handleMove = (from: string, to: string, promotion: PromotionPiece | undefined): boolean => {
    let move;
    try { move = new Chess(currentFen).move({ from, to, promotion: promotion ?? 'q' }); } catch { return false; }
    const edge = Object.values(repertoire.edges).find((item) => item.from === position && item.san === move.san);
    if (mode === 'book') {
      if (!edge) { setStatus('This move is not included in the repertoire'); return false; }
      const candidate = currentDecision?.candidates.find((item) => item.edgeId === edge.id) ?? null;
      applyEdge(edge, false, candidate); return true;
    }
    if (!expectedPracticeEdge) return false;
    setStats((value) => ({ ...value, attempted: value.attempted + 1 }));
    if (!edge || edge.id !== expectedPracticeEdge.id) {
      recordPracticeMistake('Not in this line — try again');
      return false;
    }
    const candidate = currentDecision?.candidates.find((item) => item.edgeId === edge.id) ?? null;
    applyEdge(edge, false, candidate);
    setSegmentDecisions((value) => advancePracticeProgress(value, 'correct-repertoire-move'));
    if (firstTry) setStats((value) => ({ ...value, firstTry: value.firstTry + 1 }));
    return true;
  };

  const showHint = () => {
    if (!expectedPracticeEdge) return;
    const next = hints === 0 ? 1 : 2;
    setHints(next);
    setStats((value) => ({ ...value, hint1: value.hint1 + (next === 1 ? 1 : 0), hint2: value.hint2 + (next === 2 ? 1 : 0) }));
    setStatus(next === 1 ? 'Hint 1: source piece highlighted' : 'Hint 2: move arrow shown');
  };
  const reveal = () => {
    if (!expectedPracticeEdge) return;
    const edge = expectedPracticeEdge;
    if (edge) {
      const candidate = currentDecision?.candidates.find((item) => item.edgeId === edge.id) ?? null;
      recordPracticeMistake();
      applyEdge(edge, true, candidate);
      setSegmentDecisions((value) => advancePracticeProgress(value, 'shown-solution'));
      setStatus('Solution shown. Continuing the stored line.');
    }
  };
  const continueCurrentLine = () => {
    if (!completion?.canContinueCurrentLine || mistake || !viewingLatest || !activeLine) return;
    const remainingTheoryPath = activeLine.theoryEdgeIds.slice(activeLine.edgeIds.length);
    const continuationItems = createPracticeItems(
      practiceRepertoire,
      position,
      practiceDepthLimit,
    );
    const nextItem = continuationItems.find(
      (item) => item.edgeIds.every((edgeId, index) => edgeId === remainingTheoryPath[index]),
    ) ?? continuationItems[0];
    if (!nextItem) {
      setStatus('No stored continuation is available for this practice line.');
      return;
    }
    completionRecorded.current = false;
    setActiveLine(nextItem);
    setActiveItemHistoryStart(history.length);
    setCompletion(null); setSegmentDecisions(0); setHints(0); setFirstTry(true); setRunFailed(false);
    setStatus(turn === repertoireTurn ? 'Play your repertoire move' : 'Your opponent is to move');
  };
  const resetExerciseToPracticeRoot = (line: PracticeLine | null) => {
    const root = line?.rootPosition ?? practiceRoots[0] ?? repertoire.rootPosition;
    const startingPath = startingPaths.find(
      (path) => (path.at(-1)?.to ?? repertoire.rootPosition) === root,
    ) ?? [];
    const context = startingPath.map((edge) => ({
      fen: fullFen(repertoire, edge.to),
      position: edge.to,
      edgeId: edge.id,
      san: edge.san,
      automatic: false,
    }));
    setHistory(context); setViewIndex(context.length - 1); setPosition(root);
    setActiveItemHistoryStart(context.length);
    setSegmentDecisions(0);
    setMistake(null); setHints(0); setFirstTry(true); setActiveCandidate(null); setCompletion(null);
    setActiveLine(line); setRunFailed(false);
    completionRecorded.current = false;
    setStarted(true);
    setStatus((repertoire.positions[root]?.turn ?? 'w') === repertoireTurn ? 'Play your repertoire move' : 'Your opponent is to move');
  };
  const startPractice = () => {
    setStats(EMPTY_STATS);
    if (trainingMode === 'random-recall') {
      if (activeMovePracticeCount === 0) {
        setStatus('All recall moves at this depth are mastered.');
        return;
      }
      setStarted(true);
      setStatus('Find the repertoire move');
      return;
    }
    const selection = selectPracticeItem(practiceLines, lineProgress, scheduler, random, previousLineId);
    setScheduler(selection.state);
    const line = selection.item;
    if (!line) { setStatus('All practice lines at this depth are mastered.'); return; }
    setPreviousLineId(line.id);
    resetExerciseToPracticeRoot(line);
  };
  const nextVariation = () => {
    if (!completion || mistake || !viewingLatest || !canStartNextVariation) return;
    const selection = selectPracticeItem(practiceLines, lineProgress, scheduler, random, activeLine?.id ?? previousLineId);
    setScheduler(selection.state);
    const line = selection.item;
    if (!line) { setStatus('All practice lines at this depth are mastered.'); return; }
    setPreviousLineId(line.id);
    resetExerciseToPracticeRoot(line);
  };
  const endCurrentExercise = () => {
    const reason = classifyPracticeCompletion(repertoire, position, false, true);
    reset('practice', reason);
  };
  const markUnderstood = () => {
    if (!activeLine) return;
    if (practiceLineProgress(lineProgress, activeLine.id).n === 0) return;
    setLineProgress((current) => {
      if (practiceLineProgress(current, activeLine.id).n === 0) return current;
      const next = markPracticeLineUnderstood(current, activeLine.id);
      userState.setPracticeLineProgress(repertoire.openingId, next);
      triggerMasteryReward();
      return next;
    });
    setStatus('Practice line marked as understood.');
  };
  const coords = expectedPracticeEdge ? moveCoordinates(currentFen, expectedPracticeEdge.san) : null;
  const hintAnnotations = useMemo<ChesslyBoardAnnotation[]>(() => coords && hints ? [{
    highlights: { opportunities: [coords.from], threats: [] },
  }] : [], [coords, hints]);
  const practiceHintArrows = useMemo<BoardLayerArrow[]>(
    () => coords && hints === 2
      ? [{
          id: `practice-hint-${coords.from}-${coords.to}`,
          fromSquare: coords.from,
          toSquare: coords.to,
          ...(expectedPracticeEdge ? { san: expectedPracticeEdge.san } : {}),
        }]
      : [],
    [coords, expectedPracticeEdge, hints],
  );
  const showBookStoredContinuations = mode === 'book' && viewedTurn !== undefined;
  const bookStoredArrows = useMemo(
    () => showBookStoredContinuations
      ? storedMoveArrows(repertoire, variationIndex, viewedPosition)
      : [],
    [
      repertoire,
      showBookStoredContinuations,
      variationIndex,
      viewedPosition,
    ],
  );
  const explanationNotes = activeCandidate?.explanationIds.flatMap((id) =>
    Object.values(repertoire.positions).flatMap((item) => item.annotations).filter((item) => item.id === id),
  ) ?? [];
  const planNotes = activeCandidate?.planIds.flatMap((id) =>
    repertoire.positions[position]?.annotations.filter((item) => item.id === id) ?? [],
  ) ?? [];
  const visibleMoveAnnotations = useMemo(
    () => annotationsAfterEdge(
      repertoire,
      repertoire.edges[history[viewIndex]?.edgeId ?? ''],
    ),
    [history, repertoire, viewIndex],
  );
  const courseAnnotations = useMemo<ChesslyBoardAnnotation[]>(
    () => visibleMoveAnnotations.map(
      (note) => ({ arrows: note.arrows, highlights: note.highlights }),
    ),
    [visibleMoveAnnotations],
  );

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (pickerOpen || isEditableTarget(event.target)) return;
      if (mode === 'practice' && (event.key === 'h' || event.key === 'H')) { event.preventDefault(); showHint(); }
      if (mode === 'practice' && started && !completion && (event.key === 'Backspace' || event.key === 'Delete')) {
        event.preventDefault(); reveal();
      }
      if (mode === 'practice' && completion && event.key === 'Enter') {
        event.preventDefault(); nextVariation();
      }
      if (mode === 'practice' && started && (event.key === 'e' || event.key === 'E')) {
        event.preventDefault();
        setExploringPractice(true);
      }
      if (event.key === 'Home') { event.preventDefault(); setViewIndex(-1); }
      if (event.key === 'End') { event.preventDefault(); setViewIndex(latestIndex); }
      if (event.key === 'ArrowUp') { event.preventDefault(); setViewIndex(-1); }
      if (event.key === 'ArrowDown') { event.preventDefault(); setViewIndex(latestIndex); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); setViewIndex((value) => Math.max(-1, value - (event.shiftKey ? 2 : 1))); }
      if (event.key === 'ArrowRight') { event.preventDefault(); setViewIndex((value) => Math.min(latestIndex, value + (event.shiftKey ? 2 : 1))); }
      if (event.key === 'Escape' && onExit) { event.preventDefault(); onExit(); }
    };
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener);
  });

  const currentExplorerSources = explorerSources ?? [{
    openingId: repertoire.openingId,
    title: repertoire.title,
    repertoireSide: repertoire.openingSide,
    repertoire,
  }];

  if (exploringPractice) {
    return <ExplorerWorkspace
      title={`${repertoire.title} · Practice position`}
      sources={currentExplorerSources}
      initialFen={currentFen}
      onExit={() => setExploringPractice(false)}
      exitLabel="Back to Practice"
      soundEnabled={soundEnabled}
      onSoundToggle={() => setSoundEnabled((value) => !value)}
    />;
  }

  if (mode === 'explorer') {
    return <ExplorerWorkspace
      title={repertoire.title}
      sources={currentExplorerSources}
      onExit={onExit ?? (() => reset('book'))}
    />;
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">♜</span><div><p>OPENING LIBRARY</p><strong>{repertoire.title}</strong></div></div>
      <div className="course-meta"><span>Repertoire side: {repertoire.openingSide}</span><span className="data-badge">{repertoire.summary.studies} studies</span></div>
    </header>
    <div className="mode-bar" aria-label="Choose a mode">
      <button aria-pressed={mode === 'book'} className={mode === 'book' ? 'active' : ''} onClick={() => reset('book')}>Book Mode</button>
      <button aria-pressed={mode === 'practice'} className={mode === 'practice' ? 'active' : ''} onClick={() => {
        if (mode === 'practice' && started && !completion) endCurrentExercise();
        else reset('practice');
      }}>Practice Mode</button>
      <button aria-pressed={false} onClick={() => reset('explorer')}>Explorer</button>
    </div>
    {started && mode === 'practice' ? <div className="practice-progress" role="status">
      <div><strong>Mastered {masteredPracticeLineCount} / {practiceLines.length}</strong><span>{activePracticeLineCount} remaining</span>{moveTimerSeconds > 0 && timerState.key === timerTaskKey && !timerState.timedOut ? <span className="move-timer">{timerState.remaining}s</span> : null}</div>
      <progress aria-label="Practice mastery" max={Math.max(1, practiceLines.length)} value={masteredPracticeLineCount}>{masteryPercent}%</progress>
    </div> : null}
    {!started && mode === 'practice' ? <section className="practice-setup">
      <p className="eyebrow">Practice setup</p>
      <h1>Train {repertoire.title}</h1>
      <p>Opening: {repertoire.title} · Repertoire side: {repertoire.openingSide}</p>
      <fieldset className="training-type"><legend>Training type</legend><button aria-pressed={trainingMode === 'full-lines'} onClick={() => setTrainingMode('full-lines')}><strong>Full Lines</strong><span>Recall complete scope-bounded sequences.</span></button><button aria-pressed={trainingMode === 'random-recall'} onClick={() => setTrainingMode('random-recall')}><strong>Random Move Recall</strong><span>Find one repertoire move from a random position.</span></button></fieldset>
      <fieldset className="training-type training-scope"><legend>Training scope</legend><button aria-pressed={scopeMode === 'fixed-depth'} onClick={() => setScopeMode('fixed-depth')}><strong>Fixed depth</strong><span>Train every variation to the same decision depth.</span></button><button aria-pressed={scopeMode === 'importance'} disabled={!popularityPack || maximumImportancePositions === 0} title={!popularityPack ? 'Popularity data not available for this opening yet.' : undefined} onClick={() => setScopeMode('importance')}><strong>Importance</strong><span>Learn common variations deeper and rare variations less deeply.</span></button></fieldset>
      <div className="selected-training-positions"><h2>Selected training positions</h2><ul>{startingPaths.map((path, index) => <li key={`${path.map((edge) => edge.id).join('-') || 'root'}-${index}`}><span><strong>Position {index + 1}</strong><small>{path.length ? path.map((edge) => edge.san).join(' ') : 'Opening root'}</small></span><div><button onClick={() => { setEditingStartingPath(index); setPickerOpen(true); }}>Change</button><button disabled={startingPaths.length === 1} onClick={() => {
        const next = startingPaths.filter((_, pathIndex) => pathIndex !== index);
        setStartingPaths(next);
        userState.setPracticeStartingPositions(repertoire.openingId, next.map((item) => ({ edgeIds: item.map((edge) => edge.id) })));
      }}>Remove</button></div></li>)}</ul><button onClick={() => { setEditingStartingPath(null); setPickerOpen(true); }}>+ Add position</button></div>
      {scopeMode === 'fixed-depth' ? <>
        <label className="range-setting"><span>Training depth: <strong>{targetDepth}</strong></span><input aria-label="Training depth" type="range" min="1" max={Math.max(1, maximumDepth)} step="1" value={Math.max(1, targetDepth)} onChange={(event) => { setUseMaximumDepth(false); setDepth(Number(event.target.value)); }} /></label>
        <p>Relative to the selected starting position · maximum {maximumDepth}</p>
      </> : <>
        <label className="range-setting"><span>Positions: <strong>{targetImportancePositions}</strong></span><input aria-label="Importance positions" aria-valuetext={`${targetImportancePositions} positions`} type="range" min="0" max={Math.max(0, importanceBudgets.length - 1)} step="1" value={importanceBudgetIndex} onChange={(event) => setImportancePositions(importanceBudgets[Number(event.target.value)] ?? targetImportancePositions)} /></label>
        <p>Importance maximum: {maximumImportancePositions} unique positions across all selected roots.</p>
        {importanceScope ? <dl className="importance-summary" aria-label="Importance scope summary"><div><dt>Positions</dt><dd>{importanceScope.summary.positions}</dd></div><div><dt>Theory branches represented</dt><dd>{importanceScope.summary.branches}</dd></div><div><dt>Deepest branch</dt><dd>{importanceScope.summary.deepestBranchPlies} plies</dd></div><div><dt>Lowest repertoire reach</dt><dd>{REACH_PERCENT_FORMAT.format(importanceScope.summary.lowestRepertoireReach)}</dd></div></dl> : null}
      </>}
      <label className="range-setting"><span>Move timer: <strong>{moveTimerSeconds === 0 ? 'Off' : `${moveTimerSeconds} s`}</strong></span><input aria-label="Move timer" type="range" min="0" max="15" step="1" value={moveTimerSeconds} onChange={(event) => setMoveTimerSeconds(Number(event.target.value))} /></label>
      <p>{trainingMode === 'full-lines' ? `${activePracticeLineCount} active practice lines · ${practiceLines.length - activePracticeLineCount} mastered in this scope` : `${activeMovePracticeCount} active recall moves · ${movePracticeItems.length - activeMovePracticeCount} mastered in this scope`}</p>
      {trainingMode === 'full-lines' && !canStartNextVariation ? <p role="status">All practice lines at this depth are mastered.</p> : null}
      {trainingMode === 'random-recall' && activeMovePracticeCount === 0 ? <p role="status">All recall moves at this depth are mastered.</p> : null}
      {completion?.reason === 'user-ended-exercise' ? <p role="status">Previous exercise: {COMPLETION_LABELS[completion.reason]}</p> : null}
      <div className="setup-actions"><button className="primary" onClick={startPractice} disabled={trainingMode === 'full-lines' ? !canStartNextVariation : activeMovePracticeCount === 0}>Start practice</button><button onClick={() => setResetProgressOpen(true)} disabled={(trainingMode === 'full-lines' ? practiceLines : movePracticeItems).length === 0}>Reset training progress</button></div>
    </section> : mode === 'practice' && trainingMode === 'random-recall' ? <RandomRecallSession
      repertoire={practiceRepertoire}
      items={movePracticeItems}
      progress={moveProgress}
      onProgressChange={(next) => { setMoveProgress(next); userState.setPracticeMoveProgress(repertoire.openingId, next); }}
      timerSeconds={moveTimerSeconds}
      random={random}
      onBackToSetup={() => reset('practice')}
      explorerSources={currentExplorerSources}
      soundEnabled={soundEnabled}
      onSoundToggle={() => setSoundEnabled((value) => !value)}
    /> : <main className="workspace">
      <section className="board-column">
        <div className={`board-frame${masteryReward ? ' mastery-flash' : ''}`}>
          <div className="board-status"><span className="status-dot"/><span>{viewingLatest ? status : 'Reviewing an earlier position'}</span></div>
          {masteryReward ? <div className="mastery-reward" role="status" aria-live="polite"><strong>✓ Line mastered</strong><span aria-hidden="true">✦</span><span aria-hidden="true">✧</span><span aria-hidden="true">✦</span></div> : null}
          <RepertoireBoard
            fen={currentFen}
            orientation={repertoire.openingSide === 'white' ? 'white' : 'black'}
            inputSide={viewedTurn === 'b' ? 'black' : 'white'}
            allowWhiteInput={viewingLatest && started && !completion && (mode === 'book'
              ? turn !== repertoireTurn || liveContinuations.length > 1
              : turn === repertoireTurn && Boolean(expectedPracticeEdge))}
            onWhiteMove={handleMove}
            annotations={hintAnnotations}
            courseAnnotations={hints ? [] : courseAnnotations}
            storedVariationArrows={bookStoredArrows}
            practiceHintArrows={practiceHintArrows}
            showArrows={showArrows}
            showStoredVariationArrows={showArrows}
            showPracticeHintArrows
            soundEnabled={soundEnabled}
          />
          <ArrowLegend
            course={!hints && courseAnnotations.length > 0}
            stored={bookStoredArrows.length > 0}
            hint={practiceHintArrows.length > 0}
          />
        </div>
        <nav className="toolbar" aria-label="Board navigation">
          <button onClick={() => {
            if (mode === 'practice' && started && !completion) endCurrentExercise();
            else reset(mode);
          }}>↺ <span>Restart</span></button>
          <button onClick={() => setViewIndex((value) => Math.max(-1, value - 1))} disabled={viewIndex < 0}>← <span>Previous</span></button>
          <button onClick={() => setViewIndex((value) => Math.min(latestIndex, value + 1))} disabled={viewingLatest}>→ <span>Next</span></button>
          <button aria-pressed={showArrows} title="Show or hide passive board arrows" onClick={() => setShowArrows((value) => !value)}>↗ <span>Arrows</span></button>
          <button aria-pressed={soundEnabled} title="Turn move sounds on or off" onClick={() => setSoundEnabled((value) => !value)}>♬ <span>Sound</span></button>
          {mode === 'practice' ? <>
            <button onClick={showHint} disabled={!expectedPracticeEdge || Boolean(completion)}>H <span>{hints ? 'Hint 2' : 'Hint 1'}</span></button>
            <button onClick={reveal} disabled={!expectedPracticeEdge || Boolean(completion)}>✓ <span>Show solution</span></button>
            <button onClick={() => {
              setExploringPractice(true);
            }}>E <span>Explore this position</span></button>
            <button onClick={markUnderstood} disabled={!activeLine || activeLineMastered} aria-pressed={activeLineMastered}>✓ <span>{activeLineMastered ? 'Line understood' : 'Mark line as understood'}</span></button>
          </> : null}
        </nav>
        <section className="line-card"><p className="eyebrow">Current line</p><h2>Move sequence</h2><MoveList sans={history.map((item) => item.san)}/></section>
      </section>
      <aside className="book-panel">
        <div className="book-panel-header"><div><p className="eyebrow">{mode}</p><h1>{status}</h1></div></div>
        {showBookStoredContinuations ? (
          <StoredContinuations
            index={variationIndex}
            position={viewedPosition}
          />
        ) : null}
        {mistake ? <p className="practice-retry" role="status">{mistake}</p> : null}
        {completion && mode === 'practice' ? <section className="book-section practice-completion" aria-label="Practice completion actions">
          <div className="completion-heading"><div><p className="eyebrow">Exercise complete</p><h2>{runFailed ? 'Keep building recall' : 'Well played'}</h2></div><span>{masteredPracticeLineCount} / {practiceLines.length} mastered</span></div>
          <div className="practice-completion-actions">
            {canStartNextVariation ? <button className="primary" onClick={nextVariation} disabled={!viewingLatest}>Next variation</button> : null}
            {completion.canContinueCurrentLine ? <button onClick={continueCurrentLine} disabled={!viewingLatest}>Continue this line</button> : null}
            {activeLine ? <button onClick={markUnderstood} disabled={activeLineMastered} aria-pressed={activeLineMastered}>✓ {activeLineMastered ? 'Line understood' : 'Mark line as understood'}</button> : null}
            <button className="text-button" onClick={() => reset('practice')}>Back to setup</button>
            {!canStartNextVariation ? <div className="all-mastered-message">
              <p role="status">All practice lines at this depth are mastered.</p>
              {scopeMode === 'fixed-depth' && targetDepth < maximumDepth ? <button onClick={() => {
                setUseMaximumDepth(false);
                setDepth(targetDepth + 1);
                reset('practice');
              }}>Increase training depth</button> : null}
            </div> : null}
          </div>
          <details className="practice-details"><summary>Session details</summary><dl className="practice-summary">
            <div><dt>Completion</dt><dd>{COMPLETION_LABELS[completion.reason]}</dd></div>
            <div><dt>Moves attempted</dt><dd>{stats.attempted}</dd></div>
            <div><dt>Correct first try</dt><dd>{stats.firstTry}</dd></div>
            <div><dt>Mistakes</dt><dd>{stats.mistakes}</dd></div>
            <div><dt>Hints</dt><dd>{stats.hint1 + stats.hint2}</dd></div>
            <div><dt>Completed exercises</dt><dd>{stats.completed}</dd></div>
          </dl></details>
        </section> : activeCandidate ? <>
          <section className="book-section"><p className="eyebrow">Move explanation</p><h2>Why this move?</h2>{explanationNotes.length ? explanationNotes.map((note) => <p key={note.id}>{note.text}</p>) : <p className="empty-copy">No separate explanation is stored for this move.</p>}</section>
          <section className="book-section"><p className="eyebrow">Resulting position</p><h2>Plans from this position</h2>{planNotes.length ? planNotes.map((note) => <p key={note.id}>{note.text}</p>) : <p className="empty-copy">No separate plan is stored for this position.</p>}</section>
        </> : <section className="welcome-page"><p className="eyebrow">No engine</p><h2>{mode === 'book' ? 'Explore the stored opening tree.' : 'Recall your repertoire moves.'}</h2><p>Every automatic move comes exclusively from this opening's stored repertoire graph.</p></section>}
        <details className="position-notes" open={mode === 'book'}>
          <summary>Annotations / Notes ({visibleMoveAnnotations.length})</summary>
          {visibleMoveAnnotations.length ? visibleMoveAnnotations.map((note) => <article key={note.id}><p>{note.text}</p><small>{note.sources.length === 1 ? `${note.sources[0]?.chapter} · ${note.sources[0]?.study}` : `Used in ${note.sources.length} studies`}</small>{note.sources.length > 1 ? <details><summary>Sources</summary>{[...new Set(note.sources.map((source) => `${source.chapter} · ${source.study}`))].map((source) => <span key={source}>{source}</span>)}</details> : null}</article>) : <p className="empty-copy">No stored note for the last move.</p>}
        </details>
      </aside>
    </main>}
    {pickerOpen ? <PositionPicker repertoire={repertoire} variationIndex={variationIndex} initialPath={editingStartingPath === null ? [] : startingPaths[editingStartingPath] ?? []} soundEnabled={soundEnabled} onSoundToggle={() => setSoundEnabled((value) => !value)} onCancel={() => { setPickerOpen(false); setEditingStartingPath(null); }} onConfirm={(edges) => {
      const candidates = editingStartingPath === null
        ? [...startingPaths, edges]
        : startingPaths.map((path, index) => index === editingStartingPath ? edges : path);
      const next = [...new Map(candidates.map((path) => [path.map((edge) => edge.id).join('|'), path])).values()];
      setStartingPaths(next);
      userState.setPracticeStartingPositions(repertoire.openingId, next.map((path) => ({ edgeIds: path.map((edge) => edge.id) })));
      setPickerOpen(false);
      setEditingStartingPath(null);
    }} /> : null}
    {resetProgressOpen ? <div className="confirmation-overlay"><section className="confirmation-card" role="alertdialog" aria-modal="true" aria-labelledby="reset-progress-title" aria-describedby="reset-progress-description">
      <h2 id="reset-progress-title">Reset training progress?</h2>
      <p id="reset-progress-description">Reset mastered {trainingMode === 'full-lines' ? 'lines' : 'moves'} and training counters for these starting positions and this depth?</p>
      <div><button onClick={() => setResetProgressOpen(false)}>Cancel</button><button className="danger" onClick={() => {
        if (trainingMode === 'full-lines') {
          setLineProgress((current) => {
            const next = resetPracticeItemProgress(current, practiceLines.map((item) => item.id));
            userState.setPracticeLineProgress(repertoire.openingId, next);
            return next;
          });
        } else {
          setMoveProgress((current) => {
            const next = resetPracticeItemProgress(current, movePracticeItems.map((item) => item.id));
            userState.setPracticeMoveProgress(repertoire.openingId, next);
            return next;
          });
        }
        setScheduler({ skipsSinceSeen: {} });
        setResetProgressOpen(false);
        setStatus('Training progress reset for this setup.');
      }}>Reset progress</button></div>
    </section></div> : null}
  </div>;
}
