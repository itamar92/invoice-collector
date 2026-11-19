import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../server/db.js';
import { getItem, listItems } from '../server/core/items.js';
import type { Deps, ExtractedFields } from '../server/core/types.js';
import type { AiProvider } from '../server/ai/provider.js';
import { getSettings, updateSettings } from '../server/settings.js';
import {
  handleUpdate, startTelegramBot, telegramApi, TelegramError, type TelegramApi, type TgUpdate,
} from '../server/sources/telegram.js';
import { UploadError } from '../server/sources/upload.js';

process.env.SECRET_KEY = 'test-key-for-unit-tests-only-0123456789';

const JPEG = readFileSync(new URL('./fixtures/receipt-photo.jpg', import.meta.url));
const NOW = new Date('2026-06-15T09:00:00Z');
const CHAT = 4242;
const FIELDS: ExtractedFields = {
  vendorName: 'סופר דמו', vendorTaxId: '510000002', docType: 'tax_invoice_receipt', docNumber: '9001',
  issueDate: '2026-06-14', total: 118, vat: 18, net: 100, currency: 'ILS', allocationNumber: null,
  description: 'כיבוד', category: 'כיבודים ואוכל',
};

beforeEach(() => {
  openDb(':memory:');
  updateSettings({ telegramChatIds: [String(CHAT)] });
  process.env.PUBLIC_URL = 'https://inv.example.test/';
});

const ai: AiProvider = { name: 'fake', supportsPdf: true, ping: async () => {}, completeJson: async () => FIELDS };
const deps = (): Deps => ({
  storage: { exists: async () => ({ exists: false, sameContent: false }), put: async (f, n) => ({ path: `${f}/${n}`, existed: false }) },
  accounting: null, ai, settings: getSettings(), now: () => NOW,
});

function fakeApi(over: Partial<TelegramApi> = {}) {
  const sent: { chatId: string; text: string }[] = [];
  const api: TelegramApi = {
    getMe: async () => ({ username: 'demo_bot' }),
    getUpdates: async () => [],
    sendMessage: async (chatId, text) => { sent.push({ chatId, text }); },
    download: async () => JPEG,
    ...over,
  };
  return { api, sent };
}
const photo = (chat = CHAT, id = 1): TgUpdate => ({
  update_id: id,
  message: { message_id: id, chat: { id: chat }, photo: [{ file_id: 'small', width: 90, height: 120 }, { file_id: 'large', width: 900, height: 1200 }] },
});
const ctx = { getDeps: deps, now: () => NOW };

test('a photo from an allowed chat becomes an item and the chat is told the outcome', async () => {
  const got: string[] = [];
  const { api, sent } = fakeApi({ download: async (id) => { got.push(id); return JPEG; } });
  await handleUpdate(api, photo(), ctx);
  assert.deepEqual(got, ['large'], 'the largest size is the one downloaded');
  const [item] = listItems();
  assert.equal(item.state, 'awaiting_vendor');
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /קורא/);
  assert.match(sent[1].text, /ספק חדש/);
  assert.match(sent[1].text, /סופר דמו · 118\.00 ILS · 14\/06\/2026 · כיבודים ואוכל/);
  assert.ok(sent[1].text.endsWith(`https://inv.example.test/items/${item.id}`));
});

test('a chat that is not on the list is told its id and nothing is downloaded or stored', async () => {
  const { api, sent } = fakeApi({ download: async () => { throw new Error('must not download'); } });
  await handleUpdate(api, photo(777), ctx);
  assert.equal(listItems().length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, '777');
  assert.match(sent[0].text, /מזהה הצ'אט: 777/);
});

test('the same photo sent twice is reported as already there', async () => {
  const { api, sent } = fakeApi();
  await handleUpdate(api, photo(CHAT, 1), ctx);
  await handleUpdate(api, photo(CHAT, 2), ctx);
  assert.equal(listItems({ state: 'awaiting_vendor' }).length, 1);
  assert.match(sent.at(-1)!.text, /כבר קיים/);
});

test('documents: a PDF is taken, other file types and oversized files are refused with a reply', async () => {
  const pdf = Buffer.from('%PDF-1.4 not really a pdf');
  const { api, sent } = fakeApi({ download: async () => pdf });
  const doc = (mime: string, size = 1000): TgUpdate => ({
    update_id: 5, message: { message_id: 5, chat: { id: CHAT }, document: { file_id: 'f', file_name: 'חשבונית.pdf', mime_type: mime, file_size: size } },
  });
  await handleUpdate(api, doc('application/pdf'), { getDeps: () => null });
  const [item] = listItems();
  assert.equal(item.attachmentName, 'חשבונית.pdf');
  assert.equal(item.state, 'queued', 'no deps: left for the worker');
  assert.match(sent.at(-1)!.text, /בריצה הבאה/);

  await handleUpdate(api, doc('image/heic'), ctx);
  assert.match(sent.at(-1)!.text, /רק תמונה או קובץ PDF/);
  await handleUpdate(api, doc('application/pdf', 30 * 1024 * 1024), ctx);
  assert.match(sent.at(-1)!.text, /גדול מדי/);
  assert.equal(listItems().length, 1);
});

test('a text message gets the help line; a failed download gets an apology, not a crash', async () => {
  const { api, sent } = fakeApi({ download: async () => { throw new TelegramError('telegram unreachable'); } });
  await handleUpdate(api, { update_id: 1, message: { message_id: 1, chat: { id: CHAT }, text: '/start' } }, ctx);
  assert.match(sent[0].text, /צילום של קבלה/);
  await handleUpdate(api, photo(), ctx);
  assert.match(sent[1].text, /משהו השתבש/);
  const tooBig = fakeApi({ download: async () => { throw new UploadError('too_large'); } });
  await handleUpdate(tooBig.api, photo(), ctx);
  assert.match(tooBig.sent[0].text, /גדול מדי/);
  assert.equal(listItems().length, 0);
});

test('the polling loop acknowledges each update and survives a failing one', async () => {
  const offsets: number[] = [];
  let bot: { stop(): void; done: Promise<void> };
  const batches: TgUpdate[][] = [[photo(999, 10), photo(CHAT, 11)], []];
  const { api } = fakeApi({
    getUpdates: async (offset) => {
      offsets.push(offset);
      const next = batches.shift();
      if (!next) { bot.stop(); return []; }
      return next;
    },
    // The reply to the unknown chat fails: the update is still acknowledged and the next one handled.
    sendMessage: async (chatId) => { if (chatId === '999') throw new TelegramError('telegram: blocked'); },
  });
  bot = startTelegramBot(deps, { makeApi: () => api, getToken: () => 'token', idleMs: 1, now: () => NOW });
  await bot.done;
  assert.deepEqual(offsets, [0, 12, 12]);
  assert.equal(listItems().length, 1);
  assert.equal(getItem(listItems()[0].id)!.state, 'awaiting_vendor');
});

test('the Bot API client reports Telegram’s reason and never the token or URL', async () => {
  const token = '123456:SECRET-TOKEN';
  const rejecting = (async () => new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 })) as typeof fetch;
  await assert.rejects(telegramApi(token, rejecting).getMe(), (e: Error) => e.message === 'telegram: Unauthorized');
  const failing = (async () => { throw new Error(`connect failed https://api.telegram.org/bot${token}/getMe`); }) as typeof fetch;
  await assert.rejects(telegramApi(token, failing).getMe(), (e: Error) => e.message === 'telegram unreachable');
  const urls: string[] = [];
  const ok = (async (url: string) => {
    urls.push(url);
    return url.includes('/file/') ? new Response(JPEG)
      : new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/1.jpg', file_size: JPEG.length } }));
  }) as typeof fetch;
  assert.deepEqual(await telegramApi(token, ok).download('abc'), JPEG);
  assert.deepEqual(urls, [`https://api.telegram.org/bot${token}/getFile`, `https://api.telegram.org/file/bot${token}/photos/1.jpg`]);
});
