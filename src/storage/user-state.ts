import type { PracticeLineProgressMap } from '../domain/practice.js';

export const USER_STATE_STORAGE_KEY = 'interactive-chessbook:user-state:v4';
export const PREVIOUS_USER_STATE_STORAGE_KEY = 'interactive-chessbook:user-state:v3';
export const LEGACY_USER_STATE_STORAGE_KEY = 'interactive-chessbook:user-state:v2';
export const OLDEST_USER_STATE_STORAGE_KEY = 'interactive-chessbook:user-state:v1';

export interface PracticeStartingPosition {
  edgeIds: string[];
}

interface UserState {
  favorites: string[];
  practiceLineProgress: Record<string, PracticeLineProgressMap>;
  practiceMoveProgress: Record<string, PracticeLineProgressMap>;
  practiceStartingPositions: Record<string, PracticeStartingPosition[]>;
}

const EMPTY_STATE: UserState = {
  favorites: [],
  practiceLineProgress: {},
  practiceMoveProgress: {},
  practiceStartingPositions: {},
};

function storageOrDefault(storage?: Storage): Storage | null {
  if (storage) return storage;
  return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
}

function normalizeStartingPositions(value: unknown): Record<string, PracticeStartingPosition[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([openingId, stored]) => {
    const candidates = Array.isArray(stored) ? stored : [stored];
    const positions = candidates.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object' || !Array.isArray((candidate as PracticeStartingPosition).edgeIds)) return [];
      return [{
        edgeIds: (candidate as PracticeStartingPosition).edgeIds.filter(
          (item): item is string => typeof item === 'string',
        ),
      }];
    });
    const unique = [...new Map(positions.map((position) => [JSON.stringify(position.edgeIds), position])).values()];
    return unique.length > 0 ? [[openingId, unique] as const] : [];
  }));
}

function parseState(serialized: string, includeProgress: boolean): UserState | null {
  try {
    const value = JSON.parse(serialized) as Partial<UserState>;
    return {
      favorites: Array.isArray(value.favorites)
        ? value.favorites.filter((item): item is string => typeof item === 'string')
        : [],
      practiceLineProgress: includeProgress && value.practiceLineProgress && typeof value.practiceLineProgress === 'object'
        ? value.practiceLineProgress
        : {},
      practiceMoveProgress: includeProgress && value.practiceMoveProgress && typeof value.practiceMoveProgress === 'object'
        ? value.practiceMoveProgress
        : {},
      practiceStartingPositions: normalizeStartingPositions(value.practiceStartingPositions),
    };
  } catch {
    return null;
  }
}

function read(storage?: Storage): UserState {
  const target = storageOrDefault(storage);
  if (!target) return structuredClone(EMPTY_STATE);
  const current = target.getItem(USER_STATE_STORAGE_KEY);
  if (current !== null) return parseState(current, true) ?? structuredClone(EMPTY_STATE);

  const legacyKey = [
    PREVIOUS_USER_STATE_STORAGE_KEY,
    LEGACY_USER_STATE_STORAGE_KEY,
    OLDEST_USER_STATE_STORAGE_KEY,
  ].find((key) => target.getItem(key) !== null);
  if (!legacyKey) return structuredClone(EMPTY_STATE);
  const legacy = target.getItem(legacyKey);
  if (legacy === null) return structuredClone(EMPTY_STATE);
  const migrated = parseState(legacy, legacyKey === PREVIOUS_USER_STATE_STORAGE_KEY);
  if (!migrated) return structuredClone(EMPTY_STATE);
  target.setItem(USER_STATE_STORAGE_KEY, JSON.stringify(migrated));
  target.removeItem(legacyKey);
  return migrated;
}

function write(value: UserState, storage?: Storage): void {
  storageOrDefault(storage)?.setItem(USER_STATE_STORAGE_KEY, JSON.stringify(value));
}

/** The sole persistence boundary for explicitly requested personal UI state. */
export class UserStateStore {
  constructor(private readonly storage?: Storage) {}

  getFavorites(): string[] {
    return [...read(this.storage).favorites];
  }

  setFavorite(openingId: string, favorite: boolean): string[] {
    const state = read(this.storage);
    const favorites = new Set(state.favorites);
    if (favorite) favorites.add(openingId);
    else favorites.delete(openingId);
    state.favorites = [...favorites].sort();
    write(state, this.storage);
    return [...state.favorites];
  }

  getPracticeLineProgress(openingId: string): PracticeLineProgressMap {
    return structuredClone(read(this.storage).practiceLineProgress[openingId] ?? {});
  }

  setPracticeLineProgress(openingId: string, progress: PracticeLineProgressMap): void {
    const state = read(this.storage);
    state.practiceLineProgress[openingId] = structuredClone(progress);
    write(state, this.storage);
  }

  getPracticeMoveProgress(openingId: string): PracticeLineProgressMap {
    return structuredClone(read(this.storage).practiceMoveProgress[openingId] ?? {});
  }

  setPracticeMoveProgress(openingId: string, progress: PracticeLineProgressMap): void {
    const state = read(this.storage);
    state.practiceMoveProgress[openingId] = structuredClone(progress);
    write(state, this.storage);
  }

  getPracticeStartingPositions(openingId: string): PracticeStartingPosition[] {
    return structuredClone(read(this.storage).practiceStartingPositions[openingId] ?? []);
  }

  setPracticeStartingPositions(openingId: string, positions: PracticeStartingPosition[]): void {
    const state = read(this.storage);
    state.practiceStartingPositions[openingId] = structuredClone(positions);
    write(state, this.storage);
  }

  getPracticeStartingPosition(openingId: string): PracticeStartingPosition | null {
    return this.getPracticeStartingPositions(openingId)[0] ?? null;
  }

  setPracticeStartingPosition(openingId: string, position: PracticeStartingPosition): void {
    this.setPracticeStartingPositions(openingId, [position]);
  }
}
