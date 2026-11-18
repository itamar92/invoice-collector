import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './server/db.js';
import { createApp } from './server/app.js';
import { markInterruptedBackfill } from './server/core/backfill.js';
import { serveSpa } from './server/spa.js';
import { getAiProvider } from './server/ai/provider.js';
import { DropboxStorage } from './server/destinations/dropbox.js';
import { MorningAccounting } from './server/destinations/morning.js';
import { getSecret } from './server/secrets.js';
import { getSettings } from './server/settings.js';
import { GmailClient } from './server/sources/gmail.js';
import { startWorker } from './server/worker.js';

if (!process.env.SECRET_KEY) throw new Error('SECRET_KEY is not set (see .env.example)');

const dataDir = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(dataDir, { recursive: true });
openDb(path.join(dataDir, 'app.db'));
markInterruptedBackfill(); // a backfill job lives in memory: one that was running before this boot was cut short

// Clients are cheap and hold only token caches; deps are rebuilt per tick so settings changes apply.
const gmail = new GmailClient();
const storage = new DropboxStorage();
const accounting = new MorningAccounting({ mailer: (...a) => gmail.sendMailWithAttachment(...a) });
const getContext = () => {
  if (!getSecret('gmail_refresh')) throw new Error('gmail not connected');
  if (!getSecret('dropbox_refresh')) throw new Error('dropbox not connected');
  const settings = getSettings();
  return {
    gmail,
    deps: { storage, accounting, ai: getAiProvider(settings), settings, now: () => new Date() },
  };
};
const worker = startWorker(getContext);

const port = parseInt(process.env.PORT || '3100');
const app = createApp({ getDeps: getContext, runTick: worker.tick });
// Production serves the built UI (vite build -> dist/); in development Vite serves it and proxies /api here.
if (process.env.NODE_ENV === 'production') serveSpa(app, path.resolve('dist'));
app.listen(port, () => console.log(`invoice-collector listening on :${port}`));
