import type { LocalDataRepository } from './database.js';
import {
  clearNavigationState,
  loadNavigationState,
  loadSettings,
  saveNavigationState,
  saveSettings,
} from './browser-state.js';
import {
  LOCAL_BACKUP_KIND,
  LOCAL_BACKUP_VERSION,
  type LocalBackup,
  type SnapshotImportMode,
} from './types.js';
import { assertLocalBackup } from './validation.js';

export interface ExportLocalBackupOptions {
  repository: LocalDataRepository;
  storage: Storage;
  now?: () => string;
}

export interface ImportLocalBackupOptions {
  repository: LocalDataRepository;
  storage: Storage;
  mode?: SnapshotImportMode;
}

interface DownloadAnchor {
  href: string;
  download: string;
  click(): void;
}

interface DownloadDocument {
  createElement(tagName: 'a'): DownloadAnchor;
}

interface DownloadBlobConstructor {
  new (parts: string[], options: { type: string }): unknown;
}

interface DownloadUrlApi {
  createObjectURL(value: unknown): string;
  revokeObjectURL(url: string): void;
}

export interface BackupDownloadEnvironment {
  document?: DownloadDocument;
  Blob?: DownloadBlobConstructor;
  URL?: DownloadUrlApi;
}

export async function exportLocalBackup({
  repository,
  storage,
  now = () => new Date().toISOString(),
}: ExportLocalBackupOptions): Promise<LocalBackup> {
  const snapshot = await repository.snapshot();
  return {
    kind: LOCAL_BACKUP_KIND,
    version: LOCAL_BACKUP_VERSION,
    exportedAt: now(),
    data: {
      ...snapshot,
      settings: loadSettings(storage),
      navigation: loadNavigationState(storage),
    },
  };
}

export function serializeLocalBackup(backup: LocalBackup): string {
  return `${JSON.stringify(backup, null, 2)}\n`;
}

export function parseLocalBackup(serialized: string): LocalBackup {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error('Das lokale Backup enthält kein gültiges JSON.', {
      cause: error,
    });
  }
  assertLocalBackup(value);
  return structuredClone(value);
}

export async function importLocalBackup(
  backupOrJson: LocalBackup | string,
  {
    repository,
    storage,
    mode = 'reject-conflicts',
  }: ImportLocalBackupOptions,
): Promise<void> {
  const backup =
    typeof backupOrJson === 'string'
      ? parseLocalBackup(backupOrJson)
      : structuredClone(backupOrJson);
  assertLocalBackup(backup);

  await repository.importSnapshot(
    {
      overrides: backup.data.overrides,
      additions: backup.data.additions,
      conflictSelections: backup.data.conflictSelections,
    },
    mode,
  );
  saveSettings(backup.data.settings, storage);
  if (backup.data.navigation === null) {
    clearNavigationState(storage);
  } else {
    saveNavigationState(backup.data.navigation, storage);
  }
}

export function downloadLocalBackup(
  serializedBackup: string,
  filename = 'interactive-chessbook-backup.json',
  environment: BackupDownloadEnvironment = globalThis as unknown as BackupDownloadEnvironment,
): void {
  const documentApi = environment.document;
  const BlobApi = environment.Blob;
  const urlApi = environment.URL;
  if (documentApi === undefined || BlobApi === undefined || urlApi === undefined) {
    throw new Error('Backup-Download ist nur im Browser verfügbar.');
  }
  const url = urlApi.createObjectURL(
    new BlobApi([serializedBackup], { type: 'application/json' }),
  );
  const anchor = documentApi.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  urlApi.revokeObjectURL(url);
}
