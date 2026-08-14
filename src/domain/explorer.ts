import { Chess } from 'chess.js';

import { createVariationIndex, type VariationIndex } from './variations.js';
import { annotationsAfterEdge } from './annotations.js';
import {
  normalizeFen,
  stableId,
  type CanonicalEdge,
  type CanonicalRepertoire,
  type AnnotationMarks,
  type RepertoireSide,
} from './repertoire.js';

export type ExplorerMoveRole = 'repertoire' | 'opponent' | 'both';

export interface ExplorerSource {
  openingId: string;
  title: string;
  repertoireSide: RepertoireSide;
  repertoire: CanonicalRepertoire;
}

export interface ExplorerMoveSource {
  openingId: string;
  openingTitle: string;
  repertoireSide: RepertoireSide;
  edge: CanonicalEdge;
  courses: readonly string[];
  chapters: readonly string[];
  studies: readonly string[];
  studyUrls: readonly string[];
  variationCount: number;
  remainingDepth: number;
  role: Exclude<ExplorerMoveRole, 'both'>;
}

export interface ExplorerMove {
  id: string;
  san: string;
  from: string;
  to: string;
  targetPosition: string;
  sources: readonly ExplorerMoveSource[];
  variationCount: number;
  remainingDepth: number;
  courses: readonly string[];
  chapters: readonly string[];
  studies: readonly string[];
  role: ExplorerMoveRole;
}

export interface ExplorerPosition {
  position: string;
  turn: 'w' | 'b';
  moves: readonly ExplorerMove[];
  variationCount: number;
  remainingDepth: number;
  courses: readonly string[];
  chapters: readonly string[];
  studies: readonly string[];
  openings: readonly string[];
  annotations: readonly ExplorerAnnotation[];
}

export interface ExplorerAnnotation {
  id: string;
  text: string;
  opening: string;
  openings: readonly string[];
  courses: readonly string[];
  chapters: readonly string[];
  studies: readonly string[];
  arrows: AnnotationMarks | null;
  highlights: AnnotationMarks | null;
}

export interface ExplorerIndex {
  sources: readonly ExplorerSource[];
  positions: ReadonlyMap<string, readonly SourcePosition[]>;
}

interface SourcePosition {
  source: ExplorerSource;
  position: string;
}

const singleIndexes = new WeakMap<CanonicalRepertoire, ExplorerIndex>();
const variationIndexes = new WeakMap<CanonicalRepertoire, VariationIndex>();
const outgoingIndexes = new WeakMap<CanonicalRepertoire, ReadonlyMap<string, readonly CanonicalEdge[]>>();
const depthIndexes = new WeakMap<CanonicalRepertoire, Map<string, number>>();

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en'));
}

function normalizedPosition(value: string): string {
  const normalized = value.trim().split(/\s+/).length === 4
    ? value.trim()
    : normalizeFen(value);
  const fields = normalized.split(/\s+/);
  if (fields[3] === '-') return normalized;
  try {
    const chess = new Chess(`${normalized} 0 1`);
    const hasLegalEnPassant = chess.moves({ verbose: true }).some((move) =>
      move.flags.includes('e'),
    );
    if (!hasLegalEnPassant) fields[3] = '-';
  } catch {
    // Validated source positions remain usable with their original EP field.
  }
  return fields.join(' ');
}

function moveCoordinates(fen: string, san: string): { from: string; to: string } | null {
  try {
    const move = new Chess(fen).move(san, { strict: true });
    return { from: move.from, to: move.to };
  } catch {
    return null;
  }
}

function repertoireTurn(side: RepertoireSide): 'w' | 'b' | null {
  return side === 'white' ? 'w' : side === 'black' ? 'b' : null;
}

function aggregateMoveRole(sources: readonly ExplorerMoveSource[]): ExplorerMoveRole {
  const repertoire = sources.some((source) => source.role === 'repertoire');
  const opponent = sources.some((source) => source.role === 'opponent');
  return repertoire && opponent ? 'both' : repertoire ? 'repertoire' : 'opponent';
}

function genericRemainingDepth(
  outgoing: ReadonlyMap<string, readonly CanonicalEdge[]>,
  start: string,
  memo: Map<string, number>,
  visiting = new Set<string>(),
): number {
  const cached = memo.get(start);
  if (cached !== undefined) return cached;
  if (visiting.has(start)) return 0;
  const nextVisiting = new Set(visiting).add(start);
  const edges = outgoing.get(start) ?? [];
  const depth = edges.length === 0
    ? 0
    : 1 + Math.max(...edges.map((edge) =>
        genericRemainingDepth(outgoing, edge.to, memo, nextVisiting),
      ));
  memo.set(start, depth);
  return depth;
}

export function createExplorerIndex(sources: readonly ExplorerSource[]): ExplorerIndex {
  if (sources.length === 1) {
    const cached = singleIndexes.get(sources[0]!.repertoire);
    if (cached) return cached;
  }
  const positions = new Map<string, SourcePosition[]>();
  for (const source of sources) {
    for (const position of Object.keys(source.repertoire.positions)) {
      const normalized = normalizedPosition(position);
      positions.set(normalized, [
        ...(positions.get(normalized) ?? []),
        { source, position },
      ]);
    }
  }
  const result: ExplorerIndex = { sources, positions };
  if (sources.length === 1) singleIndexes.set(sources[0]!.repertoire, result);
  return result;
}

export function explorerPosition(
  index: ExplorerIndex,
  fen: string,
): ExplorerPosition {
  const position = normalizedPosition(fen);
  const sourcePositions = index.positions.get(position) ?? [];
  const moveGroups = new Map<string, ExplorerMoveSource[]>();

  for (const { source, position: sourcePosition } of sourcePositions) {
    let variationIndex = variationIndexes.get(source.repertoire);
    if (!variationIndex) {
      variationIndex = createVariationIndex(source.repertoire);
      variationIndexes.set(source.repertoire, variationIndex);
    }
    let outgoing = outgoingIndexes.get(source.repertoire);
    if (!outgoing) {
      const mutable = new Map<string, CanonicalEdge[]>();
      for (const edge of Object.values(source.repertoire.edges)) {
        mutable.set(edge.from, [...(mutable.get(edge.from) ?? []), edge]);
      }
      outgoing = mutable;
      outgoingIndexes.set(source.repertoire, outgoing);
    }
    let graphMemo = depthIndexes.get(source.repertoire);
    if (!graphMemo) {
      graphMemo = new Map<string, number>();
      depthIndexes.set(source.repertoire, graphMemo);
    }
    for (const edge of outgoing.get(sourcePosition) ?? []) {
      const origins = edge.sources;
      if (origins.length === 0) continue;
      const lineages = variationIndex.remainingLineagesByPosition[edge.to] ?? [];
      const details: ExplorerMoveSource = {
        openingId: source.openingId,
        openingTitle: source.title,
        repertoireSide: source.repertoireSide,
        edge,
        courses: unique(origins.map((origin) => origin.course)),
        chapters: unique(origins.map((origin) => origin.chapter)),
        studies: unique(origins.map((origin) => origin.study)),
        studyUrls: unique(origins.flatMap((origin) => origin.studyUrl ? [origin.studyUrl] : [])),
        variationCount: Math.max(1, lineages.length),
        remainingDepth: genericRemainingDepth(outgoing, edge.to, graphMemo),
        role: repertoireTurn(source.repertoireSide) === source.repertoire.positions[sourcePosition]?.turn
          ? 'repertoire'
          : 'opponent',
      };
      const key = JSON.stringify([edge.san, normalizedPosition(edge.to)]);
      moveGroups.set(key, [...(moveGroups.get(key) ?? []), details]);
    }
  }

  const moves = [...moveGroups.entries()].flatMap(([id, sources]) => {
    const representative = sources[0];
    if (!representative) return [];
    const coordinates = moveCoordinates(fen, representative.edge.san);
    if (!coordinates) return [];
    return [{
      id,
      san: representative.edge.san,
      from: coordinates.from,
      to: coordinates.to,
      targetPosition: normalizedPosition(representative.edge.to),
      sources,
      variationCount: unique(sources.flatMap((source) =>
        source.edge.sources.map((origin) => `${source.openingId}:${origin.studyUrl ?? origin.studyFolder}:${origin.variationId}`),
      )).length,
      remainingDepth: Math.max(...sources.map((source) => source.remainingDepth)),
      courses: unique(sources.flatMap((source) => source.courses)),
      chapters: unique(sources.flatMap((source) => source.chapters)),
      studies: unique(sources.flatMap((source) => source.studies)),
      role: aggregateMoveRole(sources),
    }];
  }).sort((left, right) =>
    right.variationCount - left.variationCount || left.san.localeCompare(right.san, 'en'),
  );

  const allOrigins = sourcePositions.flatMap(({ source, position: sourcePosition }) =>
    (outgoingIndexes.get(source.repertoire)?.get(sourcePosition) ?? [])
      .flatMap((edge) => edge.sources),
  );
  const annotations = [...new Map(sourcePositions.flatMap(({ source, position: sourcePosition }) =>
    (source.repertoire.positions[sourcePosition]?.annotations ?? []).map((annotation) => {
      const value: ExplorerAnnotation = {
        id: `${source.openingId}:${annotation.id}`,
        text: annotation.text,
        opening: source.title,
        openings: [source.title],
        courses: unique(annotation.sources.map((origin) => origin.course)),
        chapters: unique(annotation.sources.map((origin) => origin.chapter)),
        studies: unique(annotation.sources.map((origin) => origin.study)),
        arrows: annotation.arrows,
        highlights: annotation.highlights,
      };
      return [value.id, value] as const;
    }),
  )).values()];
  return {
    position,
    turn: fen.trim().split(/\s+/)[1] === 'b' ? 'b' : 'w',
    moves,
    variationCount: unique(allOrigins.map((origin) =>
      `${origin.studyUrl ?? `${origin.courseFolder}/${origin.studyFolder}`}:${origin.variationId}`,
    )).length,
    remainingDepth: Math.max(0, ...moves.map((move) => move.remainingDepth + 1)),
    courses: unique(allOrigins.map((origin) => origin.course)),
    chapters: unique(allOrigins.map((origin) => origin.chapter)),
    studies: unique(allOrigins.map((origin) => origin.study)),
    openings: unique(sourcePositions.map(({ source }) => source.title)),
    annotations,
  };
}

/** Returns only comments attached to the move that has just been played. */
export function explorerAnnotationsAfterMove(
  index: ExplorerIndex,
  move: ExplorerMove | null | undefined,
): ExplorerAnnotation[] {
  if (!move) return [];
  const grouped = new Map<string, {
    text: string;
    openings: Set<string>;
    courses: Set<string>;
    chapters: Set<string>;
    studies: Set<string>;
    arrows: AnnotationMarks | null;
    highlights: AnnotationMarks | null;
  }>();

  for (const moveSource of move.sources) {
    const source = index.sources.find(
      (candidate) => candidate.openingId === moveSource.openingId,
    );
    if (!source) continue;
    for (const annotation of annotationsAfterEdge(source.repertoire, moveSource.edge)) {
      const signature = JSON.stringify([
        annotation.text,
        annotation.arrows,
        annotation.highlights,
      ]);
      const current = grouped.get(signature) ?? {
        text: annotation.text,
        openings: new Set<string>(),
        courses: new Set<string>(),
        chapters: new Set<string>(),
        studies: new Set<string>(),
        arrows: annotation.arrows,
        highlights: annotation.highlights,
      };
      current.openings.add(source.title);
      for (const origin of annotation.sources) {
        current.courses.add(origin.course);
        current.chapters.add(origin.chapter);
        current.studies.add(origin.study);
      }
      grouped.set(signature, current);
    }
  }

  return [...grouped.entries()].map(([signature, value]) => {
    const openings = unique(value.openings);
    return {
      id: stableId('explorer-annotation', [move.id, signature]),
      text: value.text,
      opening: openings.join(', '),
      openings,
      courses: unique(value.courses),
      chapters: unique(value.chapters),
      studies: unique(value.studies),
      arrows: value.arrows,
      highlights: value.highlights,
    };
  }).sort((left, right) => left.text.localeCompare(right.text, 'en'));
}
