import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { accountsDb, adminUser, ensureOwner, openAccounts } from './server/accounts.js';
import { useSharedRecipes } from './server/core/sharedRecipes.js';
import { createApp } from './server/app.js';
import { envProblems } from './server/boot.js';
import { runAsTenant } from './server/db.js';
import { serveSpa } from './server/spa.js';
import { createHub } from './server/relay/hub.js';
import { createTenantRegistry } from './server/tenants.js';
import { startInboxSweeper } from './server/ai/inbox.js';

const problems = envProblems(process.env);
if (problems.length) throw new Error(`refusing to start: ${problems.join('; ')}`);

const dataDir = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(dataDir, { recursive: true });

// Accounts (users, sessions, invites) in accounts.db; each user's invoices in their own database file.
// The first start creates the owner account on the existing app.db, so a single-user install keeps its data.
openAccounts(path.join(dataDir, 'accounts.db'));
const owner = ensureOwner(process.env, 'app.db');
if (owner) console.log(`created the owner account (login: ${owner.email})`);

// Recipes one user's AI wrote are reused by the others (accounts.db holds the library).
useSharedRecipes(accountsDb());

const tenants = createTenantRegistry(dataDir);
tenants.install(); // starts every user's worker and bots

// Leftovers in the SSH agent's shared folder (AI_INBOX_DIR), if a crash skipped the per-request cleanup.
startInboxSweeper();

// Operator only: RELAY_BOT_TOKEN makes this instance the shared bot's hub for other instances.
// The hub's tables live in the owner's database.
let relay: express.Router | undefined;
if (process.env.RELAY_BOT_TOKEN) {
  const ownerUser = adminUser();
  if (!ownerUser) throw new Error('relay hub needs an owner account');
  const scope = tenants.runtimeFor(ownerUser).scope;
  const hub = runAsTenant(scope, () => {
    const h = createHub({ token: process.env.RELAY_BOT_TOKEN!, inviteKey: process.env.RELAY_INVITE_KEY || undefined });
    h.start();
    return h;
  });
  relay = express.Router();
  relay.use((_req, _res, next) => runAsTenant(scope, next), hub.router);
}

const port = parseInt(process.env.PORT || '3100');
const app = createApp({ getDeps: tenants.getDeps, runTick: tenants.runTick }, relay);
// Production serves the built UI (vite build -> dist/); in development Vite serves it and proxies /api here.
if (process.env.NODE_ENV === 'production') serveSpa(app, path.resolve('dist'));
app.listen(port, () => console.log(`invoice-collector listening on :${port}`));
