import { Chess } from 'chess.js';

import { START_FEN } from '../../src/domain/repertoire.js';
import type {
  LoadedStudy,
  LoadedSources,
} from '../../scripts/lib/build-input.js';
import type {
  RawComment,
  RawCommentFile,
  RawMoveFile,
} from '../../scripts/lib/raw-types.js';

export interface FixtureLine {
  sans: string[];
  variationId?: string;
  variationIndex?: number;
}

export interface FixtureStudyOptions {
  sourceType?: 'main' | 'bonus';
  studyFolder: string;
  lines: FixtureLine[];
  comments?: Array<{
    fen: string;
    comment: RawComment;
  }>;
}

function nominalFen(chess: Chess, move: ReturnType<Chess['move']>): string {
  const fields = chess.fen().split(' ');
  if (move.isBigPawn()) {
    const fromRank = Number(move.from[1]);
    const toRank = Number(move.to[1]);
    fields[3] = `${move.from[0]}${(fromRank + toRank) / 2}`;
  }
  return fields.join(' ');
}

export function linePositions(sans: string[]): string[] {
  const result = [START_FEN];
  let fen = START_FEN;
  for (const san of sans) {
    const chess = new Chess(fen);
    const move = chess.move(san, { strict: true });
    fen = nominalFen(chess, move);
    result.push(fen);
  }
  return result;
}

export function createFixtureStudy(options: FixtureStudyOptions): LoadedStudy {
  const sourceType = options.sourceType ?? 'main';
  const moves: RawMoveFile = {};
  const comments: RawCommentFile = {};

  for (const [lineIndex, line] of options.lines.entries()) {
    const positions = linePositions(line.sans);
    const variationId =
      line.variationId ?? `${options.studyFolder}-variation-${lineIndex + 1}`;
    const variationIndex = line.variationIndex ?? lineIndex + 1;
    for (let index = 0; index < line.sans.length; index += 1) {
      const fen = positions[index];
      const nextFen = positions[index + 1];
      const san = line.sans[index];
      if (!fen || !nextFen || !san) {
        throw new Error('Ungültige Fixture-Linie.');
      }
      const values = moves[fen] ?? [];
      values.push({
        fen,
        san,
        nextFen,
        variationId,
        variationIndex,
      });
      moves[fen] = values;
      comments[fen] ??= [];
      comments[nextFen] ??= [];
    }
  }

  for (const annotation of options.comments ?? []) {
    const values = comments[annotation.fen] ?? [];
    values.push(annotation.comment);
    comments[annotation.fen] = values;
  }

  return {
    sourceType,
    courseFolder: sourceType === 'main' ? 'caro-kann' : 'caro-kann-bonus',
    studyFolder: options.studyFolder,
    directory: `/fixture/${options.studyFolder}`,
    metadata: {
      course: sourceType === 'main' ? 'Fixture Main' : 'Fixture Bonus',
      chapter: 'Fixture Chapter',
      study: options.studyFolder,
    },
    movesPath: `/fixture/${options.studyFolder}/moves.json`,
    commentsPath: `/fixture/${options.studyFolder}/comments.json`,
    moves,
    comments,
    movesParseError: null,
    commentsParseError: null,
    rawFiles: [],
  };
}

export function createLoadedSources(studies: LoadedStudy[]): LoadedSources {
  return {
    studies,
    sourceFingerprint: 'sha256:fixture',
    mainPresent: studies.some((study) => study.sourceType === 'main'),
    bonusPresent: studies.some((study) => study.sourceType === 'bonus'),
  };
}

export const emptyComment: RawComment = {
  text: '',
  arrows: null,
  highlights: null,
};
