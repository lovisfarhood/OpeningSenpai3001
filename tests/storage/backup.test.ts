import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LocalDataConflictError,
  LocalDataRepository,
  exportLocalBackup,
  importLocalBackup,
  loadNavigationState,
  loadSettings,
  parseLocalBackup,
  resetLocalData,
  saveNavigationState,
  saveSettings,
  serializeLocalBackup,
} from '../../src/storage/index.js';
import {
  databaseName,
  fixtureAddition,
  fixtureNavigation,
  MemoryStorage,
} from './test-utils.js';

const repositories: LocalDataRepository[] = [];

function repository(label: string): LocalDataRepository {
  const result = new LocalDataRepository({
    databaseName: databaseName(label),
    now: () => '2026-07-24T15:00:00.000Z',
  });
  repositories.push(result);
  return result;
}

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((item) => item.close()));
});

describe('lokale Backups', () => {
  it('exportiert, serialisiert und importiert alle lokalen Daten', async () => {
    const sourceRepository = repository('backup-source');
    const sourceStorage = new MemoryStorage();
    await sourceRepository.saveAddition(fixtureAddition);
    await sourceRepository.setOverride({
      target: { type: 'position', id: 'position-after-c6' },
      field: 'arrows',
      value: { threats: ['d8-h4'], opportunities: ['d7-d5'] },
    });
    await sourceRepository.setConflictSelection('decision-e4', 'reply-c6');
    saveSettings(
      {
        orientation: 'white',
        showArrows: false,
        showHighlights: true,
      },
      sourceStorage,
    );
    saveNavigationState(fixtureNavigation, sourceStorage);

    const backup = await exportLocalBackup({
      repository: sourceRepository,
      storage: sourceStorage,
      now: () => '2026-07-24T16:00:00.000Z',
    });
    const serialized = serializeLocalBackup(backup);
    const parsed = parseLocalBackup(serialized);

    expect(parsed).toMatchObject({
      kind: 'interactive-chessbook-local-backup',
      version: 1,
      exportedAt: '2026-07-24T16:00:00.000Z',
    });

    const targetRepository = repository('backup-target');
    const targetStorage = new MemoryStorage();
    await importLocalBackup(serialized, {
      repository: targetRepository,
      storage: targetStorage,
    });

    expect(await targetRepository.snapshot()).toEqual(
      await sourceRepository.snapshot(),
    );
    expect(loadSettings(targetStorage)).toEqual(loadSettings(sourceStorage));
    expect(loadNavigationState(targetStorage)).toEqual(fixtureNavigation);
  });

  it('weist inkompatible oder strukturell ungültige Backups zurück', () => {
    expect(() => parseLocalBackup('kein json')).toThrow(
      'kein gültiges JSON',
    );
    expect(() =>
      parseLocalBackup(
        JSON.stringify({
          kind: 'interactive-chessbook-local-backup',
          version: 2,
          exportedAt: '2026-07-24T16:00:00.000Z',
          data: {},
        }),
      ),
    ).toThrow('nicht unterstütztes');
  });

  it('überschreibt bei einer Kollision ohne expliziten Modus nichts', async () => {
    const sourceRepository = repository('collision-source');
    const sourceStorage = new MemoryStorage();
    await sourceRepository.setConflictSelection('decision-e4', 'reply-c5');
    const backup = await exportLocalBackup({
      repository: sourceRepository,
      storage: sourceStorage,
    });

    const targetRepository = repository('collision-target');
    const targetStorage = new MemoryStorage();
    await targetRepository.setConflictSelection('decision-e4', 'reply-c6');
    saveSettings(
      {
        orientation: 'white',
        showArrows: false,
        showHighlights: false,
      },
      targetStorage,
    );

    await expect(
      importLocalBackup(backup, {
        repository: targetRepository,
        storage: targetStorage,
      }),
    ).rejects.toBeInstanceOf(LocalDataConflictError);
    expect(
      await targetRepository.getConflictSelection('decision-e4'),
    ).toMatchObject({ replyCandidateId: 'reply-c6' });
    expect(loadSettings(targetStorage).orientation).toBe('white');
  });
});

describe('lokaler Reset', () => {
  it('verlangt eine Bestätigung und lässt ohne sie alle Daten bestehen', async () => {
    const localRepository = repository('reset-no');
    const storage = new MemoryStorage();
    await localRepository.saveAddition(fixtureAddition);
    saveNavigationState(fixtureNavigation, storage);

    await expect(
      resetLocalData({
        confirmed: false,
        repository: localRepository,
        storage,
      }),
    ).rejects.toThrow('Bestätigung fehlt');
    expect(await localRepository.listAdditions()).toHaveLength(1);
    expect(loadNavigationState(storage)).toEqual(fixtureNavigation);
  });

  it('löscht nach Bestätigung IDB-Daten, Settings und Navigation', async () => {
    const localRepository = repository('reset-yes');
    const storage = new MemoryStorage();
    await localRepository.saveAddition(fixtureAddition);
    await localRepository.setConflictSelection('decision-e4', 'reply-c6');
    saveSettings(
      {
        orientation: 'white',
        showArrows: false,
        showHighlights: false,
      },
      storage,
    );
    saveNavigationState(fixtureNavigation, storage);

    await resetLocalData({
      confirmed: true,
      repository: localRepository,
      storage,
    });

    expect(await localRepository.snapshot()).toEqual({
      overrides: [],
      additions: [],
      conflictSelections: [],
    });
    expect(loadSettings(storage).orientation).toBe('black');
    expect(loadNavigationState(storage)).toBeNull();
  });
});
