// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Chess } from 'chess.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCanonicalRepertoire } from '../../scripts/lib/build.js';
import { createFixtureStudy, createLoadedSources } from '../../tests/fixtures/repertoire-fixture.js';
import type { ExplorerSource } from '../domain/explorer.js';
import type { CanonicalRepertoire } from '../domain/repertoire.js';
import { ExplorerWorkspace } from './ExplorerWorkspace.js';
import type { BoardLayerArrow, PromotionPiece } from './RepertoireBoard.js';

interface BoardMockProps {
  fen: string;
  storedVariationArrows?: readonly BoardLayerArrow[] | null;
  onWhiteMove: (from: string, to: string, promotion: PromotionPiece | undefined) => boolean;
}

const boardMock = vi.hoisted(() => ({ latest: null as BoardMockProps | null }));

vi.mock('./RepertoireBoard.js', () => ({
  RepertoireBoard: (props: BoardMockProps) => {
    boardMock.latest = props;
    return <div data-testid="explorer-board" data-fen={props.fen}/>;
  },
}));

function graph(id: string, side: 'white' | 'black', lines: string[][]): CanonicalRepertoire {
  return buildCanonicalRepertoire(
    createLoadedSources(lines.map((sans, index) => createFixtureStudy({
      studyFolder: `${id}-${index}`,
      lines: [{ sans }],
    }))),
    { openingId: id, title: id, repertoireSide: side },
  ).repertoire;
}

function source(repertoire: CanonicalRepertoire): ExplorerSource {
  return {
    openingId: repertoire.openingId,
    title: repertoire.title,
    repertoireSide: repertoire.openingSide,
    repertoire,
  };
}

function latestBoard(): BoardMockProps {
  if (!boardMock.latest) throw new Error('Explorer board was not rendered.');
  return boardMock.latest;
}

function playSan(san: string): void {
  const board = latestBoard();
  const move = new Chess(board.fen).move(san, { strict: true });
  let accepted = false;
  act(() => {
    accepted = board.onWhiteMove(move.from, move.to, move.promotion as PromotionPiece | undefined);
  });
  expect(accepted).toBe(true);
}

function visibleMoves(): string {
  return screen.getByLabelText('Current move sequence').textContent ?? '';
}

afterEach(() => {
  cleanup();
  boardMock.latest = null;
});

describe('ExplorerWorkspace', () => {
  it('shows role-aware full-repertoire arrows and no obsolete side or variation filters', () => {
    const white = graph('white', 'white', [['e4', 'e5'], ['d4', 'd5']]);
    const black = graph('black', 'black', [['e4', 'e5'], ['Nf3', 'Nf6']]);
    render(<ExplorerWorkspace title="Full Repertoire Explorer" sources={[source(white), source(black)]}/>);

    expect(latestBoard().storedVariationArrows?.map((arrow) => [arrow.san, arrow.role]))
      .toEqual(expect.arrayContaining([['e4', 'both'], ['d4', 'repertoire'], ['Nf3', 'opponent']]));
    const legend = screen.getByLabelText('Board arrow legend');
    expect(legend).toHaveTextContent('Repertoire move');
    expect(legend).toHaveTextContent('Opponent move');
    expect(legend).toHaveTextContent('Both roles');
    expect(screen.queryByRole('button', { name: 'White repertoire' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Main variations' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Theory scope')).not.toBeInTheDocument();
  });

  it('moves exactly one ply with arrows, two with Shift, and invalidates redo on a branch change', () => {
    const repertoire = graph('navigation', 'black', [['e4', 'c6', 'd4', 'd5']]);
    render(<><input aria-label="Shortcut guard"/><ExplorerWorkspace title="Navigation" sources={[source(repertoire)]}/></>);
    playSan('e4');
    playSan('c6');
    playSan('d4');
    playSan('d5');
    expect(visibleMoves()).toContain('d5');

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(visibleMoves()).toContain('d4');
    expect(visibleMoves()).not.toContain('d5');
    fireEvent.keyDown(window, { key: 'ArrowLeft', shiftKey: true });
    expect(visibleMoves()).toContain('e4');
    expect(visibleMoves()).not.toContain('c6');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(visibleMoves()).toContain('c6');
    expect(visibleMoves()).not.toContain('d4');
    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true });
    expect(visibleMoves()).toContain('d5');

    fireEvent.keyDown(window, { key: 'Home' });
    expect(visibleMoves()).toBe('No moves yet');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(visibleMoves()).toContain('e4');
    fireEvent.keyDown(window, { key: 'End' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    playSan('e6');
    expect(visibleMoves()).toContain('e6');
    expect(screen.getByRole('button', { name: /Redo/ })).toBeDisabled();

    const input = screen.getByRole('textbox', { name: 'Shortcut guard' });
    fireEvent.keyDown(input, { key: 'Home' });
    expect(visibleMoves()).toContain('e6');
  });
});
