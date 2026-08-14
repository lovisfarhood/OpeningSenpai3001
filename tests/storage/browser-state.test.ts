import { describe, expect, it } from 'vitest';

import {
  DEFAULT_APP_SETTINGS,
  NAVIGATION_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  clearNavigationState,
  clearSettings,
  loadNavigationState,
  loadSettings,
  saveNavigationState,
  saveSettings,
  updateSettings,
} from '../../src/storage/index.js';
import {
  fixtureNavigation,
  MemoryStorage,
} from './test-utils.js';

describe('LocalStorage-Zustand', () => {
  it('verwendet Schwarzorientierung und sichtbare Markierungen als Defaults', () => {
    expect(loadSettings(new MemoryStorage())).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('speichert und aktualisiert Einstellungen ohne andere Werte zu verlieren', () => {
    const storage = new MemoryStorage();
    saveSettings(
      {
        orientation: 'black',
        showArrows: true,
        showHighlights: false,
      },
      storage,
    );

    expect(updateSettings({ orientation: 'white' }, storage)).toEqual({
      orientation: 'white',
      showArrows: true,
      showHighlights: false,
    });
    expect(loadSettings(storage)).toEqual({
      orientation: 'white',
      showArrows: true,
      showHighlights: false,
    });
  });

  it('fällt bei beschädigten oder veralteten Settings sicher auf Defaults zurück', () => {
    const storage = new MemoryStorage();
    storage.setItem(SETTINGS_STORAGE_KEY, '{"orientation":"sideways"}');

    expect(loadSettings(storage)).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('persistiert die zuletzt besuchte Position samt vollständiger Historie', () => {
    const storage = new MemoryStorage();
    saveNavigationState(fixtureNavigation, storage);

    expect(loadNavigationState(storage)).toEqual(fixtureNavigation);
    clearNavigationState(storage);
    expect(loadNavigationState(storage)).toBeNull();
  });

  it('ignoriert einen strukturell ungültigen Navigationszustand', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      NAVIGATION_STORAGE_KEY,
      JSON.stringify({ ...fixtureNavigation, historyIndex: 99 }),
    );

    expect(loadNavigationState(storage)).toBeNull();
  });

  it('löscht Settings gezielt', () => {
    const storage = new MemoryStorage();
    saveSettings(
      {
        orientation: 'white',
        showArrows: false,
        showHighlights: false,
      },
      storage,
    );
    clearSettings(storage);

    expect(storage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(loadSettings(storage)).toEqual(DEFAULT_APP_SETTINGS);
  });
});
