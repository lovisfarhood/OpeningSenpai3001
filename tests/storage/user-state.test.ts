import { describe, expect, it } from 'vitest';

import {
  LEGACY_USER_STATE_STORAGE_KEY,
  PREVIOUS_USER_STATE_STORAGE_KEY,
  USER_STATE_STORAGE_KEY,
  UserStateStore,
} from '../../src/storage/user-state.js';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe('UserStateStore', () => {
  it('persists only favorites, line progress, and practice starting positions', () => {
    const storage = new MemoryStorage();
    const store = new UserStateStore(storage);
    expect(store.setFavorite('complete-1-e4', true)).toEqual(['complete-1-e4']);
    store.setPracticeLineProgress('complete-1-e4', {
      stableLine: { mistakes: 4, cleanRuns: 1 },
    });
    store.setPracticeStartingPosition('complete-1-e4', { edgeIds: ['a', 'b'] });

    const serialized = storage.getItem(USER_STATE_STORAGE_KEY) ?? '';
    expect(JSON.parse(serialized)).toEqual({
      favorites: ['complete-1-e4'],
      practiceLineProgress: {
        'complete-1-e4': { stableLine: { mistakes: 4, cleanRuns: 1 } },
      },
      practiceMoveProgress: {},
      practiceStartingPositions: {
        'complete-1-e4': [{ edgeIds: ['a', 'b'] }],
      },
    });
    expect(serialized).not.toMatch(/search|mode|pgn|history|orientation/i);
  });

  it('preserves favorites and starting positions while invalidating legacy leaf counters', () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_USER_STATE_STORAGE_KEY, JSON.stringify({
      favorites: ['caro-kann'],
      practiceLineProgress: {
        'caro-kann': { obsoleteLeafId: { n: 7, mastered: false } },
      },
      practiceStartingPositions: {
        'caro-kann': { edgeIds: ['e4', 'c6'] },
      },
    }));
    const store = new UserStateStore(storage);

    expect(store.getFavorites()).toEqual(['caro-kann']);
    expect(store.getPracticeStartingPosition('caro-kann')).toEqual({ edgeIds: ['e4', 'c6'] });
    expect(store.getPracticeLineProgress('caro-kann')).toEqual({});
    expect(storage.getItem(LEGACY_USER_STATE_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(USER_STATE_STORAGE_KEY)).not.toBeNull();
  });

  it('keeps compatible v3 x/c progress and expands its single starting position to a list', () => {
    const storage = new MemoryStorage();
    storage.setItem(PREVIOUS_USER_STATE_STORAGE_KEY, JSON.stringify({
      favorites: ['vienna'],
      practiceLineProgress: { vienna: { stableItem: { mistakes: 3, cleanRuns: 1 } } },
      practiceStartingPositions: { vienna: { edgeIds: ['e4', 'e5'] } },
    }));
    const store = new UserStateStore(storage);

    expect(store.getPracticeLineProgress('vienna')).toEqual({ stableItem: { mistakes: 3, cleanRuns: 1 } });
    expect(store.getPracticeStartingPositions('vienna')).toEqual([{ edgeIds: ['e4', 'e5'] }]);
    expect(storage.getItem(PREVIOUS_USER_STATE_STORAGE_KEY)).toBeNull();
  });
});
