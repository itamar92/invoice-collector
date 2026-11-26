import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createEmail, createItem, getItem, updateItem } from '../server/core/items.js';
import { recordIngestFailure, listIngestFailures } from '../server/core/ingestFailures.js';
import { getDb } from '../server/db.js';
import { getSettings, updateSettings } from '../server/settings.js';
import { IL_DEFAULTS } from '../server/defaults/il.js';
import { startWorker } from '../server/worker.js';
import type { Deps } from '../server/core/types.js';
import type { GmailMessage, GmailSource } from '../server/sources/gmail.js';

const NOW = new Date('2026-06-15T09:00:00Z'); // 12:00 in Asia/Jerusalem
beforeEach(() => { openDb(':memory:'); });

function fakeGmail(over: Partial<GmailSource> & { ids?: string[] } = {}) {
  const calls = { list: [] as string[], search: [] as string[], marked: [] as string[] };
  const g: GmailSource = {
    async listCandidateMessages(o) { calls.list.push(o.after); await new Promise((r) => setTimeout(r, 20)); return over.ids ?? []; },
    async searchMessages(q) { calls.search.push(q); return []; },
    async fetchMessage(id): Promise<GmailMessage> {
      return { id, threadId: 't', sender: 'a@b.example', subject: 's', receivedAt: NOW.toISOString(), pdfs: [], html: '', text: '' };
    },
    async fetchHeaders(id) { return { id, sender: '', subject: '', receivedAt: NOW.toISOString() }; },
    async markHandled(id) { calls.marked.push(id); },
    ...over,
  };
  return { g, calls };
}
const deps = (): Deps => ({
  storage: { async put(f, n) { return { path: `${f}/${n}`, existed: false }; }, async exists() { return { exists: false, sameContent: false }; } },
  accounting: null, ai: null, settings: { ...IL_DEFAULTS, storageRoot: '/Inv' }, now: () => NOW,
  extractText: async () => ({ text: '', pages: 1, isScan: false }),
});
const ready = () => updateSettings({ setupComplete: true, backfillDone: true, gmailLabels: ['inv'] });
const mkItem = (mid: string, n: string) => {
  createEmail({ messageId: mid, threadId: 't', sender: 's', subject: 's', receivedAt: NOW.toISOString(), mode: 'ongoing' });
  return createItem(mid, 'a.pdf', Buffer.from(`%PDF ${n}`)).id;
};

test('no-op before setup / backfill done', async () => {
  const { g, calls } = fakeGmail();
  let built = 0;
  const w = startWorker(() => { built++; return { deps: deps(), gmail: g }; }, { intervalMs: 1e6, now: () => NOW });
  await w.tick();
  updateSettings({ setupComplete: true });
  await w.tick();
  w.stop();
  assert.equal(built, 0);
  assert.equal(calls.list.length, 0);
  assert.equal(getSettings().lastTickAt, null);
});

test('overlapping ticks run one pass', async () => {
  ready();
  const { g, calls } = fakeGmail();
  const w = startWorker(() => ({ deps: deps(), gmail: g }), { intervalMs: 1e6, now: () => NOW });
  await Promise.all([w.tick(), w.tick()]);
  w.stop();
  assert.equal(calls.list.length, 1);
  assert.equal(getSettings().lastTickAt, NOW.toISOString());
});

test('retries ingest failures every tick (R21) and ingests new ids; one bad id does not stop others', async () => {
  ready();
  recordIngestFailure('old1', 'ongoing', new Error('x'));
  const fetched: string[] = [];
  const { g } = fakeGmail({
    ids: ['bad', 'good'],
    async fetchMessage(id) {
      fetched.push(id);
      if (id === 'bad') throw new Error('boom');
      return { id, threadId: 't', sender: 's@x.example', subject: 's', receivedAt: NOW.toISOString(), pdfs: [], html: '', text: '' };
    },
  });
  const w = startWorker(() => ({ deps: deps(), gmail: g }), { intervalMs: 1e6, now: () => NOW });
  await w.tick();
  w.stop();
  assert.ok(fetched.includes('old1'));
  assert.ok(fetched.includes('good'));
  const failed = listIngestFailures().map((f) => f.messageId).sort();
  assert.deepEqual(failed, ['bad']);
  assert.ok(getDb().prepare("SELECT 1 FROM emails WHERE message_id='good'").get());
});

test('ingest window is the whole tax year (done-labelled excluded by the query): an old email labelled today is ingested', async () => {
  ready();
  createEmail({ messageId: 'm', threadId: 't', sender: 's', subject: 's', receivedAt: '2026-06-10T10:00:00Z', mode: 'ongoing' });
  createItem('m', 'a.pdf', Buffer.from('%PDF-1 known'));
  let fetched: string[] = [];
  const { g, calls } = fakeGmail({
    ids: ['m', 'old-labelled'],
    async fetchMessage(id): Promise<GmailMessage> {
      fetched.push(id);
      return { id, threadId: 't', sender: 'a@b.example', subject: 's', receivedAt: '2026-02-01T08:00:00Z', pdfs: [], html: '', text: '' };
    },
  });
  const w = startWorker(() => ({ deps: deps(), gmail: g }), { intervalMs: 1e6, now: () => NOW });
  await w.tick();
  w.stop();
  assert.equal(calls.list[0], '2026/01/01');
  assert.deepEqual(fetched, ['old-labelled']); // a known id is skipped without fetching
  assert.equal(getDb().prepare(`SELECT COUNT(*) FROM items WHERE message_id = 'old-labelled'`).pluck().get(), 1);
  fetched = [];
});

test('due retries are processed, not-yet-due skipped; a throwing item does not stop the next', async () => {
  ready();
  const due = mkItem('m1', '1');
  const later = mkItem('m2', '2');
  const boom = mkItem('m3', '3');
  const ok = mkItem('m4', '4');
  for (const id of [due, later, boom, ok]) getDb().prepare("UPDATE items SET state='stored' WHERE id=?").run(id);
  updateItem(due, { nextAttemptAt: '2026-06-15T08:00:00.000Z' });
  updateItem(later, { nextAttemptAt: '2026-06-15T10:00:00.000Z' });
  const { g } = fakeGmail();
  // accounting that throws a DB-like error for one item makes processItem throw: simulate via settings getter
  const d = deps();
  let n = 0;
  d.accounting = null; // stored -> done without accounting
  const w = startWorker(() => {
    n++;
    return { deps: d, gmail: g };
  }, { intervalMs: 1e6, now: () => NOW });
  // make 'boom' throw a database error: drop its row's JSON validity is intrusive, so break via trigger
  getDb().exec(`CREATE TRIGGER t_boom BEFORE UPDATE ON items WHEN NEW.id='${boom}' AND NEW.reason='accounting_error'
    BEGIN SELECT RAISE(ABORT, 'db boom'); END`);
  await w.tick();
  w.stop();
  assert.equal(getItem(later)!.state, 'stored');
  assert.notEqual(getItem(due)!.state, 'stored');
  assert.notEqual(getItem(ok)!.state, 'stored');
  assert.notEqual(getItem(ok)!.reason, 'internal_error');
  const b = getItem(boom)!;
  assert.equal(b.state, 'needs_attention');
  assert.equal(b.reason, 'internal_error');
  assert.ok(n === 1);
});

test('marks fully terminal emails handled; records gmail errors in lastTickError', async () => {
  ready();
  const id = mkItem('m1', '1');
  getDb().prepare("UPDATE items SET state='done' WHERE id=?").run(id);
  const { g, calls } = fakeGmail();
  const w = startWorker(() => ({ deps: deps(), gmail: g }), { intervalMs: 1e6, now: () => NOW });
  await w.tick();
  assert.deepEqual(calls.marked, ['m1']);
  assert.equal(getSettings().lastTickError, null);
  const w2 = startWorker(() => { throw new Error('gmail not connected'); }, { intervalMs: 1e6, now: () => NOW });
  await w2.tick();
  w.stop(); w2.stop();
  assert.equal(getSettings().lastTickError, 'gmail not connected');
});

test('missed scan: once per local day, only from 06:00 local', async () => {
  ready();
  const early = new Date('2026-06-15T02:00:00Z'); // 05:00 Jerusalem
  const { g, calls } = fakeGmail();
  let t = early;
  const w = startWorker(() => ({ deps: deps(), gmail: g }), { intervalMs: 1e6, now: () => t });
  await w.tick();
  assert.equal(calls.search.length, 0);
  t = NOW;
  await w.tick();
  assert.equal(calls.search.length, 1);
  assert.match(calls.search[0], /after:2026\/01\/01/);
  await w.tick();
  assert.equal(calls.search.length, 1);
  t = new Date('2026-06-16T04:00:00Z');
  await w.tick();
  w.stop();
  assert.equal(calls.search.length, 2);
});

test('scheduled ticks fire on the interval', async () => {
  ready();
  const { g, calls } = fakeGmail();
  const w = startWorker(() => ({ deps: deps(), gmail: g }), { intervalMs: 30, now: () => NOW });
  await new Promise((r) => setTimeout(r, 90));
  w.stop();
  assert.ok(calls.list.length >= 1);
});

test('moves awaiting_vendor items on once their vendor was decided while offline', async () => {
  ready();
  const id = mkItem('mv', 'v');
  updateItem(id, {});
  getDb().prepare("INSERT INTO vendors (key, display_name, status, created_at) VALUES ('acme', 'Acme', 'ignored', ?)").run(NOW.toISOString());
  getDb().prepare("UPDATE items SET vendor_key = 'acme', state = 'awaiting_vendor' WHERE id = ?").run(id);
  const { g } = fakeGmail();
  const w = startWorker(() => ({ deps: deps(), gmail: g }), { intervalMs: 1e6, now: () => NOW });
  await w.tick();
  w.stop();
  assert.equal(getItem(id)!.state, 'ignored');
});
