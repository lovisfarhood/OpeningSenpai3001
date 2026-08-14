// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import type { ChessboardOptions } from 'react-chessboard';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RepertoireBoard } from './RepertoireBoard';

const chessboardMock = vi.hoisted(() =>
  vi.fn((_props: { options?: ChessboardOptions }) => null),
);
const soundMock = vi.hoisted(() => vi.fn());

vi.mock('react-chessboard', () => ({
  Chessboard: chessboardMock,
}));
vi.mock('../audio/move-sounds.js', () => ({ playMoveSound: soundMock }));

const WHITE_TO_MOVE =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const BLACK_TO_MOVE =
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

function renderedOptions(): ChessboardOptions {
  const call = chessboardMock.mock.calls.at(-1);
  const props = call?.[0] as { options?: ChessboardOptions } | undefined;

  if (!props?.options) {
    throw new Error('Chessboard wurde nicht mit Optionen gerendert.');
  }

  return props.options;
}

afterEach(() => {
  cleanup();
  chessboardMock.mockClear();
  soundMock.mockClear();
});

describe('RepertoireBoard', () => {
  it('zeigt Schwarz unten und lässt nur weiße Figuren am weißen Zug ziehen', () => {
    render(<RepertoireBoard fen={WHITE_TO_MOVE} onWhiteMove={() => true} />);

    const options = renderedOptions();
    expect(options.boardOrientation).toBe('black');
    expect(options.animationDurationInMs).toBe(400);
    expect(options.allowDragging).toBe(true);
    expect(
      options.canDragPiece?.({
        isSparePiece: false,
        piece: { pieceType: 'wP' },
        square: 'e2',
      }),
    ).toBe(true);
    expect(
      options.canDragPiece?.({
        isSparePiece: false,
        piece: { pieceType: 'bP' },
        square: 'e7',
      }),
    ).toBe(false);
  });

  it('sperrt Eingaben bei schwarzem Zug sowie während waiting oder busy', () => {
    const { rerender } = render(
      <RepertoireBoard fen={BLACK_TO_MOVE} onWhiteMove={() => true} />,
    );
    expect(renderedOptions().allowDragging).toBe(false);

    rerender(
      <RepertoireBoard
        fen={WHITE_TO_MOVE}
        waiting
        onWhiteMove={() => true}
      />,
    );
    expect(renderedOptions().allowDragging).toBe(false);

    rerender(
      <RepertoireBoard fen={WHITE_TO_MOVE} busy onWhiteMove={() => true} />,
    );
    expect(renderedOptions().allowDragging).toBe(false);
  });

  it('reicht Zugkoordinaten und eine Damenumwandlung weiter', () => {
    const onWhiteMove = vi.fn(() => true);
    render(
      <RepertoireBoard fen={WHITE_TO_MOVE} onWhiteMove={onWhiteMove} />,
    );

    const accepted = renderedOptions().onPieceDrop?.({
      piece: {
        isSparePiece: false,
        pieceType: 'wP',
        position: 'e7',
      },
      sourceSquare: 'e7',
      targetSquare: 'e8',
    });

    expect(accepted).toBe(true);
    expect(onWhiteMove).toHaveBeenCalledWith('e7', 'e8', 'q');
  });

  it('mappt Chessly-Pfeile und erhält überlappende Highlights zweifarbig', () => {
    render(
      <RepertoireBoard
        fen={WHITE_TO_MOVE}
        onWhiteMove={() => true}
        annotations={[
          {
            arrows: {
              opportunities: ['a1-b2'],
              threats: ['h6-f5'],
            },
            highlights: {
              opportunities: ['e4'],
              threats: ['e4', 'd4'],
            },
          },
        ]}
      />,
    );

    const options = renderedOptions();
    expect(options.squareStyles?.e4?.boxShadow).toContain(
      'rgba(22, 163, 74, 0.82)',
    );
    expect(options.squareStyles?.e4?.boxShadow).toContain(
      'rgba(220, 38, 38, 0.82)',
    );
    expect(options.squareStyles?.d4?.boxShadow).toBe(
      'inset 0 0 0 7px rgba(220, 38, 38, 0.82)',
    );
  });

  it('blendet Pfeile und Highlights unabhängig voneinander aus', () => {
    render(
      <RepertoireBoard
        fen={WHITE_TO_MOVE}
        onWhiteMove={() => true}
        annotations={[
          {
            arrows: {
              opportunities: ['a1-b2'],
              threats: [],
            },
            highlights: {
              opportunities: ['b2'],
              threats: [],
            },
          },
        ]}
        showArrows={false}
        showHighlights={false}
      />,
    );

    const options = renderedOptions();
    expect(options.squareStyles).toEqual({});
  });

  it('rendert Course-, Stored-Variation- und Practice-Hint-Pfeile als getrennte Layer', () => {
    const { getByLabelText } = render(
      <RepertoireBoard
        fen={WHITE_TO_MOVE}
        onWhiteMove={() => true}
        courseAnnotations={[
          {
            arrows: {
              opportunities: ['a1-b2'],
              threats: [],
            },
          },
        ]}
        storedVariationArrows={[
          {
            id: 'stored-c4',
            fromSquare: 'c2',
            toSquare: 'c4',
            san: 'c4',
          },
        ]}
        practiceHintArrows={[
          {
            id: 'hint-e4',
            fromSquare: 'e2',
            toSquare: 'e4',
            san: 'e4',
          },
        ]}
      />,
    );

    const board = getByLabelText('Repertoire chessboard');
    expect(board).toHaveAttribute('data-course-arrow-count', '1');
    expect(board).toHaveAttribute('data-stored-variation-arrow-count', '1');
    expect(board).toHaveAttribute('data-practice-hint-arrow-count', '1');
    expect(
      board.querySelector('[data-arrow-layer="stored-variation"]'),
    ).toHaveAttribute('data-arrow-id', 'stored-c4');
    expect(
      board.querySelector('[data-arrow-layer="practice-hint"]'),
    ).toHaveAttribute('data-arrow-color', '#d5a253');
    expect(
      board.querySelector('[data-arrow-layer="stored-variation"]'),
    ).toHaveAttribute('data-arrow-role', 'theory');
    expect(board.querySelector('.board-arrow-overlay')).toBeInTheDocument();
  });

  it('schaltet die drei Pfeil-Layer unabhängig voneinander', () => {
    render(
      <RepertoireBoard
        fen={WHITE_TO_MOVE}
        onWhiteMove={() => true}
        annotations={[
          {
            arrows: {
              opportunities: ['a1-b2'],
              threats: [],
            },
          },
        ]}
        storedVariationArrows={[
          { fromSquare: 'c2', toSquare: 'c4' },
        ]}
        practiceHintArrows={[
          { fromSquare: 'e2', toSquare: 'e4' },
        ]}
        showArrows={false}
        showStoredVariationArrows={false}
      />,
    );

    const board = document.querySelector('[aria-label="Repertoire chessboard"]');
    expect(board).toHaveAttribute('data-course-arrow-count', '0');
    expect(board).toHaveAttribute('data-stored-variation-arrow-count', '0');
    expect(board).toHaveAttribute('data-practice-hint-arrow-count', '1');
  });

  it('unterstützt Click- und Touch-to-move mit legalen Zielmarkern', () => {
    const onWhiteMove = vi.fn(() => true);
    render(<RepertoireBoard fen={WHITE_TO_MOVE} onWhiteMove={onWhiteMove} />);

    act(() => renderedOptions().onSquareClick?.({
      piece: { pieceType: 'wP' },
      square: 'e2',
    }));
    expect(renderedOptions().squareStyles?.e2?.boxShadow).toContain('rgba(239, 189, 109');
    expect(renderedOptions().squareStyles?.e4?.background).toContain('radial-gradient');

    act(() => renderedOptions().onSquareClick?.({ piece: null, square: 'e4' }));
    expect(onWhiteMove).toHaveBeenCalledWith('e2', 'e4', undefined);
    expect(soundMock).toHaveBeenCalledWith(false);
  });

  it('spielt einen eigenen Capture-Sound und respektiert den session-only Toggle', () => {
    const fen = '4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1';
    const { rerender } = render(
      <RepertoireBoard fen={fen} soundEnabled={false} onWhiteMove={() => true} />,
    );
    act(() => renderedOptions().onSquareClick?.({ piece: { pieceType: 'wP' }, square: 'e4' }));
    act(() => renderedOptions().onSquareClick?.({ piece: { pieceType: 'bP' }, square: 'd5' }));
    expect(soundMock).not.toHaveBeenCalled();

    rerender(<RepertoireBoard fen={fen} soundEnabled onWhiteMove={() => true} />);
    act(() => renderedOptions().onSquareClick?.({ piece: { pieceType: 'wP' }, square: 'e4' }));
    act(() => renderedOptions().onSquareClick?.({ piece: { pieceType: 'bP' }, square: 'd5' }));
    expect(soundMock).toHaveBeenCalledWith(true);
  });

  it('zeigt Capture-Ringe, wechselt die Auswahl und führt keine illegalen Klickzüge aus', () => {
    const fen = '4k3/8/8/3p4/4P3/8/8/4K1N1 w - - 0 1';
    const onWhiteMove = vi.fn(() => true);
    render(<RepertoireBoard fen={fen} onWhiteMove={onWhiteMove} />);

    act(() => renderedOptions().onSquareClick?.({ piece: { pieceType: 'wP' }, square: 'e4' }));
    expect(renderedOptions().squareStyles?.d5?.background).toContain('56%');
    act(() => renderedOptions().onSquareClick?.({ piece: { pieceType: 'wN' }, square: 'g1' }));
    expect(renderedOptions().squareStyles?.g1?.boxShadow).toContain('rgba(239, 189, 109');
    act(() => renderedOptions().onSquareClick?.({ piece: null, square: 'a3' }));
    expect(onWhiteMove).not.toHaveBeenCalled();
  });

  it.each([
    ['castling', 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1', 'g1', undefined],
    ['promotion', 'k7/4P3/8/8/8/8/8/4K3 w - - 0 1', 'e7', 'e8', 'q'],
    ['en passant', '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'e5', 'd6', undefined],
  ])('führt %s über die vorhandene Chess-Regellogik aus', (_label, fen, from, to, promotion) => {
    const onWhiteMove = vi.fn(() => true);
    render(<RepertoireBoard fen={fen} onWhiteMove={onWhiteMove} />);

    const pieceType = from === 'e1' ? 'wK' : 'wP';
    act(() => renderedOptions().onSquareClick?.({ piece: { pieceType }, square: from }));
    act(() => renderedOptions().onSquareClick?.({ piece: null, square: to }));

    expect(onWhiteMove).toHaveBeenCalledWith(from, to, promotion);
  });
});
