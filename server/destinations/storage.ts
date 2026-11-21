import type { StorageDestination } from '../core/types.js';
import { setSecret } from '../secrets.js';
import type { SecretKey } from '../secrets.js';
import { getSettings, updateSettings } from '../settings.js';
import type { Settings, StorageProvider } from '../settings.js';

/** The refresh token each cloud keeps. */
export const STORAGE_SECRET: Record<StorageProvider, SecretKey> = { dropbox: 'dropbox_refresh', gdrive: 'gdrive_refresh' };

/**
 * Makes `p` the one cloud PDFs are filed to. The other cloud's token is deleted, so the two can never both be in
 * use. Documents already filed stay where they are.
 */
export function chooseStorage(p: StorageProvider): Settings {
  for (const [other, key] of Object.entries(STORAGE_SECRET)) if (other !== p) setSecret(key, null);
  return getSettings().storageProvider === p ? getSettings() : updateSettings({ storageProvider: p });
}

/** One client per cloud (each holds only a token cache); the settings pick which one the pipeline gets. */
export function storageFor(clients: Record<StorageProvider, StorageDestination>, s: Settings): StorageDestination {
  return clients[s.storageProvider];
}
