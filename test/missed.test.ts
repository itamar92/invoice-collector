import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { getEmail, listItems, createEmail } from '../server/core/items.js';
import { hideMissed, listMissed, queueMissed, scanMissed } from '../server/core/missed.js';
import type { Deps } from '../server/core/types.js';
import { IL_DEFAULTS } from '../server/defaults/il.js';
import { updateSettings } from '../server/settings.js';
import { DONE_LABEL, INVOICE_QUERY } from '../server/sources/gmail.js';
import type { GmailSource } from '../server/sources/gmail.js';

beforeEach(() => { openDb(':memory:'); });

function fake(ids: string[]) {
  const g = {
    queries: [] as string[], fetched: [] as string[], headerCalls: 0,
    listCandidateMessages: async () => [],
    searchMessages: async (q: string) => { g.queries.push(q); return ids; },
    fetchHeaders: async (id: string) => {
      g.headerCalls++;
      return { id, sender: `${id}@x.test`, subject: `sub ${id}`, receivedAt: '2026-02-01T00:00:00.000Z' };
    },
    fetchMessage: async (id: string) => {
      g.fetched.push(id);
      return { id, threadId: 't', sender: `${id}@x.test`, subject: 's', receivedAt: '2026-02-01T00:00:00.000Z',
        pdfs: [{ name: 'a.pdf', data: Buffer.from('%PDF-1 ' + id) }], html: '', text: '' };
    },
    markHandled: async () => {},
  };
  return g satisfies GmailSource & Record<string, unknown>;
}
const deps = (): Deps => ({
  storage: { exists: async () => ({ exists: false, sameContent: false }), put: async (f, n) => ({ path: `${f}/${n}`, existed: false }) },
  accounting: null, ai: null, settings: IL_DEFAULTS, now: () => new Date('2026-06-15T00:00:00Z'),
  extractText: async () => ({ text: '', pages: 1, isScan: false }),
});

test('scanMissed with no label returns 0 and runs no query', async () => {
  const g = fake(['a']);
  assert.equal(await scanMissed(g, '2026-01-01'), 0);
  assert.equal(g.queries.length, 0);
  assert.equal(listMissed().length, 0);
});

test('scanMissed builds the query, records open rows, skips known and ingested ids, processes nothing', async () => {
  updateSettings({ gmailLabel: 'invoices' });
  createEmail({ messageId: 'old', threadId: 't', sender: 's', subject: 's', receivedAt: '2026-01-02T00:00:00Z', mode: 'ongoing' });
  const g = fake(['a', 'b', 'old']);
  assert.equal(await scanMissed(g, '2026-01-01'), 2);
  assert.equal(g.queries[0], `${INVOICE_QUERY} -label:"invoices" -label:"${DONE_LABEL}" after:2026/01/01`);
  assert.deepEqual(listMissed('open').map((m) => [m.messageId, m.sender, m.subject]).sort(),
    [['a', 'a@x.test', 'sub a'], ['b', 'b@x.test', 'sub b']]);
  assert.equal(g.fetched.length, 0);
  assert.equal(getEmail('a'), undefined);
  assert.equal(await scanMissed(g, '2026-01-01'), 0); // second scan adds nothing
  assert.equal(g.headerCalls, 2);
});

test('queueMissed ingests as manual and marks queued; hideMissed hides', async () => {
  updateSettings({ gmailLabel: 'invoices' });
  const g = fake(['a', 'b']);
  await scanMissed(g, '2026-01-01');
  await queueMissed(g, 'a', deps());
  assert.equal(getEmail('a')?.mode, 'manual');
  assert.equal(listItems({ messageId: 'a' }).length, 1);
  assert.equal(listMissed('queued').length, 1);
  hideMissed('b');
  assert.equal(listMissed('hidden')[0].messageId, 'b');
  assert.equal(getEmail('b'), undefined);
  await assert.rejects(queueMissed(g, 'zzz', deps()), /Unknown missed/);
});
