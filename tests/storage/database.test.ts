import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LocalDataConflictError,
  LocalDataRepository,
  localOverrideId,
} from '../../src/storage/database.js';
import type { LocalOverrideInput } from '../../src/storage/types.js';
import {
  databaseName,
  fixtureAddition,
} from './test-utils.js';

const repositories: LocalDataRepository[] = [];

function repository(label: string): LocalDataRepository {
  const values = [
    '2026-07-24T15:00:00.000Z',
    '2026-07-24T15:01:00.000Z',
    '2026-07-24T15:02:00.000Z',
  ];
  let index = 0;
  const result = new LocalDataRepository({
    databaseName: databaseName(label),
    now: () => values[index++] ?? '2026-07-24T15:03:00.000Z',
  });
  repositories.push(result);
  return result;
}

const explanationOverride: LocalOverrideInput = {
  target: { type: 'reply-candidate', id: 'reply-c6' },
  field: 'reply-explanation',
  value: 'Lokale Erklärung',
};

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((item) => item.close()));
});

describe('LocalDataRepository', () => {
  it('keeps one managed connection stable during rapid parallel operations', async () => {
    const store = repository('parallel');
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.setConflictSelection(`decision-${index}`, `reply-${index}`),
      ),
    );
    const [selections, additions, overrides] = await Promise.all([
      store.listConflictSelections(),
      store.listAdditions(),
      store.listOverrides(),
    ]);
    expect(selections).toHaveLength(20);
    expect(additions).toEqual([]);
    expect(overrides).toEqual([]);
  });

  it('reopens safely after an explicit close', async () => {
    const store = repository('reopen');
    await store.setConflictSelection('before-close', 'reply-a');
    await store.close();
    await store.setConflictSelection('after-close', 'reply-b');
    expect(await store.listConflictSelections()).toHaveLength(2);
  });

  it('speichert Overrides getrennt und erhält createdAt beim Aktualisieren', async () => {
    const store = repository('override');

    const first = await store.setOverride(explanationOverride);
    const second = await store.setOverride({
      ...explanationOverride,
      value: 'Überarbeitete lokale Erklärung',
    });

    expect(first.id).toBe(localOverrideId(explanationOverride));
    expect(second).toMatchObject({
      id: first.id,
      value: 'Überarbeitete lokale Erklärung',
      createdAt: '2026-07-24T15:00:00.000Z',
      updatedAt: '2026-07-24T15:01:00.000Z',
    });
    expect(await store.listOverrides()).toEqual([second]);
  });

  it('speichert Ergänzungen und Konfliktauswahlen in eigenen Stores', async () => {
    const store = repository('stores');

    const addition = await store.saveAddition(fixtureAddition);
    const selection = await store.setConflictSelection(
      'decision-e4',
      'reply-c6',
    );

    expect(await store.getAddition(fixtureAddition.id)).toEqual(addition);
    expect(await store.getConflictSelection('decision-e4')).toEqual(selection);
    expect(await store.snapshot()).toEqual({
      overrides: [],
      additions: [addition],
      conflictSelections: [selection],
    });
  });

  it('gibt strukturierte Klone zurück statt gespeicherte Werte freizugeben', async () => {
    const store = repository('clone');
    await store.saveAddition(fixtureAddition);

    const loaded = await store.getAddition(fixtureAddition.id);
    loaded?.replies.push({
      id: 'mutated',
      san: 'c5',
      resultingWhiteTurnPosition: 'mutated',
      replyExplanation: null,
      resultingPlan: null,
    });

    expect((await store.getAddition(fixtureAddition.id))?.replies).toHaveLength(
      1,
    );
  });

  it('bricht einen Import mit Schlüsselkollision standardmäßig atomar ab', async () => {
    const store = repository('reject');
    const existing = await store.setOverride(explanationOverride);

    await expect(
      store.importSnapshot({
        overrides: [
          {
            ...existing,
            value: 'Darf nicht überschrieben werden',
          },
        ],
        additions: [
          {
            ...fixtureAddition,
            createdAt: '2026-07-24T14:00:00.000Z',
            updatedAt: '2026-07-24T14:00:00.000Z',
          },
        ],
        conflictSelections: [],
      }),
    ).rejects.toBeInstanceOf(LocalDataConflictError);

    expect(await store.getOverride(existing.id)).toEqual(existing);
    expect(await store.listAdditions()).toEqual([]);
  });

  it('unterstützt explizites Behalten, Überschreiben und Ersetzen', async () => {
    const store = repository('modes');
    const existing = await store.setOverride(explanationOverride);
    const imported = {
      ...existing,
      value: 'Importierte Erklärung',
      updatedAt: '2026-07-24T16:00:00.000Z',
    };

    await store.importSnapshot(
      {
        overrides: [imported],
        additions: [],
        conflictSelections: [],
      },
      'keep-existing',
    );
    expect(await store.getOverride(existing.id)).toEqual(existing);

    await store.importSnapshot(
      {
        overrides: [imported],
        additions: [],
        conflictSelections: [],
      },
      'overwrite',
    );
    expect(await store.getOverride(existing.id)).toEqual(imported);

    await store.importSnapshot(
      {
        overrides: [],
        additions: [
          {
            ...fixtureAddition,
            createdAt: '2026-07-24T16:00:00.000Z',
            updatedAt: '2026-07-24T16:00:00.000Z',
          },
        ],
        conflictSelections: [],
      },
      'replace',
    );
    expect(await store.listOverrides()).toEqual([]);
    expect(await store.listAdditions()).toHaveLength(1);
  });
});
