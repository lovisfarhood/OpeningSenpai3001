import type {
  CanonicalAnnotation,
  CanonicalRepertoire,
  MoveOrigin,
  ReplyCandidate,
} from '../domain/repertoire.js';
import {
  isPopularityPack,
  type PopularityPack,
} from '../domain/popularity.js';
import { CoursePackRepository } from '../storage/course-packs.js';

const coursePacks = new CoursePackRepository();

function isRepertoire(value: unknown): value is CanonicalRepertoire {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<CanonicalRepertoire>;
  return (
    candidate.formatVersion === '1.0.0' &&
    typeof candidate.rootPosition === 'string' &&
    typeof candidate.positions === 'object' &&
    candidate.positions !== null &&
    typeof candidate.edges === 'object' &&
    candidate.edges !== null &&
    typeof candidate.topology === 'object' &&
    candidate.topology !== null &&
    Array.isArray(candidate.topology.terminalPositions) &&
    Array.isArray(candidate.topology.transpositionPositions) &&
    typeof candidate.whiteTurnNodes === 'object' &&
    candidate.whiteTurnNodes !== null &&
    typeof candidate.repertoireDecisionNodes === 'object' &&
    candidate.repertoireDecisionNodes !== null
  );
}

export async function loadRepertoire(
  processedFile: string,
  signal?: AbortSignal,
): Promise<CanonicalRepertoire> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const id = processedFile.startsWith('local:')
    ? processedFile.slice('local:'.length)
    : processedFile;
  const stored = await coursePacks.get(id);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!stored || !isRepertoire(stored.repertoire)) {
    throw new Error('The canonical repertoire data has an unknown format.');
  }
  return stored.repertoire;
}

export interface OpeningIndexEntry {
  id: string;
  slug: string;
  title: string;
  sourcePath: string;
  sourceCourseUrl: string;
  repertoireSide: 'white' | 'black' | 'unresolved';
  chapterCount: number;
  studyCount: number;
  positionCount: number;
  moveCount: number;
  commentCount: number;
  processingStatus: string;
  conflictCount: number;
  importConflictCount?: number;
  rootFen: string;
  processedFile: string;
  studies: number;
  positions: number;
  opponentChoices: number;
  repertoireDecisions: number;
  maximumDepth: number;
  conflicts: number;
  validationStatus: string;
  issueCount: number;
  availableModes: Array<'book' | 'practice' | 'explorer'>;
}

export async function loadOpeningIndex(signal?: AbortSignal): Promise<OpeningIndexEntry[]> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const stored = await coursePacks.list();
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return stored
    .map((pack) => pack.index)
    .sort((left, right) => left.title.localeCompare(right.title, 'en'));
}

export async function loadPopularityPack(
  openingId: string,
  signal?: AbortSignal,
): Promise<PopularityPack | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(openingId)) return null;
  const response = await fetch(
    `${import.meta.env.BASE_URL}popularity/${openingId}.json`,
    signal ? { signal } : undefined,
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Popularity data could not be loaded (${response.status}).`);
  }
  const value: unknown = await response.json();
  if (!isPopularityPack(value) || value.openingId !== openingId) {
    throw new Error('Popularity data has an unknown format.');
  }
  return value;
}

export function resolveAnnotations(
  repertoire: CanonicalRepertoire,
  position: string,
  ids: string[],
): CanonicalAnnotation[] {
  const requested = new Set(ids);
  return (repertoire.positions[position]?.annotations ?? []).filter(
    (annotation) => requested.has(annotation.id),
  );
}

export function candidateOrigins(
  repertoire: CanonicalRepertoire,
  candidate: ReplyCandidate,
): MoveOrigin[] {
  const requested = new Set(candidate.sourceOriginIds);
  return (repertoire.edges[candidate.replyEdgeId]?.sources ?? []).filter(
    (origin) => requested.has(origin.id),
  );
}
