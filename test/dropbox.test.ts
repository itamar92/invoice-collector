import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { setSecret, getSecret } from '../server/secrets.js';
import { DropboxStorage, dropboxContentHash, toDropboxPath } from '../server/destinations/dropbox.js';
import { TransientError } from '../server/core/types.js';

process.env.SECRET_KEY = 'test-key-for-unit-tests-only-0123456789';
process.env.APP_PASSWORD = 'pw';
process.env.PUBLIC_URL = 'https://ic.example.test';
process.env.DROPBOX_APP_KEY = 'appkey123';

const sha = (b: Buffer) => createHash('sha256').update(b).digest();

interface Call { url: string; init: RequestInit }
type Responder = (c: Call, n: number) => Response;
function fakeFetch(responders: Responder[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    const n = calls.length;
    calls.push(c);
    const r = responders[Math.min(n, responders.length - 1)];
    return r(c, n);
  }) as typeof fetch;
  return { impl, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const tokenOk = (expires = 14400) => json(200, { access_token: 'AT', expires_in: expires });
const hdr = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

beforeEach(() => {
  openDb(':memory:');
  setSecret('dropbox_refresh', 'RT');
});

test('content hash: empty, small, and 4MB+1 boundary', () => {
  assert.equal(dropboxContentHash(Buffer.alloc(0)), sha(Buffer.alloc(0)).toString('hex'));
  const small = Buffer.from('hello');
  assert.equal(dropboxContentHash(small), sha(sha(small)).toString('hex'));
  const big = Buffer.alloc(4 * 1024 * 1024 + 1, 7);
  const b1 = big.subarray(0, 4 * 1024 * 1024);
  const b2 = big.subarray(4 * 1024 * 1024);
  assert.equal(dropboxContentHash(big), sha(Buffer.concat([sha(b1), sha(b2)])).toString('hex'));
  // exactly 4MB is one block
  assert.equal(dropboxContentHash(b1), sha(sha(b1)).toString('hex'));
});

test('toDropboxPath normalizes slashes', () => {
  assert.equal(toDropboxPath('a/b', 'f.pdf'), '/a/b/f.pdf');
  assert.equal(toDropboxPath('/a//b/', '/f.pdf'), '/a/b/f.pdf');
  assert.equal(toDropboxPath('', 'f.pdf'), '/f.pdf');
});

test('put uploads to folder/filename with add mode, ASCII-safe header for Hebrew', async () => {
  const f = fakeFetch([() => tokenOk(), () => json(200, { path_display: '/חשבוניות/2026/קובץ.pdf' })]);
  const d = new DropboxStorage({ fetchImpl: f.impl, appKey: 'k' });
  const res = await d.put('חשבוניות/2026', 'קובץ.pdf', Buffer.from('x'));
  assert.deepEqual(res, { path: '/חשבוניות/2026/קובץ.pdf', existed: false });
  const up = f.calls[1];
  assert.match(up.url, /content\.dropboxapi\.com\/2\/files\/upload$/);
  const raw = hdr(up, 'Dropbox-API-Arg');
  assert.match(raw, /^[\x20-\x7e]*$/);
  const arg = JSON.parse(raw);
  assert.equal(arg.path, '/חשבוניות/2026/קובץ.pdf');
  assert.equal(arg.mode, 'add');
  assert.equal(arg.autorename, false);
  assert.equal(arg.strict_conflict, true);
  assert.equal(hdr(up, 'Authorization'), 'Bearer AT');
  // token request
  assert.match(f.calls[0].url, /api\.dropbox\.com\/oauth2\/token$/);
  const body = new URLSearchParams(String(f.calls[0].init.body));
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'RT');
  assert.equal(body.get('client_id'), 'k');
});

test('put on 409 conflict returns existed:true without overwriting', async () => {
  const f = fakeFetch([() => tokenOk(), () => json(409, { error_summary: 'path/conflict/file/..' })]);
  const d = new DropboxStorage({ fetchImpl: f.impl, appKey: 'k' });
  assert.deepEqual(await d.put('a', 'b.pdf', Buffer.from('x')), { path: '/a/b.pdf', existed: true });
  assert.equal(f.calls.length, 2);
});

test('exists: not_found, same content, different content', async () => {
  const pdf = Buffer.from('pdf-bytes');
  const nf = fakeFetch([() => tokenOk(), () => json(409, { error_summary: 'path/not_found/..' })]);
  assert.deepEqual(await new DropboxStorage({ fetchImpl: nf.impl, appKey: 'k' }).exists('a', 'b.pdf', pdf),
    { exists: false, sameContent: false });

  const same = fakeFetch([() => tokenOk(), () => json(200, { content_hash: dropboxContentHash(pdf) })]);
  const d = new DropboxStorage({ fetchImpl: same.impl, appKey: 'k' });
  assert.deepEqual(await d.exists('a', 'b.pdf', pdf), { exists: true, sameContent: true });
  assert.equal(JSON.parse(String(same.calls[1].init.body)).path, '/a/b.pdf');

  const diff = fakeFetch([() => tokenOk(), () => json(200, { content_hash: 'deadbeef' })]);
  assert.deepEqual(await new DropboxStorage({ fetchImpl: diff.impl, appKey: 'k' }).exists('a', 'b.pdf', pdf),
    { exists: true, sameContent: false });
});

test('expired access token: refresh once and retry once', async () => {
  const f = fakeFetch([
    () => tokenOk(), () => json(401, { error_summary: 'expired_access_token/..' }),
    () => tokenOk(), () => json(200, { path_display: '/a/b.pdf' }),
  ]);
  const d = new DropboxStorage({ fetchImpl: f.impl, appKey: 'k' });
  assert.equal((await d.put('a', 'b.pdf', Buffer.from('x'))).path, '/a/b.pdf');
  assert.equal(f.calls.length, 4);
});

test('expired twice gives an error, not a loop', async () => {
  const exp = () => json(401, { error_summary: 'expired_access_token/..' });
  const f = fakeFetch([() => tokenOk(), exp, () => tokenOk(), exp]);
  const d = new DropboxStorage({ fetchImpl: f.impl, appKey: 'k' });
  await assert.rejects(d.put('a', 'b.pdf', Buffer.from('x')), (e: Error) => !(e instanceof TransientError));
  assert.equal(f.calls.length, 4);
});

test('access token is cached until 60s before expiry', async () => {
  let t = 1_000_000;
  const f = fakeFetch([(c) => (c.url.includes('oauth2/token') ? tokenOk(3600) : json(200, { path_display: '/a' }))]);
  const d = new DropboxStorage({ fetchImpl: f.impl, appKey: 'k', now: () => t });
  await d.put('a', 'b.pdf', Buffer.from('x'));
  await d.put('a', 'c.pdf', Buffer.from('x'));
  assert.equal(f.calls.filter(c => c.url.includes('oauth2/token')).length, 1);
  t += (3600 - 59) * 1000;
  await d.put('a', 'd.pdf', Buffer.from('x'));
  assert.equal(f.calls.filter(c => c.url.includes('oauth2/token')).length, 2);
});

test('429 / 5xx / network error -> TransientError; other 4xx -> plain Error with summary', async () => {
  const mk = (r: Responder | (() => never)) =>
    new DropboxStorage({ fetchImpl: fakeFetch([() => tokenOk(), r as Responder]).impl, appKey: 'k' });
  await assert.rejects(mk(() => json(429, { error_summary: 'too_many_requests/' }, { 'Retry-After': '7' })).put('a', 'b', Buffer.from('x')),
    (e: Error) => e instanceof TransientError && /7/.test(e.message));
  await assert.rejects(mk(() => json(503, {})).exists('a', 'b', Buffer.from('x')), TransientError);
  await assert.rejects(mk(() => { throw new TypeError('fetch failed'); }).put('a', 'b', Buffer.from('x')), TransientError);
  await assert.rejects(mk(() => json(403, { error_summary: 'no_write_permission/..' })).put('a', 'b', Buffer.from('x')),
    (e: Error) => !(e instanceof TransientError) && /no_write_permission/.test(e.message));
});

test('missing refresh token is a clear error', async () => {
  setSecret('dropbox_refresh', null);
  const d = new DropboxStorage({ fetchImpl: fakeFetch([() => tokenOk()]).impl, appKey: 'k' });
  await assert.rejects(d.put('a', 'b', Buffer.from('x')), /not connected/i);
});

// ---- OAuth routes ----
const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });
async function start() {
  const s = await new Promise<Server>((r) => { const x = createApp().listen(0, '127.0.0.1', () => r(x)); });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
async function loginCookie(base: string) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  return (r.headers.get('set-cookie') ?? '').split(';')[0];
}

test('oauth start requires login, redirects with PKCE + offline', async () => {
  const base = await start();
  assert.equal((await fetch(`${base}/api/oauth/dropbox/start`, { redirect: 'manual' })).status, 401);
  const cookie = await loginCookie(base);
  const r = await fetch(`${base}/api/oauth/dropbox/start`, { redirect: 'manual', headers: { cookie } });
  assert.equal(r.status, 302);
  const u = new URL(r.headers.get('location')!);
  assert.equal(u.origin + u.pathname, 'https://www.dropbox.com/oauth2/authorize');
  assert.equal(u.searchParams.get('token_access_type'), 'offline');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'appkey123');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://ic.example.test/api/oauth/dropbox/callback');
  assert.ok(u.searchParams.get('state'));
});

test('oauth callback: unknown state 400; valid state exchanges code once and stores token', async () => {
  const base = await start();
  const cookie = await loginCookie(base);
  assert.equal((await fetch(`${base}/api/oauth/dropbox/callback?code=c&state=nope`, { redirect: 'manual', headers: { cookie } })).status, 400);
  assert.equal((await fetch(`${base}/api/oauth/dropbox/callback?code=c&state=nope`, { redirect: 'manual' })).status, 401);

  const start1 = await fetch(`${base}/api/oauth/dropbox/start`, { redirect: 'manual', headers: { cookie } });
  const state = new URL(start1.headers.get('location')!).searchParams.get('state')!;
  const challenge = new URL(start1.headers.get('location')!).searchParams.get('code_challenge')!;

  const realFetch = globalThis.fetch;
  let tokenBody: URLSearchParams | null = null;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('dropbox.com/oauth2/token')) {
      tokenBody = new URLSearchParams(String(init?.body));
      return json(200, { access_token: 'a', refresh_token: 'NEWRT' });
    }
    return realFetch(url as string, init);
  }) as typeof fetch;
  try {
    const ok = await fetch(`${base}/api/oauth/dropbox/callback?code=thecode&state=${state}`, { redirect: 'manual', headers: { cookie } });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), '/settings?connected=dropbox');
    assert.equal(getSecret('dropbox_refresh'), 'NEWRT');
    assert.equal(tokenBody!.get('code'), 'thecode');
    assert.equal(tokenBody!.get('grant_type'), 'authorization_code');
    assert.equal(tokenBody!.get('redirect_uri'), 'https://ic.example.test/api/oauth/dropbox/callback');
    assert.equal(createHash('sha256').update(tokenBody!.get('code_verifier')!).digest('base64url'), challenge);
    // one-time use
    const again = await fetch(`${base}/api/oauth/dropbox/callback?code=thecode&state=${state}`, { redirect: 'manual', headers: { cookie } });
    assert.equal(again.status, 400);
  } finally { globalThis.fetch = realFetch; }
});
