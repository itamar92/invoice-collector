import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { openDb, getDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { requireApiToken, requireUser, resetLoginLimiter } from '../server/auth.js';

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

function login(base: string, password: string) {
  return fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  });
}
const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0];

beforeEach(() => {
  openDb(':memory:');
  resetLoginLimiter();
  process.env.APP_PASSWORD = 'correct horse';
  process.env.API_TOKEN = 'tok-123';
});

test('health is unauthenticated', async () => {
  const base = await start(createApp());
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test('wrong password -> 401, right -> 204 + httpOnly lax cookie', async () => {
  const base = await start(createApp());
  assert.equal((await login(base, 'nope')).status, 401);
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
  const rows = getDb().prepare('select * from sessions').all() as Record<string, unknown>[];
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
  getDb().prepare('update sessions set expires_at = ?').run(Date.now() - 1000);
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: c } })).status, 401);
});

test('6th failed login -> 429, even with the right password', async () => {
  const base = await start(createApp());
  for (let i = 0; i < 5; i++) assert.equal((await login(base, 'bad')).status, 401);
  assert.equal((await login(base, 'bad')).status, 429);
  assert.equal((await login(base, 'correct horse')).status, 429);
});

test('APP_PASSWORD unset fails closed', async () => {
  delete process.env.APP_PASSWORD;
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
