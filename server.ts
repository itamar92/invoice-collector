import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './server/app.js';
import { envProblems, initDataStore } from './server/boot.js';
import { serveSpa } from './server/spa.js';
import { getAiProvider } from './server/ai/provider.js';
import { DropboxStorage } from './server/destinations/dropbox.js';
import { GoogleDriveStorage } from './server/destinations/gdrive.js';
import { STORAGE_SECRET, storageFor } from './server/destinations/storage.js';
import { MorningAccounting } from './server/destinations/morning.js';
import { getSecret } from './server/secrets.js';
import { getSettings } from './server/settings.js';
import { GmailClient } from './server/sources/gmail.js';
import { createHub } from './server/relay/hub.js';
import { startRelayClient } from './server/sources/relayClient.js';
import { startTelegramBot } from './server/sources/telegram.js';
import { startWorker } from './server/worker.js';
import { startInboxSweeper } from './server/ai/inbox.js';

const problems = envProblems(process.env);
if (problems.length) throw new Error(`refusing to start: ${problems.join('; ')}`);

const dataDir = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(dataDir, { recursive: true });
initDataStore(path.join(dataDir, 'app.db'));

// Clients are cheap and hold only token caches; deps are rebuilt per tick so settings changes apply.
const gmail = new GmailClient();
const clouds = { dropbox: new DropboxStorage(), gdrive: new GoogleDriveStorage() };
const accounting = new MorningAccounting({ mailer: (...a) => gmail.sendMailWithAttachment(...a) });
const getContext = () => {
  if (!getSecret('gmail_refresh')) throw new Error('gmail not connected');
  const settings = getSettings();
  if (!getSecret(STORAGE_SECRET[settings.storageProvider])) throw new Error(`${settings.storageProvider} not connected`);
  return {
    gmail,
    deps: { storage: storageFor(clouds, settings), accounting, ai: getAiProvider(settings), settings, now: () => new Date() },
  };
};
const worker = startWorker(getContext);
// Leftovers in the SSH agent's shared folder (AI_INBOX_DIR), if a crash skipped the per-request cleanup.
startInboxSweeper();
// Receipts sent to the Telegram bot; idle until a bot token is saved in Settings.
const botDeps = () => { try { return getContext().deps; } catch { return null; } };
startTelegramBot(botDeps);
// Receipts sent to a shared bot this instance is connected to (Settings); idle otherwise.
startRelayClient(botDeps);
// Operator only: RELAY_BOT_TOKEN makes this instance the shared bot's hub for other instances.
const hub = process.env.RELAY_BOT_TOKEN
  ? createHub({ token: process.env.RELAY_BOT_TOKEN, inviteKey: process.env.RELAY_INVITE_KEY || undefined })
  : null;
hub?.start();

const port = parseInt(process.env.PORT || '3100');
const app = createApp({ getDeps: getContext, runTick: worker.tick }, hub?.router);
// Production serves the built UI (vite build -> dist/); in development Vite serves it and proxies /api here.
if (process.env.NODE_ENV === 'production') serveSpa(app, path.resolve('dist'));
app.listen(port, () => console.log(`invoice-collector listening on :${port}`));
