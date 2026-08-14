import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type NavigationHistoryEntry,
  type NavigationState,
} from './types.js';

export const SETTINGS_STORAGE_KEY =
  'interactive-chessbook:settings:v1';
export const NAVIGATION_STORAGE_KEY =
  'interactive-chessbook:navigation:v1';

function defaultStorage(): Storage {
  if (typeof globalThis.localStorage === 'undefined') {
    throw new Error(
      'LocalStorage ist in dieser Umgebung nicht verfügbar. Übergib eine Storage-Implementierung.',
    );
  }
  return globalThis.localStorage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isNavigationHistoryEntry(
  value: unknown,
): value is NavigationHistoryEntry {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.whiteTurnPosition === 'string' &&
    typeof value.whiteMoveSan === 'string' &&
    typeof value.blackTurnPosition === 'string' &&
    isStringOrNull(value.blackMoveSan) &&
    isStringOrNull(value.resultingWhiteTurnPosition) &&
    isStringOrNull(value.decisionId) &&
    isStringOrNull(value.replyCandidateId)
  );
}

export function isAppSettings(value: unknown): value is AppSettings {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.orientation === 'white' || value.orientation === 'black') &&
    typeof value.showArrows === 'boolean' &&
    typeof value.showHighlights === 'boolean'
  );
}

export function isNavigationState(value: unknown): value is NavigationState {
  if (!isRecord(value) || !Array.isArray(value.history)) {
    return false;
  }
  const historyIndex = value.historyIndex;
  if (typeof historyIndex !== 'number' || !Number.isInteger(historyIndex)) {
    return false;
  }
  return (
    typeof value.currentPosition === 'string' &&
    value.history.every(isNavigationHistoryEntry) &&
    (value.history.length === 0
      ? historyIndex === -1
      : historyIndex >= 0 && historyIndex < value.history.length) &&
    typeof value.updatedAt === 'string'
  );
}

export function loadSettings(
  storage: Storage = defaultStorage(),
): AppSettings {
  const serialized = storage.getItem(SETTINGS_STORAGE_KEY);
  if (serialized === null) {
    return { ...DEFAULT_APP_SETTINGS };
  }
  try {
    const value: unknown = JSON.parse(serialized);
    return isAppSettings(value)
      ? { ...value }
      : { ...DEFAULT_APP_SETTINGS };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

export function saveSettings(
  settings: AppSettings,
  storage: Storage = defaultStorage(),
): void {
  storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export function updateSettings(
  changes: Partial<AppSettings>,
  storage: Storage = defaultStorage(),
): AppSettings {
  const settings = { ...loadSettings(storage), ...changes };
  saveSettings(settings, storage);
  return settings;
}

export function clearSettings(
  storage: Storage = defaultStorage(),
): void {
  storage.removeItem(SETTINGS_STORAGE_KEY);
}

export function loadNavigationState(
  storage: Storage = defaultStorage(),
): NavigationState | null {
  const serialized = storage.getItem(NAVIGATION_STORAGE_KEY);
  if (serialized === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(serialized);
    return isNavigationState(value) ? structuredClone(value) : null;
  } catch {
    return null;
  }
}

export function saveNavigationState(
  state: NavigationState,
  storage: Storage = defaultStorage(),
): void {
  if (!isNavigationState(state)) {
    throw new Error('Ungültiger Navigationszustand.');
  }
  storage.setItem(NAVIGATION_STORAGE_KEY, JSON.stringify(state));
}

export function clearNavigationState(
  storage: Storage = defaultStorage(),
): void {
  storage.removeItem(NAVIGATION_STORAGE_KEY);
}
