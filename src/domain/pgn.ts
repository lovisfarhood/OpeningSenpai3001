import { Chess } from 'chess.js';

import { normalizeFen, stableId } from './repertoire.js';
import type { ExplorerIndex, ExplorerMove } from './explorer.js';
import { explorerPosition } from './explorer.js';

export interface ImportedPgnMove {
  san: string;
  from: string;
  to: string;
  before: string;
  after: string;
  color: 'w' | 'b';
  comment?: string;
}

export interface ImportedPgn {
  id: string;
  name: string;
  pgn: string;
  headers: Readonly<Record<string, string>>;
  initialFen: string;
  moves: readonly ImportedPgnMove[];
}

export interface PgnTheoryPly extends ImportedPgnMove {
  ply: number;
  inTheory: boolean;
  matchedMove: ExplorerMove | null;
  alternatives: readonly ExplorerMove[];
}

export interface PgnTheoryAnalysis {
  plies: readonly PgnTheoryPly[];
  theoryPlies: number;
  theoryPercentage: number;
  lastKnownPly: number | null;
  deviationPly: number | null;
  deviationSan: string | null;
  variationNames: readonly string[];
  alternatives: readonly ExplorerMove[];
  chapters: readonly string[];
  studies: readonly string[];
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en'));
}

export function parsePgn(text: string, filename = 'Imported game'): ImportedPgn {
  const pgn = text.trim();
  if (!pgn) throw new Error('The PGN is empty.');
  const chess = new Chess();
  try {
    chess.loadPgn(pgn, { strict: false });
  } catch (error) {
    throw new Error(`The PGN could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const headers = chess.getHeaders();
  const verbose = chess.history({ verbose: true });
  const comments = new Map(chess.getComments().map((item) => [item.fen, item.comment]));
  if (verbose.length === 0) throw new Error('The PGN contains no moves.');
  const initialFen = headers.SetUp === '1' && headers.FEN
    ? headers.FEN
    : new Chess().fen();
  const name = headers.Event && headers.Event !== '?'
    ? headers.Event
    : filename.replace(/\.pgn$/i, '') || 'Imported game';
  return {
    id: stableId('pgn', [pgn, filename]),
    name,
    pgn,
    headers,
    initialFen,
    moves: verbose.map((move) => {
      const comment = comments.get(move.after);
      return {
        san: move.san,
        from: move.from,
        to: move.to,
        before: move.before,
        after: move.after,
        color: move.color,
        ...(comment ? { comment } : {}),
      };
    }),
  };
}

export function analyzePgn(
  game: ImportedPgn,
  index: ExplorerIndex,
): PgnTheoryAnalysis {
  let stillInTheory = true;
  const plies = game.moves.map((move, offset): PgnTheoryPly => {
    const theory = explorerPosition(index, move.before);
    const matchedMove = theory.moves.find((candidate) =>
      candidate.san === move.san && candidate.targetPosition === normalizeFen(move.after),
    ) ?? null;
    const inTheory = stillInTheory && matchedMove !== null;
    if (!inTheory) stillInTheory = false;
    return {
      ...move,
      ply: offset + 1,
      inTheory,
      matchedMove,
      alternatives: matchedMove ? [] : theory.moves,
    };
  });
  const theoryPlies = plies.filter((ply) => ply.inTheory).length;
  const deviation = plies.find((ply) => !ply.inTheory) ?? null;
  const lastKnown = theoryPlies > 0 ? plies[theoryPlies - 1] ?? null : null;
  const alternatives = deviation?.alternatives ?? [];
  const matched = plies.flatMap((ply) => ply.matchedMove ? [ply.matchedMove] : []);
  return {
    plies,
    theoryPlies,
    theoryPercentage: Math.round((theoryPlies / plies.length) * 100),
    lastKnownPly: lastKnown?.ply ?? null,
    deviationPly: deviation?.ply ?? null,
    deviationSan: deviation?.san ?? null,
    variationNames: unique(matched.flatMap((move) =>
      move.studies.length > 0
        ? move.studies
        : move.sources.map((source) => source.openingTitle),
    )),
    alternatives,
    chapters: unique(alternatives.flatMap((move) => move.chapters)),
    studies: unique(alternatives.flatMap((move) => move.studies)),
  };
}

export function serializeImportedPgns(games: readonly ImportedPgn[]): string {
  return JSON.stringify({ version: 1, games });
}

export function parseStoredPgns(value: string | null): ImportedPgn[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as { version?: unknown; games?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.games)) return [];
    return parsed.games.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object') return [];
      const pgn = (candidate as { pgn?: unknown }).pgn;
      const name = (candidate as { name?: unknown }).name;
      if (typeof pgn !== 'string') return [];
      try { return [parsePgn(pgn, typeof name === 'string' ? name : 'Imported game')]; }
      catch { return []; }
    });
  } catch {
    return [];
  }
}
