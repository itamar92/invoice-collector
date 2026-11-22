import fs from 'node:fs';
import path from 'node:path';
import { getAiProvider } from './ai/provider.js';
import { listUsers } from './accounts.js';
import type { User } from './accounts.js';
import { setTenantHooks } from './auth.js';
import { prepareTenantDb } from './boot.js';
import { connectDb, currentTenantId, runAsTenant } from './db.js';
import type { Db, TenantScope } from './db.js';
import { DropboxStorage } from './destinations/dropbox.js';
import { GoogleDriveStorage } from './destinations/gdrive.js';
import { MorningAccounting } from './destinations/morning.js';
import { STORAGE_SECRET, storageFor } from './destinations/storage.js';
import { getSecret } from './secrets.js';
import { getSettings } from './settings.js';
import { GmailClient } from './sources/gmail.js';
import { startRelayClient } from './sources/relayClient.js';
import { startTelegramBot } from './sources/telegram.js';
import { startWorker } from './worker.js';
import type { WorkerContext } from './worker.js';

/** Everything one user's invoices run on: their database, API clients (token caches), worker and bots. */
interface Runtime {
  scope: TenantScope;
  getContext: () => WorkerContext;
  tick: () => Promise<void>;
  stop: () => void;
}

/**
 * One runtime per user, created on first use (or at boot) and kept for the life of the process.
 * Background work (worker timer, Telegram polling) is started inside the user's scope, so every timer
 * and promise it creates keeps reading and writing that user's database only.
 */
export function createTenantRegistry(dataDir: string) {
  const runtimes = new Map<string, Runtime>();

  function dbPath(user: User): string {
    if (!user.dbFile) throw new Error(`user ${user.id} has no database file`);
    const file = path.resolve(dataDir, user.dbFile);
    if (!file.startsWith(path.resolve(dataDir) + path.sep)) throw new Error('database file outside DATA_DIR');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return file;
  }

  function create(user: User): Runtime {
    const db: Db = connectDb(dbPath(user));
    const scope: TenantScope = { id: user.id, db };
    return runAsTenant(scope, () => {
      prepareTenantDb();
      // Clients are cheap and hold only token caches; deps are rebuilt per tick so settings changes apply.
      const gmail = new GmailClient();
      const clouds = { dropbox: new DropboxStorage(), gdrive: new GoogleDriveStorage() };
      const accounting = new MorningAccounting({ mailer: (...a) => gmail.sendMailWithAttachment(...a) });
      const getContext = (): WorkerContext => {
        if (!getSecret('gmail_refresh')) throw new Error('gmail not connected');
        const settings = getSettings();
        if (!getSecret(STORAGE_SECRET[settings.storageProvider])) throw new Error(`${settings.storageProvider} not connected`);
        return {
          gmail,
          deps: { storage: storageFor(clouds, settings), accounting, ai: getAiProvider(settings), settings, now: () => new Date() },
        };
      };
      const worker = startWorker(getContext);
      const botDeps = () => { try { return getContext().deps; } catch { return null; } };
      // Receipts sent to this user's own Telegram bot, or to a shared bot they connected; idle otherwise.
      const bot = startTelegramBot(botDeps);
      const relay = startRelayClient(botDeps);
      return {
        scope, getContext, tick: worker.tick,
        stop: () => { worker.stop(); bot.stop(); relay.stop(); db.close(); },
      };
    });
  }

  function runtimeFor(user: User): Runtime {
    let rt = runtimes.get(user.id);
    if (!rt) { rt = create(user); runtimes.set(user.id, rt); }
    return rt;
  }

  /** The runtime of the tenant the current request runs for. */
  function current(): Runtime {
    const id = currentTenantId();
    const rt = id ? runtimes.get(id) : undefined;
    if (!rt) throw new Error('no tenant for this request');
    return rt;
  }

  function stop(userId: string): void {
    const rt = runtimes.get(userId);
    runtimes.delete(userId);
    rt?.stop();
  }

  /** Install as the auth layer's resolver, and start every active user's background work now. */
  function install(): void {
    setTenantHooks({ resolve: (u) => runtimeFor(u).scope, disabled: stop });
    for (const u of listUsers()) {
      if (u.disabled) continue;
      try { runtimeFor(u); } catch (e) { console.error(`tenant ${u.id} not started:`, e instanceof Error ? e.message : e); }
    }
  }

  return {
    install,
    runtimeFor,
    /** ApiContext for the routes: always the requesting user's own deps and worker. */
    getDeps: () => current().getContext(),
    runTick: () => current().tick(),
    stopAll: () => { for (const id of [...runtimes.keys()]) stop(id); },
  };
}
