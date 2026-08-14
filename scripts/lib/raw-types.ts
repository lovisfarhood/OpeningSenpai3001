import type { AnnotationMarks } from '../../src/domain/repertoire.js';

export interface RawMove {
  fen: string;
  san: string;
  nextFen: string;
  variationId: string;
  variationIndex: number;
}

export interface RawComment {
  text: string;
  arrows: AnnotationMarks | null;
  highlights: AnnotationMarks | null;
}

export type RawMoveFile = Record<string, RawMove[]>;
export type RawCommentFile = Record<string, RawComment[]>;
