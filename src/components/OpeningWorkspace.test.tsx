// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Chess } from 'chess.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCanonicalRepertoire } from '../../scripts/lib/build.js';
import {
  createFixtureStudy,
  createLoadedSources,
} from '../../tests/fixtures/repertoire-fixture.js';
import {
  normalizeFen,
  type CanonicalEdge,
  type CanonicalRepertoire,
} from '../domain/repertoire.js';
import { createPracticeItems, practiceLineProgress } from '../domain/practice.js';
import {
  buildImportanceOrder,
  type PopularityPack,
} from '../domain/popularity.js';
import { UserStateStore } from '../storage/user-state.js';
import { OpeningWorkspace } from './OpeningWorkspace.js';
import type {
  BoardLayerArrow,
  ChesslyBoardAnnotation,
} from './RepertoireBoard.js';

interface BoardMockProps {
  fen: string;
  allowWhiteInput?: boolean;
  courseAnnotations?: readonly ChesslyBoardAnnotation[] | null;
  storedVariationArrows?: readonly BoardLayerArrow[] | null;
  practiceHintArrows?: readonly BoardLayerArrow[] | null;
  onWhiteMove: (
    from: string,
    to: string,
    promotion: 'q' | 'r' | 'b' | 'n' | undefined,
  ) => boolean;
}

const boardMock = vi.hoisted(() => ({
  latest: null as BoardMockProps | null,
}));

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

vi.mock('./RepertoireBoard.js', () => ({
  RepertoireBoard: (props: BoardMockProps) => {
    boardMock.latest = props;
    return <div data-testid="repertoire-board-mock" data-fen={props.fen} />;
  },
}));

function fixture(
  side: 'white' | 'black',
  openingId: string,
  lines: string[][],
): CanonicalRepertoire {
  return buildCanonicalRepertoire(
    createLoadedSources(
      lines.map((sans, index) =>
        createFixtureStudy({
          studyFolder: `${openingId}-${index}`,
          lines: [{ sans }],
        }),
      ),
    ),
    { openingId, repertoireSide: side, title: `${side} integration` },
  ).repertoire;
}

function edgePath(
  repertoire: CanonicalRepertoire,
  sans: string[],
): CanonicalEdge[] {
  const path: CanonicalEdge[] = [];
  let position = repertoire.rootPosition;
  for (const san of sans) {
    const edge = Object.values(repertoire.edges).find(
      (candidate) => candidate.from === position && candidate.san === san,
    );
    if (!edge) throw new Error(`Fixture edge ${san} is missing.`);
    path.push(edge);
    position = edge.to;
  }
  return path;
}

function popularityPack(repertoire: CanonicalRepertoire): PopularityPack {
  const edgeGames = Object.fromEntries(Object.values(repertoire.edges).map(
    (edge) => [edge.id, edge.san === 'd4' ? 10 : 100],
  ));
  const positionGames = Object.fromEntries(Object.values(repertoire.edges).map(
    (edge) => [edge.to, edgeGames[edge.id] ?? 0],
  ));
  const roots = [repertoire.rootPosition];
  return {
    formatVersion: 2,
    openingId: repertoire.openingId,
    source: 'lichess-opening-explorer',
    retrievedAt: '2026-08-27T00:00:00.000Z',
    filters: { variant: 'standard', speeds: 'all', ratings: 'all', since: '1952-01', until: '3000-12' },
    coverage: { repertoireParentPositions: 1, cachedParentPositions: 1, inferredZeroParentPositions: 0, missingParentPositions: 0, failedRequests: 0 },
    edgeGames,
    positionGames,
    defaultRootPositions: roots,
    importanceOrder: buildImportanceOrder(repertoire, roots, edgeGames, positionGames),
  };
}

function persistSetup(
  repertoire: CanonicalRepertoire,
  depth: number,
  path: CanonicalEdge[] = [],
): void {
  localStorage.setItem(
    `interactive-chessbook:practice:v2:${repertoire.openingId}`,
    JSON.stringify({
      version: 2,
      depth,
      max: false,
      edgeIds: path.map((edge) => edge.id),
    }),
  );
}

function latestBoard(): BoardMockProps {
  if (!boardMock.latest) throw new Error('Board mock was not rendered.');
  return boardMock.latest;
}

async function playSelectedMove(repertoire: CanonicalRepertoire): Promise<void> {
  const board = latestBoard();
  expect(board.allowWhiteInput).toBe(true);
  const position = normalizeFen(board.fen);
  const decision = repertoire.repertoireDecisionNodes[position];
  const candidate = decision?.candidates.find(
    (item) => item.id === decision.selectedCandidateId,
  );
  if (!candidate) throw new Error(`No selected move at ${position}.`);
  const edge = repertoire.edges[candidate.edgeId];
  if (!edge) throw new Error(`Selected edge ${candidate.edgeId} is missing.`);
  const move = new Chess(board.fen).move(edge.san, { strict: true });
  let accepted = false;
  await act(async () => {
    accepted = board.onWhiteMove(
      move.from,
      move.to,
      move.promotion as 'q' | 'r' | 'b' | 'n' | undefined,
    );
  });
  expect(accepted).toBe(true);
}

async function playAutomaticOpponentMove(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
}

function sequenceText(): string {
  return screen.getByLabelText('Current move sequence').textContent ?? '';
}

function sequenceMoves(): string[] {
  return Array.from(
    screen.getByLabelText('Current move sequence').querySelectorAll('li'),
  ).flatMap((row) => {
    const white = row.querySelector('strong')?.textContent;
    const spans = row.querySelectorAll('span');
    const black = spans.item(spans.length - 1).textContent;
    return [white, black === '…' ? null : black].filter(
      (value): value is string => Boolean(value),
    );
  });
}

function summaryValue(label: string): string | null | undefined {
  return screen.getByText(label, { selector: 'dt' }).parentElement?.querySelector('dd')
    ?.textContent;
}

function definitionValue(container: HTMLElement, label: string): string {
  const term = within(container).getByText(label, { selector: 'dt' });
  return term.parentElement?.querySelector('dd')?.textContent ?? '';
}

function selectedPickerSequence(): string {
  return screen.getByLabelText('Selected move sequence').textContent ?? '';
}

function playBoardMove(
  from: string,
  to: string,
  promotion?: 'q' | 'r' | 'b' | 'n',
): void {
  let accepted = false;
  act(() => {
    accepted = latestBoard().onWhiteMove(from, to, promotion);
  });
  expect(accepted).toBe(true);
}

function enterPractice(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Practice Mode' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start practice' }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', new MemoryStorage());
  boardMock.latest = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('OpeningWorkspace practice completion', () => {
  it('starts directly in the requested mode and exposes the selected mode tab', () => {
    const repertoire = fixture('black', 'direct-practice', [
      ['e4', 'c6'],
    ]);
    render(
      <OpeningWorkspace repertoire={repertoire} initialMode="practice" />,
    );

    expect(
      screen.getByRole('heading', { name: 'Train black integration' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Practice Mode' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Book Mode' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('continues a Black line and starts a different variation from the selected root without resetting totals', async () => {
    const repertoire = fixture('black', 'black-workspace', [
      ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4'],
      ['e4', 'c6', 'Nf3', 'd5', 'exd5', 'cxd5'],
    ]);
    const selectedRoot = edgePath(repertoire, ['e4', 'c6']);
    persistSetup(repertoire, 1, selectedRoot);
    render(<OpeningWorkspace repertoire={repertoire} />);

    fireEvent.click(screen.getByRole('button', { name: 'Practice Mode' }));
    expect(screen.getByText('e4 c6')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start practice' }));
    await playAutomaticOpponentMove();
    await playSelectedMove(repertoire);

    expect(screen.getByRole('heading', { name: 'Well played' })).toBeInTheDocument();
    expect(summaryValue('Completion')).toBe('Target depth reached');
    expect(summaryValue('Moves attempted')).toBe('1');
    expect(screen.getByRole('button', { name: 'Continue this line' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next variation' })).toBeEnabled();
    const firstVariationMove = sequenceMoves()[2];
    const completedSequence = sequenceText();

    const navigation = screen.getByRole('navigation', { name: 'Board navigation' });
    fireEvent.click(within(navigation).getByRole('button', { name: /Previous/ }));
    expect(screen.getByRole('button', { name: 'Continue this line' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next variation' })).toBeDisabled();
    fireEvent.click(within(navigation).getByRole('button', { name: /Next/ }));
    expect(screen.getByRole('button', { name: 'Continue this line' })).toBeEnabled();
    expect(summaryValue('Completed exercises')).toBe('1');

    fireEvent.click(screen.getByRole('button', { name: 'Continue this line' }));
    expect(screen.getAllByText('Your opponent is to move')).not.toHaveLength(0);
    expect(sequenceText()).toBe(completedSequence);
    await playAutomaticOpponentMove();
    expect(sequenceText()).toContain(completedSequence);
    await playSelectedMove(repertoire);

    expect(summaryValue('Completion')).toBe('Stored line ended');
    expect(summaryValue('Moves attempted')).toBe('2');
    expect(screen.queryByRole('button', { name: 'Continue this line' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next variation' }));
    expect(screen.queryByRole('button', { name: 'Start practice' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Your opponent is to move')).not.toHaveLength(0);
    expect(sequenceMoves()).toEqual(['e4', 'c6']);
    await playAutomaticOpponentMove();
    expect(sequenceMoves()[2]).not.toBe(firstVariationMove);
    await playSelectedMove(repertoire);

    expect(summaryValue('Moves attempted')).toBe('3');
    expect(summaryValue('Correct first try')).toBe('3');
    expect(summaryValue('Completed exercises')).toBe('3');
  });

  it('uses the FEN side-to-move while continuing a White repertoire to its real end', async () => {
    const repertoire = fixture('white', 'white-workspace', [
      ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'e6'],
    ]);
    persistSetup(repertoire, 1);
    render(<OpeningWorkspace repertoire={repertoire} />);
    enterPractice();

    expect(normalizeFen(latestBoard().fen)).toBe(repertoire.rootPosition);
    await playSelectedMove(repertoire);
    expect(summaryValue('Completion')).toBe('Target depth reached');
    expect(screen.getByRole('button', { name: 'Continue this line' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue this line' }));
    expect(screen.getAllByText('Your opponent is to move')).not.toHaveLength(0);
    await playAutomaticOpponentMove();
    await playSelectedMove(repertoire);
    expect(summaryValue('Moves attempted')).toBe('2');

    fireEvent.click(screen.getByRole('button', { name: 'Continue this line' }));
    await playAutomaticOpponentMove();
    await playSelectedMove(repertoire);

    expect(summaryValue('Completion')).toBe('Target depth reached');
    expect(summaryValue('Moves attempted')).toBe('3');
    expect(screen.getByRole('button', { name: 'Continue this line' })).toBeEnabled();
    expect(sequenceMoves()).toEqual(['d4', 'd5', 'Bf4', 'Nf6', 'e3']);

    expect(screen.queryByRole('button', { name: 'Next variation' })).not.toBeInTheDocument();
  });

  it('lets White answer after an Importance boundary ending on the automatic Black move', async () => {
    const repertoire = fixture('white', 'importance-response', [[
      'e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O',
      'Be7', 'Re1', 'b5',
    ]]);
    persistSetup(repertoire, 3);
    render(
      <OpeningWorkspace
        repertoire={repertoire}
        popularityPack={popularityPack(repertoire)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Practice Mode' }));
    fireEvent.click(screen.getByRole('button', { name: /Importance/ }));
    fireEvent.change(screen.getByRole('slider', { name: 'Importance positions' }), {
      target: { value: '0' },
    });
    expect(screen.getByLabelText('Importance positions')).toHaveAttribute(
      'aria-valuetext',
      '10 positions',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start practice' }));

    await playSelectedMove(repertoire); // e4
    await playAutomaticOpponentMove(); // e5
    await playSelectedMove(repertoire); // Nf3
    await playAutomaticOpponentMove(); // Nc6
    await playSelectedMove(repertoire); // Bb5
    await playAutomaticOpponentMove(); // a6
    await playSelectedMove(repertoire); // Ba4
    await playAutomaticOpponentMove(); // Nf6
    await playSelectedMove(repertoire); // O-O
    await playAutomaticOpponentMove(); // Be7 (formal position 10)

    expect(sequenceMoves()).toEqual([
      'e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7',
    ]);
    expect(screen.queryByRole('region', { name: 'Practice completion actions' }))
      .not.toBeInTheDocument();
    expect(screen.getAllByText('Play your repertoire move')).not.toHaveLength(0);

    await playSelectedMove(repertoire); // Re1 (execution-only response)
    expect(sequenceMoves().at(-1)).toBe('Re1');
    expect(screen.getByRole('region', { name: 'Practice completion actions' }))
      .toBeInTheDocument();
  });

  it('keeps completion actions coherent after a mistake and a shown solution', async () => {
    const repertoire = fixture('black', 'solution-workspace', [
      ['e4', 'c6', 'd4', 'd5'],
    ]);
    persistSetup(repertoire, 1);
    render(<OpeningWorkspace repertoire={repertoire} />);
    enterPractice();

    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Board navigation' }))
        .getByRole('button', { name: /Restart/ }),
    );
    expect(screen.getByText('Previous exercise: Exercise ended by user')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start practice' }));
    await playAutomaticOpponentMove();

    let accepted = true;
    await act(async () => {
      accepted = latestBoard().onWhiteMove('e7', 'e6', undefined);
    });
    expect(accepted).toBe(false);
    expect(screen.getByText('Mastered 0 / 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue this line' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next variation' })).not.toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Not in this line — try again')).not.toHaveLength(0);
    expect(latestBoard().allowWhiteInput).toBe(true);
    await act(async () => {
      latestBoard().onWhiteMove('e7', 'e6', undefined);
    });
    fireEvent.click(screen.getByRole('button', { name: /Show solution/ }));

    expect(summaryValue('Moves attempted')).toBe('2');
    expect(summaryValue('Mistakes')).toBe('3');
    expect(screen.getByRole('button', { name: 'Continue this line' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next variation' })).toBeEnabled();
  });
});

describe('OpeningWorkspace variation context', () => {
  it('deduplicates stored Book continuations and restores root arrows without mutating the live line', async () => {
    const repertoire = fixture('black', 'book-variations', [
      ['e4', 'c6', 'd4', 'd5'],
      ['e4', 'c6', 'Nf3', 'd5'],
      ['d4', 'd5', 'c4', 'e6'],
    ]);
    render(<OpeningWorkspace repertoire={repertoire} />);

    expect(
      latestBoard().storedVariationArrows?.map((arrow) => arrow.san),
    ).toEqual(['d4', 'e4']);
    const continuations = screen.getByRole('region', {
      name: 'Stored continuations',
    });
    expect(
      within(continuations).getByRole('heading', {
        name: 'Stored continuations: 2',
      }),
    ).toBeInTheDocument();
    expect(within(continuations).getAllByRole('listitem')).toHaveLength(2);
    const e4Continuation = within(continuations).getByText('e4').closest('li');
    if (!e4Continuation) throw new Error('The e4 continuation is missing.');
    expect(within(e4Continuation).getByText('2 paths')).toBeInTheDocument();

    playBoardMove('e2', 'e4');
    await playAutomaticOpponentMove();
    expect(sequenceMoves()).toEqual(['e4', 'c6']);
    expect(
      latestBoard().storedVariationArrows?.map((arrow) => arrow.san),
    ).toEqual(['d4', 'Nf3']);

    fireEvent.keyDown(window, { key: 'Home' });
    expect(normalizeFen(latestBoard().fen)).toBe(repertoire.rootPosition);
    expect(latestBoard().allowWhiteInput).toBe(false);
    expect(
      latestBoard().storedVariationArrows?.map((arrow) => arrow.san),
    ).toEqual(['d4', 'e4']);

    const liveSequence = sequenceMoves();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(sequenceMoves()).toEqual(liveSequence);
    let accepted = true;
    act(() => {
      accepted = latestBoard().onWhiteMove('e2', 'e4', undefined);
    });
    expect(accepted).toBe(false);
    expect(sequenceMoves()).toEqual(liveSequence);
  });

  it('keeps live practice focused on mastery and notation instead of graph diagnostics', async () => {
    const repertoire = fixture('black', 'practice-summary', [
      ['e4', 'c6'],
      ['d4', 'd5'],
    ]);
    render(<OpeningWorkspace repertoire={repertoire} />);
    enterPractice();

    expect(screen.queryByRole('region', { name: 'Variation Summary' })).not.toBeInTheDocument();
    expect(screen.getByText('Mastered 0 / 2')).toBeInTheDocument();
    expect(screen.getByText('2 remaining')).toBeInTheDocument();
    expect(screen.getByLabelText('Current move sequence')).toBeInTheDocument();

    await playAutomaticOpponentMove();
    await playSelectedMove(repertoire);

    expect(screen.queryByRole('region', { name: 'Variation Summary' })).not.toBeInTheDocument();
    expect(screen.getByText('Mastered 1 / 2')).toBeInTheDocument();
    expect(screen.getByText('1 remaining')).toBeInTheDocument();
    expect(sequenceMoves()).not.toHaveLength(0);
  });

  it('shows picker variation context and supports keyboard undo, redo, jumps, and redo invalidation', () => {
    const repertoire = fixture('black', 'picker-navigation', [
      ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4'],
      ['e4', 'c6', 'd4', 'd5', 'Nf3', 'Nf6'],
      ['d4', 'd5', 'c4', 'e6'],
    ]);
    render(
      <>
        <input aria-label="Shortcut guard" />
        <OpeningWorkspace repertoire={repertoire} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Practice Mode' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Change' }),
    );

    const dialog = screen.getByRole('dialog', {
      name: 'Choose starting position on board',
    });
    const summary = within(dialog).getByRole('region', {
      name: 'Variation Summary',
    });
    expect(
      latestBoard().storedVariationArrows?.map((arrow) => arrow.san),
    ).toEqual(['d4', 'e4']);
    expect(definitionValue(summary, 'Stored continuations')).toBe('2');
    expect(definitionValue(summary, 'Practice branches')).toBe('2');
    expect(definitionValue(summary, 'Remaining lines')).toBe('3');
    expect(definitionValue(summary, 'Maximum training depth')).toBe('3');
    expect(
      within(dialog).getByText('Stored variation'),
    ).toBeInTheDocument();

    playBoardMove('e2', 'e4');
    playBoardMove('c7', 'c6');
    playBoardMove('d2', 'd4');
    playBoardMove('d7', 'd5');
    playBoardMove('b1', 'c3');
    expect(selectedPickerSequence()).toBe('e4 c6 d4 d5 Nc3');

    const shortcutGuard = screen.getByRole('textbox', {
      name: 'Shortcut guard',
    });
    shortcutGuard.focus();
    fireEvent.keyDown(shortcutGuard, { key: 'Home' });
    expect(selectedPickerSequence()).toBe('e4 c6 d4 d5 Nc3');
    shortcutGuard.blur();

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(selectedPickerSequence()).toBe('e4 c6 d4 d5');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(selectedPickerSequence()).toBe('e4 c6 d4 d5 Nc3');

    fireEvent.keyDown(window, { key: 'ArrowLeft', shiftKey: true });
    expect(selectedPickerSequence()).toBe('e4 c6 d4');
    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true });
    expect(selectedPickerSequence()).toBe('e4 c6 d4 d5 Nc3');

    fireEvent.keyDown(window, { key: 'Home' });
    expect(selectedPickerSequence()).toBe('Opening root');
    fireEvent.keyDown(window, { key: 'End' });
    expect(selectedPickerSequence()).toBe('e4 c6 d4 d5 Nc3');

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(selectedPickerSequence()).toBe('e4 c6 d4 d5');
    expect(
      within(dialog).getByRole('button', { name: 'Next move' }),
    ).toBeEnabled();
    playBoardMove('g1', 'f3');
    expect(selectedPickerSequence()).toBe('e4 c6 d4 d5 Nf3');
    expect(
      within(dialog).getByRole('button', { name: 'Next move' }),
    ).toBeDisabled();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(selectedPickerSequence()).toBe('e4 c6 d4 d5 Nf3');
  });

  it('uses a dedicated practice hint arrow only for the second hint', async () => {
    const repertoire = fixture('black', 'practice-hints', [
      ['e4', 'c6'],
    ]);
    render(<OpeningWorkspace repertoire={repertoire} />);
    enterPractice();
    await playAutomaticOpponentMove();

    fireEvent.click(screen.getByRole('button', { name: /Hint 1/ }));
    expect(latestBoard().practiceHintArrows).toEqual([]);
    expect(latestBoard().courseAnnotations).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: /Hint 2/ }));
    expect(latestBoard().practiceHintArrows).toMatchObject([
      { fromSquare: 'c7', toSquare: 'c6', san: 'c6' },
    ]);
    expect(latestBoard().courseAnnotations).toEqual([]);
  });

  it('keeps Continue and Next available after marking the completed practice item understood', async () => {
    const repertoire = fixture('black', 'understood-workspace', [
      ['e4', 'c6', 'd4', 'd5'],
      ['d4', 'd5', 'c4', 'e6'],
    ]);
    persistSetup(repertoire, 1);
    render(<OpeningWorkspace repertoire={repertoire} random={() => 0} />);
    enterPractice();
    await playAutomaticOpponentMove();
    fireEvent.click(screen.getByRole('button', { name: /Show solution/ }));

    const completion = screen.getByRole('region', { name: 'Practice completion actions' });
    const markButton = within(completion).getByRole('button', { name: /Mark line as understood/ });
    expect(markButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(markButton);

    const understood = within(completion).getByRole('button', { name: /Line understood/ });
    expect(understood).toBeDisabled();
    expect(understood).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByText('Practice line marked as understood.')).not.toHaveLength(0);
    expect(within(completion).getByRole('button', { name: 'Continue this line' })).toBeEnabled();
    expect(within(completion).getByRole('button', { name: 'Next variation' })).toBeEnabled();

    fireEvent.click(within(completion).getByRole('button', { name: 'Continue this line' }));
    expect(screen.queryByRole('region', { name: 'Practice completion actions' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Your opponent is to move')).not.toHaveLength(0);
  });
});

describe('OpeningWorkspace practice controls', () => {
  it('registers a move timeout exactly once and still allows the move', async () => {
    const repertoire = fixture('black', 'line-timer', [['e4', 'c6']]);
    persistSetup(repertoire, 1);
    render(<OpeningWorkspace repertoire={repertoire} />);
    fireEvent.click(screen.getByRole('button', { name: 'Practice Mode' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Move timer' }), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start practice' }));
    await playAutomaticOpponentMove();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getAllByText("Time's up")).not.toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));

    await playSelectedMove(repertoire);
    expect(summaryValue('Mistakes')).toBe('1');
    expect(sequenceMoves()).toEqual(['e4', 'c6']);
  });

  it.each(['Backspace', 'Delete'])('%s shows the solution outside text fields', async (key) => {
    const repertoire = fixture('black', `shortcut-${key}`, [
      ['e4', 'c6'],
      ['d4', 'd5'],
    ]);
    render(<><input aria-label="Shortcut input"/><OpeningWorkspace repertoire={repertoire} /></>);
    enterPractice();
    await playAutomaticOpponentMove();

    const input = screen.getByRole('textbox', { name: 'Shortcut input' });
    fireEvent.keyDown(input, { key });
    expect(screen.queryByRole('region', { name: 'Practice completion actions' })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'h' });
    expect(latestBoard().practiceHintArrows).toEqual([]);
    fireEvent.keyDown(window, { key: 'H' });
    expect(latestBoard().practiceHintArrows).not.toHaveLength(0);
    fireEvent.keyDown(window, { key });
    expect(screen.getByRole('region', { name: 'Practice completion actions' })).toBeInTheDocument();
    expect(sequenceMoves()).not.toHaveLength(0);

    fireEvent.keyDown(window, { key: 'Enter' });
    await playAutomaticOpponentMove();
    expect(screen.getByRole('button', { name: /Hint 1/ })).toBeEnabled();
    expect(latestBoard().practiceHintArrows).toEqual([]);
  });

  it('returns from Explorer to the exact failed Practice position with the timer paused', async () => {
    const repertoire = fixture('black', 'explore-return', [['e4', 'c6']]);
    persistSetup(repertoire, 1);
    render(<OpeningWorkspace repertoire={repertoire} />);
    fireEvent.click(screen.getByRole('button', { name: 'Practice Mode' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Move timer' }), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start practice' }));
    await playAutomaticOpponentMove();
    act(() => { latestBoard().onWhiteMove('e7', 'e6', undefined); });
    const beforeFen = latestBoard().fen;
    const beforeSequence = sequenceMoves();

    fireEvent.click(screen.getByRole('button', { name: /Explore this position/ }));
    expect(screen.getByRole('button', { name: /Back to Practice/ })).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    fireEvent.click(screen.getByRole('button', { name: /Back to Practice/ }));

    expect(latestBoard().fen).toBe(beforeFen);
    expect(sequenceMoves()).toEqual(beforeSequence);
    expect(screen.getAllByText('Not in this line — try again')).not.toHaveLength(0);
    expect(screen.getByText('3s')).toBeInTheDocument();
  });

  it('adds, deduplicates, removes, and persists multiple starting positions', () => {
    const repertoire = fixture('black', 'multiple-roots', [
      ['e4', 'c6', 'd4', 'd5'],
      ['e4', 'c6', 'Nf3', 'd5'],
    ]);
    render(<OpeningWorkspace repertoire={repertoire} />);
    fireEvent.click(screen.getByRole('button', { name: 'Practice Mode' }));
    expect(screen.getByText('e4 c6')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '+ Add position' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm position' }));
    expect(screen.getAllByText(/Position [12]/)).toHaveLength(2);
    expect(new UserStateStore().getPracticeStartingPositions(repertoire.openingId)).toHaveLength(2);

    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    fireEvent.click(removeButtons[0]!);
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1);
    expect(new UserStateStore().getPracticeStartingPositions(repertoire.openingId)).toHaveLength(1);
  });

  it('switches from Fixed depth to a discrete-position Importance scope', () => {
    const repertoire = fixture('white', 'importance-ui', [
      [
        'e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O',
        'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O', 'h3',
      ],
      [
        'e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3',
        'a6', 'Be3', 'e5', 'Nf3', 'Be7', 'Bc4', 'O-O', 'O-O',
      ],
    ]);
    const pack = popularityPack(repertoire);
    render(<OpeningWorkspace repertoire={repertoire} popularityPack={pack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Practice Mode' }));

    expect(screen.getByRole('slider', { name: 'Training depth' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Importance/ }));
    expect(screen.queryByRole('slider', { name: 'Training depth' })).not.toBeInTheDocument();
    const slider = screen.getByRole('slider', { name: 'Importance positions' });
    expect(Number(slider.getAttribute('max'))).toBeGreaterThan(0);
    expect(slider).toHaveAttribute('aria-valuetext', '30 positions');
    fireEvent.change(slider, { target: { value: '0' } });
    expect(slider).toHaveAttribute('aria-valuetext', '10 positions');
    expect(within(screen.getByLabelText('Importance scope summary')).getByText('10')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Importance scope summary')).getByText('Lowest repertoire reach')).toBeInTheDocument();
  });

  it('disables Importance cleanly when its lazy popularity pack is absent', () => {
    const repertoire = fixture('white', 'importance-missing', [['e4', 'e5']]);
    render(<OpeningWorkspace repertoire={repertoire} />);
    fireEvent.click(screen.getByRole('button', { name: 'Practice Mode' }));

    expect(screen.getByRole('button', { name: /Importance/ })).toBeDisabled();
    expect(screen.getByTitle('Popularity data not available for this opening yet.')).toBeInTheDocument();
  });

  it('resets only the current setup progress after confirmation', () => {
    const repertoire = fixture('white', 'scoped-reset', [['d4', 'd5', 'Bf4']]);
    persistSetup(repertoire, 1);
    const item = createPracticeItems(repertoire, repertoire.rootPosition, 1)[0]!;
    const store = new UserStateStore();
    store.setPracticeLineProgress(repertoire.openingId, {
      [item.id]: { mistakes: 2, cleanRuns: 2 },
      unrelated: { mistakes: 7, cleanRuns: 0 },
    });
    render(<OpeningWorkspace repertoire={repertoire} />);
    fireEvent.click(screen.getByRole('button', { name: 'Practice Mode' }));
    expect(screen.getByText('All practice lines at this depth are mastered.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset training progress' }));
    expect(screen.getByRole('alertdialog', { name: 'Reset training progress?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(practiceLineProgress(new UserStateStore().getPracticeLineProgress(repertoire.openingId), item.id).mastered).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Reset training progress' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset progress' }));
    const progress = new UserStateStore().getPracticeLineProgress(repertoire.openingId);
    expect(practiceLineProgress(progress, item.id).mastered).toBe(false);
    expect(progress.unrelated).toEqual({ mistakes: 7, cleanRuns: 0 });
    expect(screen.getByRole('button', { name: 'Start practice' })).toBeEnabled();
  });
});
