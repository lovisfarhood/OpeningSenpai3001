import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import type { OpeningIndexEntry } from '../data/repertoire.js';
import type { CanonicalRepertoire } from '../domain/repertoire.js';

export const COURSE_PACK_DATABASE_NAME =
  'interactive-chessbook-course-packs';
export const COURSE_PACK_DATABASE_VERSION = 1;

export interface StoredCoursePack {
  id: string;
  importedAt: string;
  index: OpeningIndexEntry;
  repertoire: CanonicalRepertoire;
}

interface CoursePackDatabaseSchema extends DBSchema {
  coursePacks: {
    key: string;
    value: StoredCoursePack;
  };
}

export interface CoursePackRepositoryOptions {
  databaseName?: string;
  now?: () => string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Keeps personally imported course content inside the current browser. */
export class CoursePackRepository {
  readonly databaseName: string;

  private readonly now: () => string;
  private databasePromise: Promise<IDBPDatabase<CoursePackDatabaseSchema>> | null =
    null;

  constructor(options: CoursePackRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? COURSE_PACK_DATABASE_NAME;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private database(): Promise<IDBPDatabase<CoursePackDatabaseSchema>> {
    this.databasePromise ??= openDB<CoursePackDatabaseSchema>(
      this.databaseName,
      COURSE_PACK_DATABASE_VERSION,
      {
        upgrade(database) {
          if (!database.objectStoreNames.contains('coursePacks')) {
            database.createObjectStore('coursePacks', { keyPath: 'id' });
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

  async list(): Promise<StoredCoursePack[]> {
    const database = await this.database();
    return clone(await database.getAll('coursePacks'));
  }

  async get(id: string): Promise<StoredCoursePack | undefined> {
    const database = await this.database();
    const value = await database.get('coursePacks', id);
    return value === undefined ? undefined : clone(value);
  }

  async save(
    index: OpeningIndexEntry,
    repertoire: CanonicalRepertoire,
  ): Promise<StoredCoursePack> {
    const database = await this.database();
    const record: StoredCoursePack = {
      id: index.id,
      importedAt: this.now(),
      index: clone(index),
      repertoire: clone(repertoire),
    };
    await database.put('coursePacks', record);
    return clone(record);
  }

  async delete(id: string): Promise<void> {
    const database = await this.database();
    await database.delete('coursePacks', id);
  }

  async clear(): Promise<void> {
    const database = await this.database();
    await database.clear('coursePacks');
  }

  async close(): Promise<void> {
    const connection = this.databasePromise;
    this.databasePromise = null;
    const database = await connection;
    database?.close();
  }
}
