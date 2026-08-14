// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Chess } from 'chess.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCanonicalRepertoire } from '../../scripts/lib/build.js';
import { createFixtureStudy, createLoadedSources } from '../../tests/fixtures/repertoire-fixture.js';
import { createMovePracticeItems, type PracticeLineProgressMap } from '../domain/practice.js';
import type { CanonicalRepertoire } from '../domain/repertoire.js';
import { RandomRecallSession } from './RandomRecallSession.js';
import type { BoardLayerArrow, ChesslyBoardAnnotation, PromotionPiece } from './RepertoireBoard.js';

interface BoardMockProps {
  fen: string;
  allowWhiteInput?: boolean;
  courseAnnotations?: readonly ChesslyBoardAnnotation[] | null;
  practiceHintArrows?: readonly BoardLayerArrow[] | null;
  onWhiteMove: (from: string, to: string, promotion: PromotionPiece | undefined) => boolean;
}

const boardMock = vi.hoisted(() => ({ latest: null as BoardMockProps | null }));

vi.mock('./RepertoireBoard.js', () => ({
  RepertoireBoard: (props: BoardMockProps) => {
    boardMock.latest = props;
    return <div data-testid="recall-board" data-fen={props.fen} />;
  },
}));

vi.mock('./ExplorerWorkspace.js', () => ({
  ExplorerWorkspace: ({ onExit }: { onExit: () => void }) => <button onClick={onExit}>Back to Practice</button>,
}));

function fixture(lines: string[][]): CanonicalRepertoire {
  return buildCanonicalRepertoire(
    createLoadedSources(lines.map((sans, index) => createFixtureStudy({
      studyFolder: `recall-${index}`,
      lines: [{ sans }],
    }))),
    { openingId: 'recall', repertoireSide: 'white', title: 'Recall fixture' },
  ).repertoire;
}

function latestBoard(): BoardMockProps {
  if (!boardMock.latest) throw new Error('Recall board was not rendered.');
  return boardMock.latest;
}

function renderRecall(
  repertoire: CanonicalRepertoire,
  options: { timerSeconds?: number; depth?: number; progress?: PracticeLineProgressMap; onProgressChange?: (value: PracticeLineProgressMap) => void } = {},
) {
  const items = createMovePracticeItems(repertoire, [repertoire.rootPosition], options.depth ?? 3);
  const onProgressChange = options.onProgressChange ?? vi.fn();
  const onBackToSetup = vi.fn();
  render(<RandomRecallSession
    repertoire={repertoire}
    items={items}
    progress={options.progress ?? {}}
    onProgressChange={onProgressChange}
    timerSeconds={options.timerSeconds ?? 0}
    random={() => 0}
    onBackToSetup={onBackToSetup}
    explorerSources={[]}
    soundEnabled
    onSoundToggle={vi.fn()}
  />);
  return { items, onProgressChange, onBackToSetup };
}

beforeEach(() => {
  vi.useFakeTimers();
  boardMock.latest = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('RandomRecallSession', () => {
  it('credits the actually played stored move when several answers are valid', () => {
    const repertoire = fixture([
      ['d4', 'd5', 'Bf4'],
      ['Nf3', 'd5', 'd4'],
    ]);
    const { items, onProgressChange } = renderRecall(repertoire, { depth: 1 });
    const rootItems = items.filter((item) => item.position === repertoire.rootPosition);
    const played = rootItems.at(-1)!;
    const move = new Chess(played.fen).move(played.san, { strict: true });

    let accepted = false;
    act(() => {
      accepted = latestBoard().onWhiteMove(move.from, move.to, move.promotion as PromotionPiece | undefined);
    });

    expect(accepted).toBe(true);
    expect(onProgressChange).toHaveBeenCalledWith({
      [played.id]: { mistakes: 0, cleanRuns: 1 },
    });
    expect(screen.getByText('Correct')).toBeInTheDocument();
  });

  it('auto-advances after a correct move without requiring Enter', async () => {
    const repertoire = fixture([
      ['d4', 'd5', 'Bf4'],
      ['Nf3', 'Nf6', 'd4'],
    ]);
    const { items } = renderRecall(repertoire, { depth: 1 });
    const prompt = items.find((item) => item.fen === latestBoard().fen)!;
    const move = new Chess(prompt.fen).move(prompt.san, { strict: true });
    act(() => {
      latestBoard().onWhiteMove(move.from, move.to, move.promotion as PromotionPiece | undefined);
    });

    expect(screen.getByText('Correct')).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(screen.queryByText('Correct')).not.toBeInTheDocument();
    expect(screen.getByText('Find the repertoire move')).toBeInTheDocument();
  });

  it('penalizes a wrong move once, reveals all stored answers, and waits for Enter', () => {
    const repertoire = fixture([
      ['d4', 'd5', 'Bf4'],
      ['Nf3', 'd5', 'd4'],
    ]);
    const { items, onProgressChange } = renderRecall(repertoire, { depth: 1 });
    const active = items.find((item) => item.fen === latestBoard().fen)!;

    let accepted = true;
    act(() => {
      accepted = latestBoard().onWhiteMove('e2', 'e4', undefined);
    });

    expect(accepted).toBe(false);
    expect(onProgressChange).toHaveBeenCalledOnce();
    expect(onProgressChange).toHaveBeenCalledWith({
      [active.id]: { mistakes: 1, cleanRuns: 0 },
    });
    expect(latestBoard().practiceHintArrows).toHaveLength(2);
    expect(screen.getByText('Press Enter for next position')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Enter' });
    expect(screen.queryByText('Press Enter for next position')).not.toBeInTheDocument();
  });

  it('cycles H through two hint levels and resets it on the next prompt', () => {
    const repertoire = fixture([['d4', 'd5', 'Bf4'], ['Nf3', 'Nf6', 'd4']]);
    renderRecall(repertoire, { depth: 1 });

    fireEvent.keyDown(window, { key: 'h' });
    expect(latestBoard().practiceHintArrows).toEqual([]);
    fireEvent.keyDown(window, { key: 'H' });
    expect(latestBoard().practiceHintArrows).not.toHaveLength(0);
    fireEvent.keyDown(window, { key: 'Delete' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(latestBoard().practiceHintArrows).toEqual([]);
  });

  it('registers a timeout exactly once and keeps the solution visible', async () => {
    const repertoire = fixture([['d4', 'd5', 'Bf4']]);
    const { onProgressChange } = renderRecall(repertoire, { timerSeconds: 2, depth: 1 });

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getAllByText(/Time's up/)).not.toHaveLength(0);
    expect(latestBoard().practiceHintArrows).toHaveLength(1);
    expect(onProgressChange).toHaveBeenCalledOnce();

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(onProgressChange).toHaveBeenCalledOnce();
  });

  it('ignores practice shortcuts in text inputs and returns with Escape elsewhere', () => {
    const repertoire = fixture([['d4', 'd5', 'Bf4']]);
    const { onProgressChange, onBackToSetup } = renderRecall(repertoire, { depth: 1 });
    const input = document.createElement('input');
    document.body.append(input);

    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onProgressChange).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBackToSetup).toHaveBeenCalledOnce();
  });
});
