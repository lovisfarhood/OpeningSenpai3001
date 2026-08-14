import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';

import { annotationsAfterEdge } from '../domain/annotations.js';
import {
  completePracticeLineRun,
  penalizePracticeLine,
  practiceLineProgress,
  selectPracticeItem,
  type MovePracticeItem,
  type PracticeLineProgressMap,
  type PracticeSchedulerState,
} from '../domain/practice.js';
import type { CanonicalRepertoire } from '../domain/repertoire.js';
import { ExplorerWorkspace } from './ExplorerWorkspace.js';
import { MoveList } from './MoveList.js';
import {
  RepertoireBoard,
  type BoardLayerArrow,
  type ChesslyBoardAnnotation,
  type PromotionPiece,
} from './RepertoireBoard.js';

interface RecallFeedback {
  type: 'correct' | 'wrong';
  message: string;
  lastItem: MovePracticeItem;
}

interface RecallTimerState {
  key: string | null;
  duration: number;
  remaining: number;
  timedOut: boolean;
}

function editable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement &&
    target.matches('input, textarea, select, [contenteditable="true"]');
}

export function RandomRecallSession({
  repertoire,
  items,
  progress,
  onProgressChange,
  timerSeconds,
  random,
  onBackToSetup,
  explorerSources,
  soundEnabled,
  onSoundToggle,
}: {
  repertoire: CanonicalRepertoire;
  items: readonly MovePracticeItem[];
  progress: PracticeLineProgressMap;
  onProgressChange: (progress: PracticeLineProgressMap) => void;
  timerSeconds: number;
  random: () => number;
  onBackToSetup: () => void;
  explorerSources: Parameters<typeof ExplorerWorkspace>[0]['sources'];
  soundEnabled: boolean;
  onSoundToggle: () => void;
}) {
  const initialSelection = useRef<{
    item: MovePracticeItem | null;
    state: PracticeSchedulerState;
  } | null>(null);
  if (!initialSelection.current) {
    initialSelection.current = selectPracticeItem(
      items,
      progress,
      { skipsSinceSeen: {} },
      random,
    );
  }
  const scheduler = useRef<PracticeSchedulerState>(initialSelection.current.state);
  const progressRef = useRef(progress);
  const [activeItem, setActiveItem] = useState<MovePracticeItem | null>(initialSelection.current.item);
  const [feedback, setFeedback] = useState<RecallFeedback | null>(null);
  const [displayFen, setDisplayFen] = useState(initialSelection.current.item?.fen ?? repertoire.positions[repertoire.rootPosition]?.fullFens[0] ?? repertoire.rootPosition);
  const [playedSans, setPlayedSans] = useState<string[]>([]);
  const [hints, setHints] = useState<0 | 1 | 2>(0);
  const [showArrows, setShowArrows] = useState(true);
  const [exploring, setExploring] = useState(false);
  const [masteryReward, setMasteryReward] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const [timer, setTimer] = useState<RecallTimerState>({ key: null, duration: 0, remaining: 0, timedOut: false });

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  const validItems = useMemo(
    () => activeItem ? items.filter((item) => item.position === activeItem.position) : [],
    [activeItem, items],
  );
  const activeCount = items.filter((item) => practiceLineProgress(progress, item.id).n > 0).length;
  const masteredCount = items.length - activeCount;

  const drawNext = useCallback((previous: MovePracticeItem | null) => {
    const selection = selectPracticeItem(
      items,
      progressRef.current,
      scheduler.current,
      random,
      previous?.id,
      new Set(previous?.adjacentItemIds ?? []),
    );
    scheduler.current = selection.state;
    setActiveItem(selection.item);
    setDisplayFen(selection.item?.fen ?? repertoire.positions[repertoire.rootPosition]?.fullFens[0] ?? repertoire.rootPosition);
    setPlayedSans([]);
    setHints(0);
    setFeedback(null);
  }, [items, random, repertoire]);

  const storeProgress = useCallback((next: PracticeLineProgressMap) => {
    progressRef.current = next;
    onProgressChange(next);
  }, [onProgressChange]);

  const failPrompt = useCallback((message: string) => {
    if (!activeItem || feedback) return;
    const next = penalizePracticeLine(progressRef.current, activeItem.id);
    storeProgress(next);
    setFeedback({
      type: 'wrong',
      message: `${message} Expected: ${validItems.map((item) => item.san).join(' or ')}`,
      lastItem: activeItem,
    });
    setHints(2);
  }, [activeItem, feedback, storeProgress, validItems]);

  const handleMove = (from: string, to: string, promotion: PromotionPiece | undefined): boolean => {
    if (!activeItem || feedback) return false;
    const chess = new Chess(activeItem.fen);
    let move;
    try {
      move = chess.move({ from, to, promotion: promotion ?? 'q' });
    } catch {
      return false;
    }
    const matched = validItems.find((item) => item.san === move.san);
    if (!matched) {
      failPrompt('Not a stored repertoire move.');
      return false;
    }
    const before = practiceLineProgress(progressRef.current, matched.id);
    const next = completePracticeLineRun(progressRef.current, matched.id, true);
    storeProgress(next);
    if (before.n > 0 && practiceLineProgress(next, matched.id).n === 0) {
      setMasteryReward(true);
    }
    setDisplayFen(chess.fen());
    setPlayedSans([move.san]);
    setFeedback({ type: 'correct', message: 'Correct — next position…', lastItem: matched });
    return true;
  };

  useEffect(() => {
    if (feedback?.type !== 'correct') return;
    const timeout = window.setTimeout(() => drawNext(feedback.lastItem), 650);
    return () => window.clearTimeout(timeout);
  }, [drawNext, feedback]);

  useEffect(() => {
    if (!masteryReward) return;
    const timeout = window.setTimeout(() => setMasteryReward(false), 950);
    return () => window.clearTimeout(timeout);
  }, [masteryReward]);

  useEffect(() => {
    const listener = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  }, []);

  const timerKey = activeItem && !feedback ? activeItem.id : null;
  useEffect(() => {
    setTimer((current) => current.key === timerKey && current.duration === timerSeconds
      ? current
      : {
          key: timerKey,
          duration: timerSeconds,
          remaining: timerKey && timerSeconds > 0 ? timerSeconds : 0,
          timedOut: false,
        });
  }, [timerKey, timerSeconds]);

  useEffect(() => {
    if (!timerKey || timer.key !== timerKey || timer.remaining <= 0 || timer.timedOut || timerSeconds === 0 || !visible || exploring || feedback) return;
    const timeout = window.setTimeout(() => setTimer((current) => current.key === timerKey
      ? { ...current, remaining: Math.max(0, current.remaining - 1) }
      : current), 1000);
    return () => window.clearTimeout(timeout);
  }, [exploring, feedback, timer, timerKey, timerSeconds, visible]);

  useEffect(() => {
    if (!timerKey || timer.key !== timerKey || timer.remaining !== 0 || timer.timedOut || timerSeconds === 0) return;
    setTimer((current) => current.key === timerKey ? { ...current, timedOut: true } : current);
    failPrompt("Time's up.");
  }, [failPrompt, timer, timerKey, timerSeconds]);

  const showHint = useCallback(() => {
    if (!activeItem || feedback) return;
    setHints((current) => current === 0 ? 1 : 2);
  }, [activeItem, feedback]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (editable(event.target)) return;
      if (event.key === 'h' || event.key === 'H') {
        event.preventDefault();
        showHint();
      } else if ((event.key === 'Backspace' || event.key === 'Delete') && !feedback) {
        event.preventDefault();
        failPrompt('Solution shown.');
      } else if (event.key === 'Enter' && feedback?.type === 'wrong') {
        event.preventDefault();
        drawNext(feedback.lastItem);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onBackToSetup();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [drawNext, failPrompt, feedback, onBackToSetup, showHint]);

  const hintAnnotations = useMemo<ChesslyBoardAnnotation[]>(
    () => hints > 0 && !feedback ? [{
      highlights: { opportunities: validItems.map((item) => item.from), threats: [] },
    }] : [],
    [feedback, hints, validItems],
  );
  const requestedArrows = useMemo<BoardLayerArrow[]>(
    () => hints === 2 || feedback?.type === 'wrong'
      ? validItems.map((item) => ({
          id: `recall-${item.id}`,
          fromSquare: item.from,
          toSquare: item.to,
          san: item.san,
          role: feedback?.type === 'wrong' ? 'solution' : 'hint',
        }))
      : [],
    [feedback, hints, validItems],
  );
  const lastMoveAnnotations = useMemo(
    () => feedback?.type === 'correct'
      ? annotationsAfterEdge(repertoire, repertoire.edges[feedback.lastItem.edgeId])
      : [],
    [feedback, repertoire],
  );
  const courseAnnotations = useMemo<ChesslyBoardAnnotation[]>(
    () => lastMoveAnnotations.map((annotation) => ({ arrows: annotation.arrows, highlights: annotation.highlights })),
    [lastMoveAnnotations],
  );

  if (exploring && activeItem) {
    return <ExplorerWorkspace
      title={`${repertoire.title} · Recall position`}
      sources={explorerSources}
      initialFen={activeItem.fen}
      onExit={() => setExploring(false)}
      exitLabel="Back to Practice"
    />;
  }

  return <main className="workspace recall-workspace">
    <section className="board-column">
      <div className={`board-frame${masteryReward ? ' mastery-flash' : ''}`}>
        <div className="board-status"><span className="status-dot"/><span>{feedback?.message ?? 'Find the repertoire move'}</span></div>
        {masteryReward ? <div className="mastery-reward" role="status"><strong>✓ Move mastered</strong><span aria-hidden="true">✦</span></div> : null}
        {activeItem ? <RepertoireBoard
          fen={displayFen}
          orientation={repertoire.openingSide === 'black' ? 'black' : 'white'}
          inputSide={repertoire.openingSide === 'black' ? 'black' : 'white'}
          allowWhiteInput={!feedback}
          onWhiteMove={handleMove}
          annotations={hintAnnotations}
          courseAnnotations={courseAnnotations}
          practiceHintArrows={requestedArrows}
          showArrows={showArrows}
          showStoredVariationArrows={showArrows}
          showPracticeHintArrows
          soundEnabled={soundEnabled}
        /> : <div className="recall-complete"><h2>All recall moves mastered</h2><button onClick={onBackToSetup}>Back to setup</button></div>}
      </div>
      <nav className="toolbar recall-toolbar" aria-label="Random Recall controls">
        <button onClick={showHint} disabled={!activeItem || Boolean(feedback)}>H <span>{hints ? 'Hint 2' : 'Hint 1'}</span></button>
        <button onClick={() => failPrompt('Solution shown.')} disabled={!activeItem || Boolean(feedback)}>⌫ <span>Show solution</span></button>
        <button aria-pressed={showArrows} onClick={() => setShowArrows((value) => !value)}>↗ <span>Arrows</span></button>
        <button aria-pressed={soundEnabled} onClick={onSoundToggle}>♬ <span>Sound</span></button>
        <button onClick={() => setExploring(true)} disabled={!activeItem}>E <span>Explore</span></button>
        <button onClick={onBackToSetup}>← <span>Setup</span></button>
      </nav>
      <section className="line-card"><p className="eyebrow">Last move</p><h2>Move sequence</h2><MoveList sans={playedSans} /></section>
    </section>
    <aside className="book-panel recall-panel">
      <div className="book-panel-header"><div><p className="eyebrow">Random Move Recall</p><h1>{activeItem ? 'What is your repertoire move?' : 'Session complete'}</h1></div></div>
      <section className="recall-progress"><strong>Mastered {masteredCount} / {items.length}</strong><span>{activeCount} remaining</span>{timerSeconds > 0 && timer.key === timerKey && !timer.timedOut ? <span>{timer.remaining}s</span> : null}</section>
      {feedback?.type === 'wrong' ? <section className="recall-feedback wrong" role="status"><h2>{feedback.message}</h2><p>Press Enter for next position</p><button className="primary" onClick={() => drawNext(feedback.lastItem)}>Next position</button></section> : null}
      {feedback?.type === 'correct' ? <section className="recall-feedback correct" role="status"><h2>Correct</h2><p>The next position will load automatically.</p></section> : null}
      <details className="position-notes" open={lastMoveAnnotations.length > 0}><summary>Annotation for the last move ({lastMoveAnnotations.length})</summary>{lastMoveAnnotations.map((annotation) => <article key={annotation.id}><p>{annotation.text}</p><small>{annotation.sources.length > 1 ? `Used in ${annotation.sources.length} studies` : annotation.sources[0]?.study}</small></article>)}</details>
    </aside>
  </main>;
}
