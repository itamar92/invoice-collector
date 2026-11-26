import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshAccounts } from './helpers.js';
import { openDb } from '../server/db.js';
import { getEmail, getItem, listItems } from '../server/core/items.js';
import type { Deps, FileEntry, StorageDestination } from '../server/core/types.js';
import { getSettings } from '../server/settings.js';
import { collectInbox, resetInboxMemory } from '../server/sources/storageInbox.js';

process.env.SECRET_KEY = 'test-key-for-unit-tests-only-0123456789';

const JPEG = readFileSync(new URL('./fixtures/receipt-photo.jpg', import.meta.url));
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const NOW = new Date('2026-06-15T09:00:00Z');

beforeEach(() => { openDb(':memory:'); freshAccounts(); resetInboxMemory(); });

/** A Dropbox with the given files in its root; records what was listed, downloaded and removed. */
function fakeStore(files: Record<string, Buffer>, opts: { failDownload?: boolean } = {}) {
  const log = { listed: [] as string[], removed: [] as string[] };
  const store: StorageDestination = {
    exists: async () => ({ exists: false, sameContent: false }),
    put: async (f, n) => ({ path: `${f}/${n}`, existed: false }),
    listFiles: async (folder) => {
      log.listed.push(folder);
      return Object.entries(files).map(([name, b]): FileEntry => ({ name, path: `${folder}/${name}`, size: b.length }));
    },
    download: async (path) => {
      if (opts.failDownload) throw new Error('Dropbox 401: missing_scope/files.content.read');
      return files[path.split('/').pop()!];
    },
    remove: async (path) => { log.removed.push(path); delete files[path.split('/').pop()!]; return 'removed'; },
  };
  return { store, log };
}
const deps = (storage: StorageDestination, over: Partial<ReturnType<typeof getSettings>> = {}): Deps => ({
  storage, accounting: null, ai: null, now: () => NOW,
  settings: { ...getSettings(), storageInbox: true, storageRoot: '/חשבוניות', ...over },
});

test('off by default: nothing is listed', async () => {
  const { store, log } = fakeStore({ 'a.pdf': PDF });
  const r = await collectInbox({ ...deps(store), settings: { ...getSettings(), storageRoot: '/x' } });
  assert.equal(r.taken, 0);
  assert.deepEqual(log.listed, []);
});

test('takes PDFs and photos from the root, queues them, removes the originals', async () => {
  const { store, log } = fakeStore({ 'bill.pdf': PDF, 'receipt.JPG': JPEG, 'notes.txt': Buffer.from('x'), '.DS_Store': Buffer.from('x') });
  const r = await collectInbox(deps(store));
  assert.deepEqual(r, { taken: 2, duplicates: 0, errors: [] });
  assert.deepEqual(log.listed, ['/חשבוניות']);
  assert.deepEqual(log.removed.sort(), ['/חשבוניות/bill.pdf', '/חשבוניות/receipt.JPG']);
  const items = listItems({});
  assert.equal(items.length, 2);
  for (const i of items) {
    assert.equal(i.state, 'queued');
    assert.equal(getEmail(i.messageId)?.sender, 'dropbox');
  }
  assert.deepEqual(items.map((i) => i.attachmentName).sort(), ['bill.pdf', 'receipt.pdf']);
});

test('the same file dropped twice is a dismissed duplicate', async () => {
  await collectInbox(deps(fakeStore({ 'a.pdf': PDF }).store));
  const r = await collectInbox(deps(fakeStore({ 'again.pdf': PDF }).store));
  assert.equal(r.duplicates, 1);
  assert.deepEqual(listItems({}).map((i) => i.state).sort(), ['dismissed', 'queued']);
});

test('a download error leaves the file in place and is reported', async () => {
  const { store, log } = fakeStore({ 'a.pdf': PDF }, { failDownload: true });
  const r = await collectInbox(deps(store));
  assert.equal(r.taken, 0);
  assert.match(r.errors[0], /missing_scope/);
  assert.deepEqual(log.removed, []);
});

test('an unreadable file is left in place and reported only once', async () => {
  const { store, log } = fakeStore({ 'broken.pdf': Buffer.from('not a pdf') });
  assert.equal((await collectInbox(deps(store))).errors.length, 1);
  assert.equal((await collectInbox(deps(store))).errors.length, 0);
  assert.deepEqual(log.removed, []);
  assert.equal(listItems({}).length, 0);
});

test('refuses a folder template that files into the root itself', async () => {
  const { store, log } = fakeStore({ 'a.pdf': PDF });
  const r = await collectInbox(deps(store, { folderTemplate: '{root}/' }));
  assert.equal(r.errors.length, 1);
  assert.deepEqual(log.listed, []);
});

test('Google Drive: not watched', async () => {
  const { store, log } = fakeStore({ 'a.pdf': PDF });
  await collectInbox(deps(store, { storageProvider: 'gdrive' }));
  assert.deepEqual(log.listed, []);
  assert.equal(getItem('x'), undefined);
});
