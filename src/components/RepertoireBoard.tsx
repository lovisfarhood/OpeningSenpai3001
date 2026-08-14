import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Chess, type Square } from 'chess.js';
import {
  Chessboard,
  type ChessboardOptions,
} from 'react-chessboard';

import type { AnnotationMarks } from '../domain/repertoire';
import { playMoveSound } from '../audio/move-sounds.js';

export type BoardOrientation = 'white' | 'black';
export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

export interface ChesslyBoardAnnotation {
  arrows?: AnnotationMarks | null;
  highlights?: AnnotationMarks | null;
}

export interface BoardLayerArrow {
  id?: string;
  fromSquare: string;
  toSquare: string;
  san?: string;
  tooltip?: string;
  role?: BoardArrowRole;
}

export type BoardArrowLayer =
  | 'course'
  | 'stored-variation'
  | 'practice-hint';

export type BoardArrowRole =
  | 'repertoire'
  | 'opponent'
  | 'both'
  | 'theory'
  | 'annotation-opportunity'
  | 'annotation-threat'
  | 'hint'
  | 'solution';

export interface RepertoireBoardProps {
  fen: string;
  orientation?: BoardOrientation;
  allowWhiteInput?: boolean;
  inputSide?: 'white' | 'black';
  waiting?: boolean;
  busy?: boolean;
  onWhiteMove: (
    from: string,
    to: string,
    promotion: PromotionPiece | undefined,
  ) => boolean;
  annotations?: readonly ChesslyBoardAnnotation[] | null;
  courseAnnotations?: readonly ChesslyBoardAnnotation[] | null;
  storedVariationArrows?: readonly BoardLayerArrow[] | null;
  practiceHintArrows?: readonly BoardLayerArrow[] | null;
  showArrows?: boolean;
  showStoredVariationArrows?: boolean;
  showPracticeHintArrows?: boolean;
  showHighlights?: boolean;
  soundEnabled?: boolean;
}

const EMPTY_ANNOTATIONS: readonly ChesslyBoardAnnotation[] = [];
const EMPTY_LAYER_ARROWS: readonly BoardLayerArrow[] = [];

const BOARD_ARROW_THEME: Readonly<Record<BoardArrowRole, string>> = {
  repertoire: '#49b883',
  opponent: '#17201d',
  both: 'url(#board-arrow-both-pattern)',
  theory: '#5f87c9',
  'annotation-opportunity': '#49b883',
  'annotation-threat': '#df6b63',
  hint: '#d5a253',
  solution: '#efbd6d',
};
const OPPORTUNITY_HIGHLIGHT_COLOR = 'rgba(22, 163, 74, 0.82)';
const THREAT_HIGHLIGHT_COLOR = 'rgba(220, 38, 38, 0.82)';
const SELECTED_SQUARE_STYLE: CSSProperties = {
  boxShadow: 'inset 0 0 0 5px rgba(239, 189, 109, .88)',
  background: 'rgba(213, 162, 83, .32)',
};
const LEGAL_TARGET_STYLE: CSSProperties = {
  background: 'radial-gradient(circle, rgba(213, 162, 83, .82) 0 14%, transparent 16%)',
};
const LEGAL_CAPTURE_STYLE: CSSProperties = {
  background: 'radial-gradient(circle, transparent 0 56%, rgba(213, 162, 83, .82) 58% 70%, transparent 72%)',
};

const SQUARE_PATTERN = /^[a-h][1-8]$/;
const ARROW_PATTERN = /^([a-h][1-8])-([a-h][1-8])$/;

function isSideTurn(fen: string, side: 'white' | 'black'): boolean {
  return fen.trim().split(/\s+/)[1] === (side === 'white' ? 'w' : 'b');
}

function isSidePiece(pieceType: string, side: 'white' | 'black'): boolean {
  return pieceType.startsWith(side === 'white' ? 'w' : 'b');
}

function parseArrow(value: string): [from: string, to: string] | null {
  const match = ARROW_PATTERN.exec(value.trim().toLowerCase());
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return [match[1], match[2]];
}

interface LayeredArrow {
  fromSquare: string;
  toSquare: string;
  layer: BoardArrowLayer;
  kind: 'opportunity' | 'threat' | 'stored' | 'hint';
  role: BoardArrowRole;
  id?: string;
  san?: string;
  tooltip?: string;
}

function collectCourseArrows(
  annotations: readonly ChesslyBoardAnnotation[],
): LayeredArrow[] {
  const arrows: LayeredArrow[] = [];
  const seen = new Set<string>();

  const addArrow = (
    value: string,
    kind: 'opportunity' | 'threat',
  ): void => {
    const squares = parseArrow(value);
    if (!squares) {
      return;
    }

    const [startSquare, endSquare] = squares;
    const key = `${startSquare}-${endSquare}-${kind}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    arrows.push({
      fromSquare: startSquare,
      toSquare: endSquare,
      layer: 'course',
      kind,
      role: kind === 'opportunity'
        ? 'annotation-opportunity'
        : 'annotation-threat',
    });
  };

  for (const annotation of annotations) {
    for (const arrow of annotation.arrows?.opportunities ?? []) {
      addArrow(arrow, 'opportunity');
    }
    for (const arrow of annotation.arrows?.threats ?? []) {
      addArrow(arrow, 'threat');
    }
  }

  return arrows;
}

function collectLayerArrows(
  values: readonly BoardLayerArrow[],
  layer: Exclude<BoardArrowLayer, 'course'>,
): LayeredArrow[] {
  const arrows: LayeredArrow[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const startSquare = value.fromSquare.trim().toLowerCase();
    const endSquare = value.toSquare.trim().toLowerCase();
    if (
      !SQUARE_PATTERN.test(startSquare) ||
      !SQUARE_PATTERN.test(endSquare)
    ) {
      continue;
    }
    const key = `${startSquare}-${endSquare}`;
    if (seen.has(key)) continue;
    seen.add(key);
    arrows.push({
      fromSquare: startSquare,
      toSquare: endSquare,
      layer,
      kind: layer === 'stored-variation' ? 'stored' : 'hint',
      role: value.role ?? (layer === 'stored-variation' ? 'theory' : 'hint'),
      ...(value.id === undefined ? {} : { id: value.id }),
      ...(value.san === undefined ? {} : { san: value.san }),
      ...(value.tooltip === undefined ? {} : { tooltip: value.tooltip }),
    });
  }
  return arrows;
}

function collectHighlights(
  annotations: readonly ChesslyBoardAnnotation[],
): Record<string, CSSProperties> {
  const opportunities = new Set<string>();
  const threats = new Set<string>();

  for (const annotation of annotations) {
    for (const square of annotation.highlights?.opportunities ?? []) {
      const normalizedSquare = square.trim().toLowerCase();
      if (SQUARE_PATTERN.test(normalizedSquare)) {
        opportunities.add(normalizedSquare);
      }
    }
    for (const square of annotation.highlights?.threats ?? []) {
      const normalizedSquare = square.trim().toLowerCase();
      if (SQUARE_PATTERN.test(normalizedSquare)) {
        threats.add(normalizedSquare);
      }
    }
  }

  const styles: Record<string, CSSProperties> = {};
  const highlightedSquares = new Set([...opportunities, ...threats]);

  for (const square of highlightedSquares) {
    const isOpportunity = opportunities.has(square);
    const isThreat = threats.has(square);

    if (isOpportunity && isThreat) {
      styles[square] = {
        boxShadow: [
          `inset 0 0 0 5px ${THREAT_HIGHLIGHT_COLOR}`,
          `inset 0 0 0 10px ${OPPORTUNITY_HIGHLIGHT_COLOR}`,
        ].join(', '),
      };
    } else {
      styles[square] = {
        boxShadow: `inset 0 0 0 7px ${
          isOpportunity
            ? OPPORTUNITY_HIGHLIGHT_COLOR
            : THREAT_HIGHLIGHT_COLOR
        }`,
      };
    }
  }

  return styles;
}

function squareCenter(
  square: string,
  orientation: BoardOrientation,
): { x: number; y: number } | null {
  if (!SQUARE_PATTERN.test(square)) return null;
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return orientation === 'white'
    ? { x: (file + 0.5) * 100, y: (7.5 - rank) * 100 }
    : { x: (7.5 - file) * 100, y: (rank + 0.5) * 100 };
}

function BoardArrowOverlay({
  arrows,
  orientation,
}: {
  arrows: readonly LayeredArrow[];
  orientation: BoardOrientation;
}) {
  return (
    <svg
      className="board-arrow-overlay"
      viewBox="0 0 800 800"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <pattern id="board-arrow-both-pattern" width="18" height="18" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="9" height="18" fill="#49b883" />
          <rect x="9" width="9" height="18" fill="#17201d" />
        </pattern>
        {Object.entries(BOARD_ARROW_THEME).map(([role, color]) => (
          <marker
            key={role}
            id={`board-arrow-head-${role}`}
            markerWidth="5"
            markerHeight="5"
            refX="3.8"
            refY="2.5"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path
              d="M0,0 L5,2.5 L0,5 Z"
              fill={color}
              stroke={role === 'opponent' || role === 'both' ? '#e5ddc6' : 'none'}
              strokeWidth={role === 'opponent' || role === 'both' ? '.28' : '0'}
            />
          </marker>
        ))}
      </defs>
      {arrows.flatMap((arrow, index) => {
        const from = squareCenter(arrow.fromSquare, orientation);
        const to = squareCenter(arrow.toSquare, orientation);
        if (!from || !to) return [];
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const distance = Math.hypot(dx, dy);
        if (distance === 0) return [];
        const startOffset = 18;
        const endOffset = 36;
        const x1 = from.x + dx / distance * startOffset;
        const y1 = from.y + dy / distance * startOffset;
        const x2 = to.x - dx / distance * endOffset;
        const y2 = to.y - dy / distance * endOffset;
        const outlined = arrow.role === 'opponent' || arrow.role === 'both';
        const color = BOARD_ARROW_THEME[arrow.role];
        return (
          <g key={`${arrow.layer}-${arrow.fromSquare}-${arrow.toSquare}-${index}`}>
            {outlined ? <line x1={x1} y1={y1} x2={x2} y2={y2} className="board-arrow-outline" /> : null}
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={color}
              markerEnd={`url(#board-arrow-head-${arrow.role})`}
              data-arrow-role={arrow.role}
            />
          </g>
        );
      })}
    </svg>
  );
}

export function RepertoireBoard({
  fen,
  orientation = 'black',
  allowWhiteInput = true,
  inputSide = 'white',
  waiting = false,
  busy = false,
  onWhiteMove,
  annotations = EMPTY_ANNOTATIONS,
  courseAnnotations = EMPTY_ANNOTATIONS,
  storedVariationArrows = EMPTY_LAYER_ARROWS,
  practiceHintArrows = EMPTY_LAYER_ARROWS,
  showArrows = true,
  showStoredVariationArrows = true,
  showPracticeHintArrows = true,
  showHighlights = true,
  soundEnabled = true,
}: RepertoireBoardProps) {
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const legacyAnnotations = annotations ?? EMPTY_ANNOTATIONS;
  const explicitCourseAnnotations =
    courseAnnotations ?? EMPTY_ANNOTATIONS;
  const currentAnnotations = useMemo(
    () => [...legacyAnnotations, ...explicitCourseAnnotations],
    [explicitCourseAnnotations, legacyAnnotations],
  );
  const currentStoredVariationArrows =
    storedVariationArrows ?? EMPTY_LAYER_ARROWS;
  const currentPracticeHintArrows =
    practiceHintArrows ?? EMPTY_LAYER_ARROWS;
  const inputEnabled =
    allowWhiteInput && !waiting && !busy && isSideTurn(fen, inputSide);

  useEffect(() => {
    setSelectedSquare(null);
  }, [fen, inputEnabled]);

  const layeredArrows = useMemo(
    () => [
      ...(showArrows ? collectCourseArrows(currentAnnotations) : []),
      ...(showStoredVariationArrows
        ? collectLayerArrows(
            currentStoredVariationArrows,
            'stored-variation',
          )
        : []),
      ...(showPracticeHintArrows
        ? collectLayerArrows(
            currentPracticeHintArrows,
            'practice-hint',
          )
        : []),
    ],
    [
      currentAnnotations,
      currentPracticeHintArrows,
      currentStoredVariationArrows,
      showArrows,
      showPracticeHintArrows,
      showStoredVariationArrows,
    ],
  );
  const legalTargets = useMemo(() => {
    if (!inputEnabled || !selectedSquare) return [];
    try {
      return new Chess(fen).moves({
        square: selectedSquare as Square,
        verbose: true,
      }).map((move) => ({
        square: move.to,
        capture: move.isCapture(),
        promotion: move.promotion as PromotionPiece | undefined,
      }));
    } catch {
      return [];
    }
  }, [fen, inputEnabled, selectedSquare]);
  const squareStyles = useMemo(() => {
    const styles = showHighlights ? collectHighlights(currentAnnotations) : {};
    if (selectedSquare) styles[selectedSquare] = {
      ...styles[selectedSquare],
      ...SELECTED_SQUARE_STYLE,
    };
    for (const target of legalTargets) {
      styles[target.square] = {
        ...styles[target.square],
        ...(target.capture ? LEGAL_CAPTURE_STYLE : LEGAL_TARGET_STYLE),
      };
    }
    return styles;
  }, [currentAnnotations, legalTargets, selectedSquare, showHighlights]);

  const clickSquare = useCallback((square: string, pieceType?: string): void => {
    if (!inputEnabled) {
      setSelectedSquare(null);
      return;
    }
    if (selectedSquare) {
      const target = legalTargets.find(
        (move) => move.square === square && (!move.promotion || move.promotion === 'q'),
      ) ?? legalTargets.find((move) => move.square === square);
      if (target) {
        const capture = target.capture;
        const accepted = onWhiteMove(
          selectedSquare,
          square,
          target.promotion,
        );
        if (accepted) {
          if (soundEnabled) playMoveSound(capture);
          setSelectedSquare(null);
          return;
        }
      }
    }
    setSelectedSquare(
      pieceType && isSidePiece(pieceType, inputSide) ? square : null,
    );
  }, [inputEnabled, inputSide, legalTargets, onWhiteMove, selectedSquare, soundEnabled]);

  const options = useMemo<ChessboardOptions>(
    () => ({
      id: 'repertoire-board',
      position: fen,
      boardOrientation: orientation,
      animationDurationInMs: 400,
      showAnimations: true,
      allowDragging: inputEnabled,
      allowDragOffBoard: false,
      allowDrawingArrows: false,
      squareStyles,
      canDragPiece: ({ isSparePiece, piece }) =>
        inputEnabled && !isSparePiece && isSidePiece(piece.pieceType, inputSide),
      onSquareClick: ({ piece, square }) => clickSquare(square, piece?.pieceType),
      onPieceDrop: ({ piece, sourceSquare, targetSquare }) => {
        if (
          !inputEnabled ||
          !targetSquare ||
          !isSidePiece(piece.pieceType, inputSide)
        ) {
          return false;
        }

        const promotion: PromotionPiece | undefined =
          piece.pieceType === (inputSide === 'white' ? 'wP' : 'bP') &&
          targetSquare.endsWith(inputSide === 'white' ? '8' : '1')
            ? 'q'
            : undefined;

        let capture = false;
        try {
          capture = new Chess(fen).moves({
            square: sourceSquare as Square,
            verbose: true,
          }).find((move) => move.to === targetSquare && (!move.promotion || move.promotion === promotion))?.isCapture() ?? false;
        } catch {
          // The owning workspace remains the final move validator.
        }
        const accepted = onWhiteMove(sourceSquare, targetSquare, promotion);
        if (accepted && soundEnabled) playMoveSound(capture);
        return accepted;
      },
    }),
    [
      fen,
      inputEnabled,
      clickSquare,
      onWhiteMove,
      orientation,
      inputSide,
      squareStyles,
      soundEnabled,
    ],
  );

  return (
    <div
      className="repertoire-board"
      aria-busy={busy || waiting}
      aria-label="Repertoire chessboard"
      data-course-arrow-count={
        layeredArrows.filter((arrow) => arrow.layer === 'course').length
      }
      data-stored-variation-arrow-count={
        layeredArrows.filter((arrow) => arrow.layer === 'stored-variation')
          .length
      }
      data-practice-hint-arrow-count={
        layeredArrows.filter((arrow) => arrow.layer === 'practice-hint').length
      }
      data-white-input-enabled={inputEnabled}
    >
      {layeredArrows.map((layered, index) => (
        <span
          key={`${layered.layer}-${layered.fromSquare}-${layered.toSquare}-${index}`}
          hidden
          aria-hidden="true"
          data-arrow-layer={layered.layer}
          data-arrow-kind={layered.kind}
          data-arrow-id={layered.id}
          data-arrow-san={layered.san}
          data-arrow-from={layered.fromSquare}
          data-arrow-to={layered.toSquare}
          data-arrow-color={BOARD_ARROW_THEME[layered.role]}
          data-arrow-role={layered.role}
          data-arrow-tooltip={layered.tooltip}
        />
      ))}
      <div className="board-surface">
        <Chessboard options={options} />
        <BoardArrowOverlay arrows={layeredArrows} orientation={orientation} />
      </div>
      {layeredArrows.some((arrow) => arrow.tooltip) ? (
        <div className="board-arrow-details" aria-label="Theory arrow details">
          {layeredArrows.flatMap((arrow) => arrow.tooltip ? [(
            <span
              key={`detail-${arrow.id ?? `${arrow.fromSquare}-${arrow.toSquare}`}`}
              tabIndex={0}
              title={arrow.tooltip}
            >
              {arrow.san ?? `${arrow.fromSquare}–${arrow.toSquare}`}
            </span>
          )] : [])}
        </div>
      ) : null}
    </div>
  );
}
