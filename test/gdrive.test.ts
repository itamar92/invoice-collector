import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDb } from '../server/db.js';
import { setSecret } from '../server/secrets.js';
import { driveQuote, driveSegments, GoogleDriveStorage } from '../server/destinations/gdrive.js';
import { FolderNotFoundError, TransientError } from '../server/core/types.js';

process.env.SECRET_KEY = 'test-key-for-unit-tests-only-0123456789';

interface Call { url: string; init: RequestInit }
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/**
 * A tiny in-memory Drive: folders and files by id with one parent each. Answers the token endpoint, files.list
 * (the `q` forms this client sends), folder create and multipart upload.
 */
function fakeDrive(opts: { fail?: (c: Call) => Response | null } = {}) {
  type Node = { id: string; name: string; parent: string; folder: boolean; md5?: string; created: number };
  const nodes: Node[] = [];
  let seq = 0;
  const calls: Call[] = [];
  const add = (name: string, parent: string, folder: boolean, md5?: string) => {
    const n = { id: `id${++seq}`, name, parent, folder, md5, created: seq };
    nodes.push(n);
    return n;
  };
  const unq = (s: string) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    calls.push(c);
    const failed = opts.fail?.(c);
    if (failed) return failed;
    const u = new URL(c.url);
    if (u.hostname === 'oauth2.googleapis.com') return json(200, { access_token: 'AT', expires_in: 3600 });
    if (u.pathname === '/drive/v3/files' && (c.init.method ?? 'GET') === 'GET') {
      const q = u.searchParams.get('q')!;
      const parent = unq(/^'((?:[^'\\]|\\.)*)' in parents/.exec(q)![1]);
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q);
      const wantFolder = q.includes("mimeType = 'application/vnd.google-apps.folder'");
      const files = nodes
        .filter((n) => n.parent === parent && n.folder === wantFolder && (!name || n.name === unq(name[1])))
        .sort((a, b) => a.created - b.created)
        .map((n) => ({ id: n.id, name: n.name, md5Checksum: n.md5 }));
      return json(200, { files });
    }
    if (u.pathname === '/drive/v3/files' && c.init.method === 'POST') {
      const b = JSON.parse(String(c.init.body));
      const n = add(b.name, b.parents[0], true);
      return json(200, { id: n.id, name: n.name });
    }
    if (u.pathname === '/upload/drive/v3/files') {
      const raw = c.init.body as Buffer;
      const text = raw.toString('utf8');
      const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n/.exec(text)![1]);
      const start = raw.indexOf('Content-Type: application/pdf\r\n\r\n') + 'Content-Type: application/pdf\r\n\r\n'.length;
      const end = raw.lastIndexOf('\r\n--');
      const pdf = raw.subarray(start, end);
      const n = add(meta.name, meta.parents[0], false, createHash('md5').update(pdf).digest('hex'));
      return json(200, { id: n.id, name: n.name });
    }
    return json(404, { error: { message: 'unknown' } });
  }) as typeof fetch;
  return { impl, calls, nodes, add };
}
const drive = (f: ReturnType<typeof fakeDrive>) => new GoogleDriveStorage({ fetchImpl: f.impl, clientId: 'cid', clientSecret: 'cs' });

beforeEach(() => {
  openDb(':memory:');
  setSecret('gdrive_refresh', 'RT');
});

test('path helpers: segments and query quoting', () => {
  assert.deepEqual(driveSegments('/a//b/'), ['a', 'b']);
  assert.deepEqual(driveSegments(''), []);
  assert.equal(driveQuote("it's a\\b"), "'it\\'s a\\\\b'");
});

test('put creates missing folders under My Drive, uploads, and reports the readable path', async () => {
  const f = fakeDrive();
  const d = drive(f);
  const pdf = Buffer.from('%PDF-1.4 hello');
  const r = await d.put('/חשבוניות/2026', "קבלה's.pdf", pdf);
  assert.deepEqual(r, { path: "/חשבוניות/2026/קבלה's.pdf", existed: false });
  const [top, year, file] = f.nodes;
  assert.deepEqual([top.name, top.parent, top.folder], ['חשבוניות', 'root', true]);
  assert.deepEqual([year.name, year.parent], ['2026', top.id]);
  assert.deepEqual([file.name, file.parent, file.folder], ["קבלה's.pdf", year.id, false]);
  // token refresh used the Google client and the Drive refresh token
  const tok = new URLSearchParams(String(f.calls[0].init.body));
  assert.equal(tok.get('refresh_token'), 'RT');
  assert.equal(tok.get('client_secret'), 'cs');
  // The same file again: existed, nothing uploaded, and folders resolved from the cache.
  const before = f.calls.length;
  assert.deepEqual(await d.put('/חשבוניות/2026', "קבלה's.pdf", pdf), { path: "/חשבוניות/2026/קבלה's.pdf", existed: true });
  assert.equal(f.calls.length, before + 1); // one lookup of the file name only
  assert.equal(f.nodes.length, 3);
});

test('exists compares md5 and never creates folders', async () => {
  const f = fakeDrive();
  const d = drive(f);
  const pdf = Buffer.from('a');
  assert.deepEqual(await d.exists('/x/y', 'f.pdf', pdf), { exists: false, sameContent: false });
  assert.equal(f.nodes.length, 0);
  await d.put('/x/y', 'f.pdf', pdf);
  assert.deepEqual(await d.exists('/x/y', 'f.pdf', pdf), { exists: true, sameContent: true });
  assert.deepEqual(await d.exists('/x/y', 'f.pdf', Buffer.from('b')), { exists: true, sameContent: false });
});

test('listFolders: one level, sorted, folders only; missing path -> FolderNotFoundError', async () => {
  const f = fakeDrive();
  const docs = f.add('מסמכים', 'root', true);
  f.add('ב', docs.id, true);
  f.add('א', docs.id, true);
  f.add('file.pdf', docs.id, false);
  const d = drive(f);
  assert.deepEqual(await d.listFolders(''), [{ name: 'מסמכים', path: '/מסמכים' }]);
  assert.deepEqual(await d.listFolders('/מסמכים'), [{ name: 'א', path: '/מסמכים/א' }, { name: 'ב', path: '/מסמכים/ב' }]);
  await assert.rejects(d.listFolders('/nope'), FolderNotFoundError);
});

test('createFolder makes one folder, returns an existing one as is, and needs the parent', async () => {
  const f = fakeDrive();
  const d = drive(f);
  assert.deepEqual(await d.createFolder('', 'קבלות'), { name: 'קבלות', path: '/קבלות' });
  assert.deepEqual(await d.createFolder('/', 'קבלות'), { name: 'קבלות', path: '/קבלות' });
  assert.equal(f.nodes.length, 1);
  await assert.rejects(d.createFolder('/missing', 'x'), FolderNotFoundError);
});

test('errors: 429/5xx/403 rate limit are transient; other 4xx are not; 401 refreshes once', async () => {
  const fail = (status: number, body: unknown) => fakeDrive({
    fail: (c) => (c.url.includes('/drive/v3/files') ? json(status, body) : null),
  });
  await assert.rejects(drive(fail(503, { error: { message: 'down' } })).listFolders(''), TransientError);
  await assert.rejects(drive(fail(429, {})).listFolders(''), TransientError);
  await assert.rejects(drive(fail(403, { error: { message: 'slow', errors: [{ reason: 'userRateLimitExceeded' }] } })).listFolders(''),
    TransientError);
  await assert.rejects(drive(fail(403, { error: { message: 'Drive API has not been used', errors: [{ reason: 'accessNotConfigured' }] } }))
    .listFolders(''), (e: Error) => !(e instanceof TransientError) && /Google Drive 403/.test(e.message));

  let first = true;
  const f = fakeDrive({ fail: (c) => (c.url.includes('/drive/v3/files') && first ? ((first = false), json(401, {})) : null) });
  assert.deepEqual(await drive(f).listFolders(''), []);
  assert.equal(f.calls.filter((c) => c.url.includes('oauth2')).length, 2);
});

test('not connected: a clear error before any network call', async () => {
  setSecret('gdrive_refresh', null);
  const f = fakeDrive();
  await assert.rejects(drive(f).listFolders(''), /Google Drive is not connected/);
  assert.equal(f.calls.length, 0);
});
