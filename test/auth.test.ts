import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { connectDb, openDb, getDb, runAsTenant } from '../server/db.js';
import type { TenantScope } from '../server/db.js';
import { createApp } from '../server/app.js';
import { requireApiToken, requireUser, resetLoginLimiter, setTenantHooks } from '../server/auth.js';
import { accountsDb, createInvite, createUser, ensureOwner, openAccounts } from '../server/accounts.js';
import { createEmail, createItem } from '../server/core/items.js';
import { getSettings } from '../server/settings.js';
import type { GmailSource } from '../server/sources/gmail.js';
import { freshAccounts, TEST_EMAIL } from './helpers.js';

process.env.SECRET_KEY = 'test-key-for-unit-tests-only-0123456789';
process.env.APP_PASSWORD = 'correct horse';
process.env.API_TOKEN = 'tok-123';

const servers: Server[] = [];
async function start(app: express.Express): Promise<string> {
  const s = await new Promise<Server>((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
after(() => { for (const s of servers) s.close(); });

function login(base: string, password: string, email = TEST_EMAIL) {
  return fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
}
const json = (base: string, path: string, method: string, body: unknown, cookie = '') => fetch(base + path, {
  method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
});
const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0];

beforeEach(() => {
  openDb(':memory:');
  resetLoginLimiter();
  process.env.APP_PASSWORD = 'correct horse';
  process.env.API_TOKEN = 'tok-123';
  delete process.env.PUBLIC_URL;
  freshAccounts();
});

test('health is unauthenticated', async () => {
  const base = await start(createApp());
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test('wrong password -> 401, right -> 204 + httpOnly lax cookie', async () => {
  const base = await start(createApp());
  assert.equal((await login(base, 'nope')).status, 401);
  assert.equal((await login(base, 'correct horse', 'someone@else')).status, 401);
  assert.equal((await login(base, 'correct horse', 'OWNER@TEST')).status, 204); // email is case-insensitive
  const ok = await login(base, 'correct horse');
  assert.equal(ok.status, 204);
  const sc = ok.headers.get('set-cookie') ?? '';
  assert.match(sc, /^ic_session=/);
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /SameSite=Lax/i);
  assert.doesNotMatch(sc, /Secure/i);
});

test('session token is stored hashed only', async () => {
  const base = await start(createApp());
  const ok = await login(base, 'correct horse');
  const token = cookieOf(ok).split('=')[1];
  const rows = accountsDb().prepare('select * from sessions').all() as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows[0]).includes(token));
});

test('/api/me: 401 without cookie, 200 with, 401 after logout', async () => {
  const base = await start(createApp());
  assert.equal((await fetch(`${base}/api/me`)).status, 401);
  const c = cookieOf(await login(base, 'correct horse'));
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: c } })).status, 200);
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: 'ic_session=forged' } })).status, 401);
  const out = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie: c } });
  assert.equal(out.status, 204);
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: c } })).status, 401);
});

test('expired session is rejected', async () => {
  const base = await start(createApp());
  const c = cookieOf(await login(base, 'correct horse'));
  accountsDb().prepare('update sessions set expires_at = ?').run(Date.now() - 1000);
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: c } })).status, 401);
});

test('6th failed login -> 429, even with the right password', async () => {
  const base = await start(createApp());
  for (let i = 0; i < 5; i++) assert.equal((await login(base, 'bad')).status, 401);
  assert.equal((await login(base, 'bad')).status, 429);
  assert.equal((await login(base, 'correct horse')).status, 429);
});

test('APP_PASSWORD unset: the owner has no password, so password login fails closed', async () => {
  delete process.env.APP_PASSWORD;
  freshAccounts();
  const base = await start(createApp());
  assert.equal((await login(base, '')).status, 401);
  assert.equal((await login(base, 'anything')).status, 401);
});

test('requireApiToken / requireUser guard routes', async () => {
  const app = createApp();
  app.get('/t/api', requireApiToken, (_q, r) => { r.json({ ok: true }); });
  app.get('/t/user', requireUser, (_q, r) => { r.json({ ok: true }); });
  const base = await start(app);
  const get = (p: string, h: Record<string, string> = {}) => fetch(base + p, { headers: h });
  assert.equal((await get('/t/api')).status, 401);
  assert.equal((await get('/t/api', { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await get('/t/api', { authorization: 'Bearer tok-123' })).status, 200);
  assert.equal((await get('/t/user')).status, 401);
  delete process.env.API_TOKEN;
  assert.equal((await get('/t/api', { authorization: 'Bearer ' })).status, 401);
  assert.equal((await get('/t/api', { authorization: 'Bearer undefined' })).status, 401);
});

test('malformed cookie value yields 401, not 500', async () => {
  const base = await start(createApp());
  const h = { cookie: 'ic_session=%' };
  assert.equal((await fetch(`${base}/api/me`, { headers: h })).status, 401);
  assert.equal((await fetch(`${base}/api/logout`, { method: 'POST', headers: h })).status, 204);
});

test('/healthz is unauthenticated and returns only {ok:true}', async () => {
  const base = await start(createApp());
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('owner bootstrap runs once; password is stored hashed', () => {
  openAccounts(':memory:');
  const owner = ensureOwner({ ADMIN_EMAIL: 'me@x.com', APP_PASSWORD: 'correct horse' }, 'app.db');
  assert.equal(owner?.isAdmin, true);
  assert.equal(owner?.dbFile, 'app.db');
  assert.equal(ensureOwner({ ADMIN_EMAIL: 'other@x.com' }, 'app.db'), null);
  const hash = accountsDb().prepare('select password_hash from users').pluck().get() as string;
  assert.match(hash, /^scrypt\$/);
  assert.ok(!hash.includes('correct horse'));
});

test('/api/me says who is logged in, never a password hash', async () => {
  const base = await start(createApp());
  const c = cookieOf(await login(base, 'correct horse'));
  const me = await (await fetch(`${base}/api/me`, { headers: { cookie: c } })).json() as Record<string, unknown>;
  assert.equal(me.email, TEST_EMAIL);
  assert.equal(me.isAdmin, true);
  assert.equal(me.hasPassword, true);
  assert.ok(!JSON.stringify(me).includes('scrypt'));
});

test('invites: owner creates a link; it signs up once, with a minimum password; non-admins cannot invite', async () => {
  process.env.PUBLIC_URL = 'https://ic.example';
  const base = await start(createApp());
  const owner = cookieOf(await login(base, 'correct horse'));
  const inv = await json(base, '/api/admin/invites', 'POST', {}, owner);
  assert.equal(inv.status, 201);
  const { url } = await inv.json() as { url: string };
  assert.match(url, /^https:\/\/ic\.example\/invite\//);
  const token = url.split('/invite/')[1];

  assert.equal((await fetch(`${base}/api/invites/${token}`)).status, 200);
  assert.equal((await fetch(`${base}/api/invites/nope`)).status, 404);
  assert.equal((await json(base, `/api/invites/${token}/accept`, 'POST', { email: 'friend@x.com', password: 'short' })).status, 400);
  assert.equal((await json(base, `/api/invites/${token}/accept`, 'POST', { email: TEST_EMAIL, password: 'long enough pw' })).status, 409);
  const ok = await json(base, `/api/invites/${token}/accept`, 'POST', { email: 'friend@x.com', name: 'Friend', password: 'long enough pw' });
  assert.equal(ok.status, 201);
  const friend = cookieOf(ok);
  assert.match(friend, /^ic_session=/);
  assert.equal((await json(base, `/api/invites/${token}/accept`, 'POST', { email: 'again@x.com', password: 'long enough pw' })).status, 400);
  assert.equal((await fetch(`${base}/api/invites/${token}`)).status, 404); // used

  assert.equal((await login(base, 'long enough pw', 'friend@x.com')).status, 204);
  assert.equal((await json(base, '/api/admin/invites', 'POST', {}, friend)).status, 403);
  assert.equal((await fetch(`${base}/api/admin/users`, { headers: { cookie: friend } })).status, 403);
  const list = await (await fetch(`${base}/api/admin/users`, { headers: { cookie: owner } })).json() as { users: { email: string }[] };
  assert.deepEqual(list.users.map((u) => u.email), [TEST_EMAIL, 'friend@x.com']);
});

test('an invite made out to an email admits only that email; revoked or expired invites are dead', async () => {
  const base = await start(createApp());
  const ownerId = accountsDb().prepare('select id from users').pluck().get() as string;
  const { token } = createInvite(ownerId, 'only@x.com');
  assert.equal((await json(base, `/api/invites/${token}/accept`, 'POST', { email: 'other@x.com', password: 'long enough pw' })).status, 400);
  const expired = createInvite(ownerId, null);
  accountsDb().prepare('update invites set expires_at = ? where email is null').run(Date.now() - 1);
  assert.equal((await fetch(`${base}/api/invites/${expired.token}`)).status, 404);
  assert.equal((await json(base, `/api/invites/${token}/accept`, 'POST', { email: 'only@x.com', password: 'long enough pw' })).status, 201);
});

test('disabling a user ends their sessions; the owner cannot be disabled', async () => {
  const base = await start(createApp());
  const owner = cookieOf(await login(base, 'correct horse'));
  const friend = createUser({ email: 'f@x.com', password: 'long enough pw' });
  const fc = cookieOf(await login(base, 'long enough pw', 'f@x.com'));
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: fc } })).status, 200);
  assert.equal((await json(base, `/api/admin/users/${friend.id}/disabled`, 'POST', { disabled: true }, owner)).status, 204);
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: fc } })).status, 401);
  assert.equal((await login(base, 'long enough pw', 'f@x.com')).status, 401);
  const ownerId = accountsDb().prepare('select id from users where is_admin = 1').pluck().get() as string;
  assert.equal((await json(base, `/api/admin/users/${ownerId}/disabled`, 'POST', { disabled: true }, owner)).status, 400);
});

test('password change needs the current password and ends other sessions', async () => {
  const base = await start(createApp());
  const a = cookieOf(await login(base, 'correct horse'));
  const b = cookieOf(await login(base, 'correct horse'));
  assert.equal((await json(base, '/api/account/password', 'POST', { current: 'wrong', next: 'a new long password' }, a)).status, 403);
  assert.equal((await json(base, '/api/account/password', 'POST', { current: 'correct horse', next: 'a new long password' }, a)).status, 204);
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: a } })).status, 200);
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: b } })).status, 401);
  assert.equal((await login(base, 'a new long password')).status, 204);
});

test('a personal API token works for /api/v1, is shown once, and can be revoked', async () => {
  const base = await start(createApp());
  const c = cookieOf(await login(base, 'correct horse'));
  const { token } = await (await json(base, '/api/account/api-token', 'POST', {}, c)).json() as { token: string };
  assert.equal((await fetch(`${base}/api/v1/summary`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await fetch(`${base}/api/account/api-token`, { method: 'DELETE', headers: { cookie: c } })).status, 204);
  assert.equal((await fetch(`${base}/api/v1/summary`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
});

test('tenants: each user sees only their own database, through the UI API and /api/v1', async () => {
  const owner = accountsDb().prepare('select id from users').pluck().get() as string;
  const friend = createUser({ email: 'f@x.com', password: 'long enough pw' });
  const scopes = new Map<string, TenantScope>([
    [owner, { id: owner, db: connectDb(':memory:') }],
    [friend.id, { id: friend.id, db: connectDb(':memory:') }],
  ]);
  setTenantHooks({ resolve: (u) => scopes.get(u.id)! });
  const seed = (id: string, tag: string) => runAsTenant(scopes.get(id)!, () => {
    createEmail({ messageId: `m-${tag}`, threadId: 't', sender: 's@x.com', subject: tag, receivedAt: '2026-06-01T00:00:00Z', mode: 'ongoing' });
    createItem(`m-${tag}`, `${tag}.pdf`, Buffer.from(`%PDF-1.4 ${tag}`));
  });
  seed(owner, 'owners'); seed(owner, 'owners2'); seed(friend.id, 'friends');

  const deps = () => ({ deps: { storage: null as never, accounting: null, ai: null, settings: getSettings(), now: () => new Date() }, gmail: {} as GmailSource });
  const base = await start(createApp({ getDeps: deps }));
  const oc = cookieOf(await login(base, 'correct horse'));
  const fc = cookieOf(await login(base, 'long enough pw', 'f@x.com'));
  const names = async (c: string) => ((await (await fetch(`${base}/api/items`, { headers: { cookie: c } })).json()) as { items: { attachmentName: string }[] }).items
    .map((i) => i.attachmentName).sort();
  assert.deepEqual(await names(oc), ['owners.pdf', 'owners2.pdf']);
  assert.deepEqual(await names(fc), ['friends.pdf']);

  // Another user's item id is simply not found.
  const ownersId = runAsTenant(scopes.get(owner)!, () => getDb().prepare('select id from items limit 1').pluck().get() as string);
  assert.equal((await fetch(`${base}/api/items/${ownersId}`, { headers: { cookie: fc } })).status, 404);
  assert.equal((await fetch(`${base}/api/items/${ownersId}/pdf`, { headers: { cookie: fc } })).status, 404);

  // Settings written by one user stay theirs.
  assert.equal((await json(base, '/api/settings', 'PUT', { vatRate: 5 }, fc)).status, 200);
  const vat = async (c: string) => ((await (await fetch(`${base}/api/settings`, { headers: { cookie: c } })).json()) as { settings: { vatRate: number } }).settings.vatRate;
  assert.equal(await vat(fc), 5);
  assert.notEqual(await vat(oc), 5);

  // The SSH agent runs on the host: the owner's only.
  assert.equal((await json(base, '/api/settings', 'PUT', { ai: { mode: 'ssh', ssh: { host: 'h', port: 22, user: 'u', hostKeySha256: 'x' } } }, fc)).status, 403);
  assert.equal((await json(base, '/api/secrets/ssh_private_key', 'PUT', { value: 'k' }, fc)).status, 403);

  const { token } = await (await json(base, '/api/account/api-token', 'POST', {}, fc)).json() as { token: string };
  const v1 = await (await fetch(`${base}/api/v1/invoices`, { headers: { authorization: `Bearer ${token}` } })).json() as unknown[];
  assert.equal(v1.length, 1);
  const v1owner = await (await fetch(`${base}/api/v1/invoices`, { headers: { authorization: 'Bearer tok-123' } })).json() as unknown[];
  assert.equal(v1owner.length, 2); // API_TOKEN is the owner's
  setTenantHooks(null);
});
