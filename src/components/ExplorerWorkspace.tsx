import { useCallback, useEffect, useMemo, useState } from 'react';
import { Chess } from 'chess.js';

import {
  createExplorerIndex,
  explorerAnnotationsAfterMove,
  explorerPosition,
  type ExplorerAnnotation,
  type ExplorerSource,
} from '../domain/explorer.js';
import type { ImportedPgn, PgnTheoryAnalysis } from '../domain/pgn.js';
import { analyzePgn } from '../domain/pgn.js';
import { MoveList } from './MoveList.js';
import { RepertoireBoard, type BoardLayerArrow, type PromotionPiece } from './RepertoireBoard.js';
import { ArrowLegend } from './VariationSummary.js';

interface ExplorerPly {
  fen: string;
  san: string;
  theory: boolean;
  annotations: readonly ExplorerAnnotation[];
}

function editable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement &&
    target.matches('input, textarea, select, [contenteditable="true"]');
}

function tooltip(move: ReturnType<typeof explorerPosition>['moves'][number]): string {
  return [
    move.san,
    `${move.variationCount} variations`,
    `${move.remainingDepth} plies remaining`,
    `Courses: ${move.courses.join(', ') || '—'}`,
    `Chapters: ${move.chapters.join(', ') || '—'}`,
    `Studies: ${move.studies.join(', ') || '—'}`,
  ].join('\n');
}

export function ExplorerWorkspace({
  title,
  sources,
  importedGame = null,
  initialFen: requestedInitialFen,
  onExit,
  exitLabel = 'Back to Library',
  soundEnabled: controlledSoundEnabled,
  onSoundToggle,
}: {
  title: string;
  sources: readonly ExplorerSource[];
  importedGame?: ImportedPgn | null;
  initialFen?: string;
  onExit?: () => void;
  exitLabel?: string;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
}) {
  const index = useMemo(() => createExplorerIndex(sources), [sources]);
  const initialFen = requestedInitialFen ?? importedGame?.initialFen ?? new Chess().fen();
  const analysis = useMemo<PgnTheoryAnalysis | null>(
    () => importedGame ? analyzePgn(importedGame, index) : null,
    [importedGame, index],
  );
  const initialHistory = useMemo<ExplorerPly[]>(
    () => analysis?.plies.map((move) => ({
      fen: move.after,
      san: move.san,
      theory: move.inTheory,
      annotations: explorerAnnotationsAfterMove(index, move.matchedMove),
    })) ?? [],
    [analysis, index],
  );
  const [history, setHistory] = useState<ExplorerPly[]>(initialHistory);
  const [viewIndex, setViewIndex] = useState(initialHistory.length - 1);
  const [showArrows, setShowArrows] = useState(true);
  const [localSoundEnabled, setLocalSoundEnabled] = useState(true);
  const soundEnabled = controlledSoundEnabled ?? localSoundEnabled;
  const toggleSound = onSoundToggle ?? (() => setLocalSoundEnabled((value) => !value));
  const [status, setStatus] = useState('Move either side. No engine and no automatic reply.');
  const currentFen = viewIndex < 0 ? initialFen : history[viewIndex]?.fen ?? initialFen;
  const theory = useMemo(
    () => explorerPosition(index, currentFen),
    [currentFen, index],
  );
  const arrows = useMemo<BoardLayerArrow[]>(() => theory.moves.map((move) => ({
    id: move.id,
    fromSquare: move.from,
    toSquare: move.to,
    san: move.san,
    tooltip: tooltip(move),
    role: move.role,
  })), [theory.moves]);
  const visibleAnnotations = useMemo(
    () => viewIndex < 0 ? [] : history[viewIndex]?.annotations ?? [],
    [history, viewIndex],
  );
  const courseAnnotations = useMemo(
    () => visibleAnnotations.map((annotation) => ({
      arrows: annotation.arrows,
      highlights: annotation.highlights,
    })),
    [visibleAnnotations],
  );
  const orientation = sources.every((source) => source.repertoireSide === 'black')
    ? 'black'
    : 'white';

  const back = useCallback((amount = 1) => {
    setViewIndex((current) => Math.max(-1, current - amount));
  }, []);
  const forward = useCallback((amount = 1) => {
    setViewIndex((current) => Math.min(history.length - 1, current + amount));
  }, [history.length]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (editable(event.target)) return;
      const amount = event.shiftKey ? 2 : 1;
      if (event.key === 'ArrowLeft') { event.preventDefault(); back(amount); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); forward(amount); }
      else if (event.key === 'ArrowUp' || event.key === 'Home') { event.preventDefault(); setViewIndex(-1); }
      else if (event.key === 'ArrowDown' || event.key === 'End') { event.preventDefault(); setViewIndex(history.length - 1); }
      else if (event.key === 'Escape' && onExit) { event.preventDefault(); onExit(); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [back, forward, history.length, onExit]);

  const move = (from: string, to: string, promotion: PromotionPiece | undefined): boolean => {
    const chess = new Chess(currentFen);
    let played;
    try { played = chess.move({ from, to, promotion: promotion ?? 'q' }); }
    catch { return false; }
    const matchedMove = theory.moves.find((candidate) => candidate.san === played.san) ?? null;
    const known = matchedMove !== null;
    const prefix = history.slice(0, viewIndex + 1);
    setHistory([...prefix, {
      fen: chess.fen(),
      san: played.san,
      theory: known,
      annotations: explorerAnnotationsAfterMove(index, matchedMove),
    }]);
    setViewIndex(prefix.length);
    setStatus(known ? 'Known theory move.' : 'Outside the stored theory. Move freely or undo.');
    return true;
  };

  return (
    <div className="app-shell explorer-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">♜</span><div><p>OPENING EXPLORER</p><strong>{title}</strong></div></div>
        <div className="course-meta"><span>No engine</span><span className="data-badge">{sources.length} referenced opening{sources.length === 1 ? '' : 's'}</span></div>
        {onExit ? <button type="button" className={`workspace-exit${exitLabel === 'Back to Practice' ? ' back-to-practice' : ''}`} onClick={onExit}>{exitLabel === 'Back to Practice' ? '← ' : ''}{exitLabel}</button> : null}
      </header>
      <main className="workspace explorer-workspace">
        <section className="board-column">
          <div className="board-frame">
            <div className="board-status"><span className="status-dot"/><span>{status}</span></div>
            <RepertoireBoard
              fen={currentFen}
              orientation={orientation}
              inputSide={theory.turn === 'w' ? 'white' : 'black'}
              onWhiteMove={move}
              storedVariationArrows={arrows}
              courseAnnotations={courseAnnotations}
              showArrows={showArrows}
              showStoredVariationArrows={showArrows}
              soundEnabled={soundEnabled}
            />
            <ArrowLegend explorerRoles course={courseAnnotations.length > 0} />
          </div>
          <nav className="toolbar" aria-label="Explorer navigation">
            <button onClick={() => { setHistory([]); setViewIndex(-1); }}>↺ <span>Reset</span></button>
            <button onClick={() => back()} disabled={viewIndex < 0}>← <span>Undo</span></button>
            <button onClick={() => forward()} disabled={viewIndex >= history.length - 1}>→ <span>Redo</span></button>
            <button aria-pressed={showArrows} title="Show or hide passive board arrows" onClick={() => setShowArrows((value) => !value)}>↗ <span>Arrows</span></button>
            <button aria-pressed={soundEnabled} title="Turn move sounds on or off" onClick={toggleSound}>♬ <span>Sound</span></button>
            <button onClick={() => setViewIndex(-1)}>Home</button>
            <button onClick={() => setViewIndex(history.length - 1)}>End</button>
          </nav>
          <section className="line-card"><p className="eyebrow">Current line</p><h2>Move sequence</h2><MoveList sans={history.slice(0, viewIndex + 1).map((item) => item.san)}/></section>
        </section>
        <aside className="book-panel explorer-panel">
          <div className="book-panel-header"><div><p className="eyebrow">{theory.turn === 'w' ? 'White' : 'Black'} to move</p><h1>Known theory moves</h1></div></div>
          <section className="explorer-metrics" aria-label="Explorer position summary"><dl>
            <div><dt>Stored continuations</dt><dd>{theory.moves.length}</dd></div>
            <div><dt>Complete variations</dt><dd>{theory.variationCount}</dd></div>
            <div><dt>Maximum remaining depth</dt><dd>{theory.remainingDepth}</dd></div>
            <div><dt>Courses</dt><dd>{theory.courses.length}</dd></div>
            <div><dt>Chapters</dt><dd>{theory.chapters.length}</dd></div>
            <div><dt>Studies</dt><dd>{theory.studies.length}</dd></div>
          </dl></section>
          <section className="stored-continuations explorer-moves" aria-label="Known theory moves">
            <h2>{theory.moves.length} move{theory.moves.length === 1 ? '' : 's'}</h2>
            {theory.moves.length ? <ul>{theory.moves.map((candidate) => <li key={candidate.id} title={tooltip(candidate)}>
              <strong>{candidate.san}</strong><span>{candidate.variationCount} variations · depth {candidate.remainingDepth}</span>
              <small>{candidate.courses.join(', ')}</small>
            </li>)}</ul> : <p className="empty-copy">No stored theory from this position.</p>}
          </section>
          <details><summary>Sources at this position</summary>
            <p><strong>Openings:</strong> {theory.openings.join(', ') || '—'}</p>
            <p><strong>Chapters:</strong> {theory.chapters.join(', ') || '—'}</p>
            <p><strong>Studies:</strong> {theory.studies.join(', ') || '—'}</p>
          </details>
          <details className="position-notes" open={Boolean(importedGame)}>
            <summary>Annotations / Notes ({visibleAnnotations.length})</summary>
            {visibleAnnotations.length ? visibleAnnotations.map((annotation) => (
              <article key={annotation.id}>
                <p>{annotation.text}</p>
                <small>{annotation.studies.length > 1 ? `Used in ${annotation.studies.length} studies` : `${annotation.opening} · ${annotation.chapters.join(', ')} · ${annotation.studies.join(', ')}`}</small>
                {annotation.studies.length > 1 ? <details><summary>Sources</summary><span>{annotation.opening} · {annotation.chapters.join(', ')} · {annotation.studies.join(', ')}</span></details> : null}
              </article>
            )) : <p className="empty-copy">No stored note for the last move.</p>}
          </details>
          {importedGame && viewIndex >= 0 && importedGame.moves[viewIndex]?.comment ? (
            <section className="book-section pgn-comment" aria-label="PGN comment">
              <p className="eyebrow">PGN comment</p>
              <p>{importedGame.moves[viewIndex]?.comment}</p>
            </section>
          ) : null}
          {analysis ? <section className="pgn-analysis" aria-label="PGN theory analysis">
            <p className="eyebrow">Imported game · no engine evaluation</p><h2>Theory coverage: {analysis.theoryPercentage}%</h2>
            <dl>
              <div><dt>Theory played through ply</dt><dd>{analysis.lastKnownPly ?? 0}</dd></div>
              <div><dt>Last known theory move</dt><dd>{analysis.lastKnownPly ? analysis.plies[analysis.lastKnownPly - 1]?.san : '—'}</dd></div>
              <div><dt>Deviation move</dt><dd>{analysis.deviationSan ?? 'None'}</dd></div>
              <div><dt>Meaning</dt><dd>{analysis.deviationSan ? 'Left repertoire theory (not a chess-mistake judgment)' : 'Stayed in stored repertoire theory'}</dd></div>
              <div><dt>Matched variations</dt><dd>{analysis.variationNames.join(', ') || '—'}</dd></div>
            </dl>
            <h3>Alternatives at deviation</h3><p>{analysis.alternatives.map((move) => move.san).join(', ') || 'No stored alternatives'}</p>
            <h3>Recommended training chapters</h3><p>{analysis.chapters.join(', ') || '—'}</p>
            <h3>Affected studies</h3><p>{analysis.studies.join(', ') || '—'}</p>
          </section> : null}
        </aside>
      </main>
    </div>
  );
}
