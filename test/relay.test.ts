import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb, getDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { resetLoginLimiter } from '../server/auth.js';
import { listItems } from '../server/core/items.js';
import type { Deps, ExtractedFields } from '../server/core/types.js';
import type { AiProvider } from '../server/ai/provider.js';
import { createHub, type HubOptions } from '../server/relay/hub.js';
import { getSecret } from '../server/secrets.js';
import { getSettings, updateSettings } from '../server/settings.js';
import type { GmailSource } from '../server/sources/gmail.js';
import { relayClient, relayPass, RelayError } from '../server/sources/relayClient.js';
import { TelegramError, type TelegramApi, type TgUpdate } from '../server/sources/telegram.js';

process.env.SECRET_KEY = 'test-key-for-unit-tests-only-0123456789';
process.env.APP_PASSWORD = 'correct horse';
delete process.env.PUBLIC_URL;

const JPEG = readFileSync(new URL('./fixtures/receipt-photo.jpg', import.meta.url));
const NOW = new Date('2026-06-15T09:00:00Z');
const FIELDS: ExtractedFields = {
  vendorName: 'סופר דמו', vendorTaxId: '510000002', docType: 'tax_invoice_receipt', docNumber: '9001',
  issueDate: '2026-06-14', total: 118, vat: 18, net: 100, currency: 'ILS', allocationNumber: null,
  description: 'כיבוד', category: 'כיבודים',
};
const ai: AiProvider = { name: 'fake', supportsPdf: true, ping: async () => {}, completeJson: async () => FIELDS };
const deps = (): Deps => ({
  storage: { exists: async () => ({ exists: false, sameContent: false }), put: async (f, n) => ({ path: `${f}/${n}`, existed: false }) },
  accounting: null, ai, settings: getSettings(), now: () => NOW,
});
const ctx = { getDeps: deps, now: () => NOW };

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });
beforeEach(() => { openDb(':memory:'); resetLoginLimiter(); });

/** A hub with a fake Telegram behind it, served over real HTTP. */
async function bootHub(over: Partial<HubOptions> = {}, tg: Partial<TelegramApi> = {}) {
  const sent: { chatId: string; text: string }[] = [];
  const api: TelegramApi = {
    getMe: async () => ({ username: 'shared_demo_bot' }),
    getUpdates: async () => [],
    sendMessage: async (chatId, text) => { sent.push({ chatId, text }); },
    download: async () => JPEG,
    ...tg,
  };
  let clock = NOW;
  const hub = createHub({ token: 't', api, now: () => clock, ...over });
  const app = createApp(undefined, hub.router);
  const s = await new Promise<Server>((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  servers.push(s);
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return { hub, base, sent, setClock: (d: Date) => { clock = d; } };
}

const text = (chat: number, t: string, id = 1): TgUpdate =>
  ({ update_id: id, message: { message_id: id, chat: { id: chat, first_name: 'דנה', last_name: 'לוי' }, text: t } });
const photo = (chat: number, id = 2): TgUpdate =>
  ({ update_id: id, message: { message_id: id, chat: { id: chat }, photo: [{ file_id: 'small', width: 9, height: 12 }, { file_id: 'large', width: 900, height: 1200 }] } });

/** Registers an instance and links `chat` to it through a pairing link. */
async function linked(h: Awaited<ReturnType<typeof bootHub>>, chat: number) {
  const auth = await relayClient(h.base, null).register();
  const client = relayClient(h.base, auth);
  const { url } = await client.pair();
  await h.hub.handle(text(chat, `/start ${new URL(url).searchParams.get('start')}`));
  return { auth, client, url };
}

test('pairing link → Start → photo → the instance takes it in and the chat gets the outcome', async () => {
  const h = await bootHub();
  const { client, url, auth } = await linked(h, 501);
  assert.match(url, /^https:\/\/t\.me\/shared_demo_bot\?start=[\w-]{20,}$/);
  assert.match(auth, /^[0-9a-f-]{36}\.[\w-]{40,}$/);
  assert.match(h.sent[0].text, /הצ'אט מחובר/);
  assert.deepEqual(await client.status(), { botUsername: 'shared_demo_bot', chats: [{ id: '501', name: 'דנה לוי', linkedAt: NOW.toISOString() }] });

  await h.hub.handle(photo(501));
  assert.match(h.sent[1].text, /קורא/);
  assert.equal(listItems().length, 0, 'the hub itself takes nothing in');
  assert.equal(await relayPass(client, ctx, 0), 1);
  const [item] = listItems();
  assert.equal(item.state, 'awaiting_vendor');
  assert.equal(item.fields?.total, 118);
  assert.equal(h.sent[2].chatId, '501');
  assert.match(h.sent[2].text, /ספק חדש[\s\S]*סופר דמו · 118\.00 ILS/);
  assert.equal(await relayPass(client, ctx, 0), 0, 'a finished document is not handed out again');
  // The hub keeps Telegram's file id only while the document waits, and never the bytes.
  assert.equal(getDb().prepare('SELECT COUNT(*) FROM relay_updates').pluck().get(), 0);
});

test('a chat nobody paired is told how to connect; a pairing code works once and expires', async () => {
  const h = await bootHub();
  await h.hub.handle(photo(777));
  assert.match(h.sent[0].text, /עדיין לא מחובר/);
  const { url } = await linked(h, 501);
  const code = new URL(url).searchParams.get('start')!;
  await h.hub.handle(text(888, `/start ${code}`));
  assert.match(h.sent.at(-1)!.text, /לא תקף/);
  const client = relayClient(h.base, await relayClient(h.base, null).register());
  const late = new URL((await client.pair()).url).searchParams.get('start')!;
  h.setClock(new Date(NOW.getTime() + 16 * 60_000));
  await h.hub.handle(text(999, `/start ${late}`));
  assert.match(h.sent.at(-1)!.text, /לא תקף/);
  assert.deepEqual((await client.status()).chats, []);
});

test('an instance reaches only its own chats and documents', async () => {
  const h = await bootHub();
  const a = await linked(h, 501);
  const b = await linked(h, 502);
  await h.hub.handle(photo(501));
  const [u] = await a.client.updates(0);
  assert.deepEqual(await b.client.updates(0), []);
  const is = (status: number) => (e: unknown) => e instanceof RelayError && e.status === status;
  await assert.rejects(b.client.file(u.id), is(404));
  await assert.rejects(b.client.done(u.id, 'x'), is(404));
  await assert.rejects(b.client.unlink('501'), is(404));
  await assert.rejects(relayClient(h.base, `${a.auth.split('.')[0]}.${'x'.repeat(43)}`).updates(0), is(401));
  await assert.rejects(relayClient(h.base, null).status(), is(401));
  assert.deepEqual(await a.client.file(u.id), JPEG);
});

test('with an invite key, only instances that present it can register', async () => {
  const h = await bootHub({ inviteKey: 'friends-only' });
  await assert.rejects(relayClient(h.base, null).register(), (e) => e instanceof RelayError && e.code === 'invite_required');
  await assert.rejects(relayClient(h.base, null).register('wrong'), (e) => e instanceof RelayError && e.status === 403);
  assert.match(await relayClient(h.base, null).register('friends-only'), /\./);
});

test('a waiting long poll answers as soon as a document arrives; /stop and unlink disconnect a chat', async () => {
  const h = await bootHub();
  const { client } = await linked(h, 501);
  const started = Date.now();
  const waiting = client.updates(20);
  setTimeout(() => { void h.hub.handle(photo(501)); }, 50);
  assert.equal((await waiting).length, 1);
  assert.ok(Date.now() - started < 5000);

  await h.hub.handle(text(501, '/stop'));
  assert.match(h.sent.at(-1)!.text, /נותק/);
  assert.deepEqual((await client.status()).chats, []);
  await linked(h, 502);
});

test('a document Telegram no longer has is closed with an apology instead of being retried forever', async () => {
  const h = await bootHub({}, { download: async () => { throw new TelegramError('telegram: file not found', 400); } });
  const { client } = await linked(h, 501);
  await h.hub.handle(photo(501));
  assert.equal(await relayPass(client, ctx, 0), 1);
  assert.match(h.sent.at(-1)!.text, /משהו השתבש/);
  assert.equal(listItems().length, 0);
  assert.deepEqual(await client.updates(0), []);
});

test('instance API: connect registers once and returns the link; changing the hub address drops the credential', async () => {
  const h = await bootHub({ inviteKey: 'k' });
  const app = createApp({ getDeps: () => ({ deps: deps(), gmail: {} as GmailSource }), now: () => NOW });
  const s = await new Promise<Server>((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  servers.push(s);
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse' }) });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };

  assert.deepEqual(await call('POST', '/api/telegram/relay/connect', {}), { status: 400, body: { error: 'relay_not_configured' } });
  assert.equal((await call('PUT', '/api/settings', { telegramRelayUrl: 'ftp://nope' })).status, 400);
  await call('PUT', '/api/settings', { telegramRelayUrl: h.base });
  assert.deepEqual((await call('GET', '/api/telegram/relay')).body, { configured: true, connected: false, botUsername: null, chats: [] });
  assert.deepEqual(await call('POST', '/api/telegram/relay/connect', {}), { status: 502, body: { error: 'invite_required' } });

  const first = await call('POST', '/api/telegram/relay/connect', { invite: 'k' });
  assert.equal(first.status, 200);
  const auth = getSecret('telegram_relay_auth');
  assert.ok(auth);
  await h.hub.handle(text(501, `/start ${new URL(first.body.url).searchParams.get('start')}`));
  const again = await call('POST', '/api/telegram/relay/connect', {});
  assert.equal(again.status, 200);
  assert.equal(getSecret('telegram_relay_auth'), auth, 'already registered: the same credential is kept');
  const status = (await call('GET', '/api/telegram/relay')).body;
  assert.equal(status.botUsername, 'shared_demo_bot');
  assert.deepEqual(status.chats.map((c: { id: string }) => c.id), ['501']);
  assert.ok(!JSON.stringify(status).includes(auth!.split('.')[1]));

  assert.equal((await call('DELETE', '/api/telegram/relay/chats/501')).status, 200);
  assert.deepEqual((await call('GET', '/api/telegram/relay')).body.chats, []);

  // A hub that forgot this instance: connect registers again by itself.
  getDb().prepare('DELETE FROM relay_pair_codes').run();
  getDb().prepare('DELETE FROM relay_tenants').run();
  assert.equal((await call('POST', '/api/telegram/relay/connect', {})).status, 502, 'needs the invite again');
  assert.equal((await call('POST', '/api/telegram/relay/connect', { invite: 'k' })).status, 200);
  assert.notEqual(getSecret('telegram_relay_auth'), auth);

  await call('PUT', '/api/settings', { telegramRelayUrl: 'https://other.example.test' });
  assert.equal(getSecret('telegram_relay_auth'), null);
  updateSettings({ telegramRelayUrl: '' });
});
