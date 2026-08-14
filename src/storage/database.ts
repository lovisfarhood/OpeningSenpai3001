import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
} from 'idb';

import type {
  LocalAddition,
  LocalAdditionInput,
  LocalConflictSelection,
  LocalDataSnapshot,
  LocalMarksOverride,
  LocalMarksOverrideInput,
  LocalOverride,
  LocalOverrideInput,
  LocalTextOverride,
  LocalTextOverrideInput,
  SnapshotImportMode,
} from './types.js';

export const LOCAL_DATABASE_NAME = 'interactive-chessbook-local-data';
export const LOCAL_DATABASE_VERSION = 2;

const STORE_NAMES = [
  'overrides',
  'additions',
  'conflictSelections',
] as const;

interface LocalDatabaseSchema extends DBSchema {
  overrides: {
    key: string;
    value: LocalOverride;
  };
  additions: {
    key: string;
    value: LocalAddition;
  };
  conflictSelections: {
    key: string;
    value: LocalConflictSelection;
  };
}

type LocalDatabaseTransaction = IDBPTransaction<
  LocalDatabaseSchema,
  typeof STORE_NAMES,
  'readwrite'
>;

export interface LocalDataRepositoryOptions {
  databaseName?: string;
  now?: () => string;
}

export class LocalDataConflictError extends Error {
  constructor(
    public readonly storeName: (typeof STORE_NAMES)[number],
    public readonly recordId: string,
  ) {
    super(
      `Lokaler Datensatz existiert bereits: ${storeName}/${recordId}`,
    );
    this.name = 'LocalDataConflictError';
  }
}

function targetKey(target: LocalOverrideInput['target']): string {
  return `${target.type}:${encodeURIComponent(target.id)}`;
}

export function localOverrideId(input: LocalOverrideInput): string {
  return `${targetKey(input.target)}:${input.field}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function importRecords(
  transaction: LocalDatabaseTransaction,
  snapshot: LocalDataSnapshot,
  mode: SnapshotImportMode,
): Promise<void> {
  const stores = [
    {
      name: 'overrides' as const,
      records: snapshot.overrides,
      key: (record: LocalOverride) => record.id,
    },
    {
      name: 'additions' as const,
      records: snapshot.additions,
      key: (record: LocalAddition) => record.id,
    },
    {
      name: 'conflictSelections' as const,
      records: snapshot.conflictSelections,
      key: (record: LocalConflictSelection) => record.decisionId,
    },
  ];

  if (mode === 'replace') {
    await Promise.all(
      STORE_NAMES.map((storeName) =>
        transaction.objectStore(storeName).clear(),
      ),
    );
  }

  for (const descriptor of stores) {
    const store = transaction.objectStore(descriptor.name);
    for (const record of descriptor.records) {
      const key = descriptor.key(
        record as LocalOverride & LocalAddition & LocalConflictSelection,
      );
      const existing = await store.get(key);

      if (existing !== undefined && mode === 'reject-conflicts') {
        throw new LocalDataConflictError(descriptor.name, key);
      }
      if (existing !== undefined && mode === 'keep-existing') {
        continue;
      }
      await store.put(record);
    }
  }
}

export class LocalDataRepository {
  readonly databaseName: string;

  private readonly now: () => string;
  private databasePromise: Promise<IDBPDatabase<LocalDatabaseSchema>> | null =
    null;
  private activeOperations = 0;
  private closeRequested = false;

  constructor(options: LocalDataRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? LOCAL_DATABASE_NAME;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private database(): Promise<IDBPDatabase<LocalDatabaseSchema>> {
    this.databasePromise ??= openDB<LocalDatabaseSchema>(
      this.databaseName,
      LOCAL_DATABASE_VERSION,
      {
        upgrade(database) {
          if (!database.objectStoreNames.contains('overrides')) {
            database.createObjectStore('overrides', { keyPath: 'id' });
          }
          if (!database.objectStoreNames.contains('additions')) {
            database.createObjectStore('additions', { keyPath: 'id' });
          }
          if (!database.objectStoreNames.contains('conflictSelections')) {
            database.createObjectStore('conflictSelections', {
              keyPath: 'decisionId',
            });
          }
        },
        blocking: () => {
          const connection = this.databasePromise;
          this.databasePromise = null;
          void connection?.then((database) => database.close());
        },
        terminated: () => {
          this.databasePromise = null;
        },
      },
    ).catch((error: unknown) => {
      this.databasePromise = null;
      throw error;
    });
    return this.databasePromise;
  }

  private isRetryable(error: unknown): boolean {
    return (
      error instanceof DOMException &&
      (error.name === 'InvalidStateError' || error.name === 'AbortError')
    );
  }

  private async run<T>(operation: (database: IDBPDatabase<LocalDatabaseSchema>) => Promise<T>): Promise<T> {
    this.activeOperations += 1;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await operation(await this.database());
        } catch (error) {
          if (attempt > 0 || !this.isRetryable(error)) throw error;
          const stale = this.databasePromise;
          this.databasePromise = null;
          void stale?.then((database) => database.close()).catch(() => undefined);
        }
      }
      throw new Error('Local storage is temporarily unavailable.');
    } finally {
      this.activeOperations -= 1;
      if (this.closeRequested && this.activeOperations === 0) {
        const connection = this.databasePromise;
        this.databasePromise = null;
        this.closeRequested = false;
        void connection?.then((database) => database.close());
      }
    }
  }

  async setOverride(input: LocalTextOverrideInput): Promise<LocalTextOverride>;
  async setOverride(input: LocalMarksOverrideInput): Promise<LocalMarksOverride>;
  async setOverride(input: LocalOverrideInput): Promise<LocalOverride>;
  async setOverride(input: LocalOverrideInput): Promise<LocalOverride> {
    return this.run(async (database) => {
      const id = localOverrideId(input);
      const transaction = database.transaction('overrides', 'readwrite');
      const existing = await transaction.store.get(id);
      const timestamp = this.now();
      const record = { ...clone(input), id, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp } as LocalOverride;
      await transaction.store.put(record);
      await transaction.done;
      return clone(record);
    });
  }

  async getOverride(id: string): Promise<LocalOverride | undefined> {
    return this.run(async (database) => {
      const record = await database.get('overrides', id);
      return record === undefined ? undefined : clone(record);
    });
  }

  async listOverrides(): Promise<LocalOverride[]> {
    return this.run(async (database) => clone(await database.getAll('overrides')));
  }

  async deleteOverride(id: string): Promise<void> {
    await this.run((database) => database.delete('overrides', id));
  }

  async saveAddition(input: LocalAdditionInput): Promise<LocalAddition> {
    return this.run(async (database) => {
      const transaction = database.transaction('additions', 'readwrite');
      const existing = await transaction.store.get(input.id);
      const timestamp = this.now();
      const record: LocalAddition = { ...clone(input), createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp };
      await transaction.store.put(record);
      await transaction.done;
      return clone(record);
    });
  }

  async getAddition(id: string): Promise<LocalAddition | undefined> {
    return this.run(async (database) => {
      const record = await database.get('additions', id);
      return record === undefined ? undefined : clone(record);
    });
  }

  async listAdditions(): Promise<LocalAddition[]> {
    return this.run(async (database) => clone(await database.getAll('additions')));
  }

  async deleteAddition(id: string): Promise<void> {
    await this.run((database) => database.delete('additions', id));
  }

  async setConflictSelection(
    decisionId: string,
    replyCandidateId: string,
  ): Promise<LocalConflictSelection> {
    return this.run(async (database) => {
      const record: LocalConflictSelection = {
      decisionId,
      replyCandidateId,
      updatedAt: this.now(),
      };
      await database.put('conflictSelections', record);
      return clone(record);
    });
  }

  async getConflictSelection(
    decisionId: string,
  ): Promise<LocalConflictSelection | undefined> {
    return this.run(async (database) => {
      const record = await database.get('conflictSelections', decisionId);
      return record === undefined ? undefined : clone(record);
    });
  }

  async listConflictSelections(): Promise<LocalConflictSelection[]> {
    return this.run(async (database) => clone(await database.getAll('conflictSelections')));
  }

  async deleteConflictSelection(decisionId: string): Promise<void> {
    await this.run((database) => database.delete('conflictSelections', decisionId));
  }

  async snapshot(): Promise<LocalDataSnapshot> {
    return this.run(async (database) => {
      const transaction = database.transaction(STORE_NAMES, 'readonly');
      const [overrides, additions, conflictSelections] = await Promise.all([
        transaction.objectStore('overrides').getAll(),
        transaction.objectStore('additions').getAll(),
        transaction.objectStore('conflictSelections').getAll(),
      ]);
      await transaction.done;
      return clone({ overrides, additions, conflictSelections });
    });
  }

  async importSnapshot(
    snapshot: LocalDataSnapshot,
    mode: SnapshotImportMode = 'reject-conflicts',
  ): Promise<void> {
    await this.run(async (database) => {
      const transaction = database.transaction<
      typeof STORE_NAMES,
      'readwrite'
      >(STORE_NAMES, 'readwrite');
      try {
        await importRecords(transaction, clone(snapshot), mode);
        await transaction.done;
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // A failed request may already have aborted the transaction.
        }
        await transaction.done.catch(() => undefined);
        throw error;
      }
    });
  }

  async clearAll(): Promise<void> {
    await this.run(async (database) => {
      const transaction = database.transaction(STORE_NAMES, 'readwrite');
      await Promise.all(STORE_NAMES.map((storeName) => transaction.objectStore(storeName).clear()));
      await transaction.done;
    });
  }

  async close(): Promise<void> {
    this.closeRequested = true;
    if (this.activeOperations !== 0 || this.databasePromise === null) return;
    const database = await this.databasePromise;
    database.close();
    this.databasePromise = null;
    this.closeRequested = false;
  }
}
