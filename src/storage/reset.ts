import {
  clearNavigationState,
  clearSettings,
} from './browser-state.js';
import type { LocalDataRepository } from './database.js';

export interface ResetLocalDataOptions {
  confirmed: boolean;
  repository: LocalDataRepository;
  storage: Storage;
}

export async function resetLocalData({
  confirmed,
  repository,
  storage,
}: ResetLocalDataOptions): Promise<void> {
  if (!confirmed) {
    throw new Error(
      'Lokale Daten wurden nicht zurückgesetzt: Bestätigung fehlt.',
    );
  }
  await repository.clearAll();
  clearSettings(storage);
  clearNavigationState(storage);
}
