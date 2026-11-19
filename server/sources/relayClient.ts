import type { Deps } from '../core/types.js';
import { getSecret } from '../secrets.js';
import { getSettings } from '../settings.js';
import { BOT_MSG, intakeDocument, sleep, type BotContext } from './telegram.js';

/**
 * Instance side of the shared Telegram bot (see server/relay/hub.ts): registers with the hub, asks it for a
 * pairing link, and long-polls it for documents sent in this instance's chats.
 */

/** A refused or failed hub call; `code` is the hub's error code, or `relay_unreachable`. Never a URL or a secret. */
export class RelayError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`relay: ${code}`); this.name = 'RelayError'; }
}

export interface RelayChat { id: string; name: string | null; linkedAt: string }
export interface RelayClient {
  /** Registers this instance; the result is its credential (stored as the secret telegram_relay_auth). */
  register(invite?: string): Promise<string>;
  pair(): Promise<{ url: string; expiresAt: string }>;
  status(): Promise<{ botUsername: string | null; chats: RelayChat[] }>;
  unlink(chatId: string): Promise<void>;
  updates(waitSec: number): Promise<{ id: number; fileName: string | null }[]>;
  file(id: number): Promise<Buffer>;
  done(id: number, reply: string): Promise<void>;
}

export function relayClient(baseUrl: string, auth: string | null, fetchFn: typeof fetch = fetch): RelayClient {
  const base = `${baseUrl.replace(/\/+$/, '')}/relay/v1`;
  async function call(method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<Response> {
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, {
        method,
        headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new RelayError(0, 'relay_unreachable');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null) as { error?: unknown } | null;
      throw new RelayError(res.status, typeof data?.error === 'string' ? data.error.slice(0, 60) : 'relay_rejected');
    }
    return res;
  }
  const json = async <T>(method: string, path: string, body?: unknown, timeoutMs?: number) =>
    (await call(method, path, body, timeoutMs)).json() as Promise<T>;
  return {
    register: async (invite) => (await json<{ auth: string }>('POST', '/register', invite ? { invite } : {})).auth,
    pair: () => json('POST', '/pair', {}),
    status: () => json('GET', '/status'),
    unlink: async (chatId) => { await call('DELETE', `/chats/${encodeURIComponent(chatId)}`); },
    updates: async (waitSec) =>
      (await json<{ updates: { id: number; fileName: string | null }[] }>('GET', `/updates?wait=${waitSec}`, undefined, (waitSec + 15) * 1000)).updates,
    file: async (id) => Buffer.from(await (await call('GET', `/updates/${id}/file`, undefined, 90_000)).arrayBuffer()),
    done: async (id, reply) => { await call('POST', `/updates/${id}/done`, { reply: reply.slice(0, 1500) }); },
  };
}

/**
 * One poll: takes in every waiting document and reports each outcome back for the chat. Returns how many were
 * handled. A document the hub can no longer provide is closed with an apology; any other failure is thrown, the
 * document stays with the hub and the next poll retries it (a repeat is caught as a duplicate).
 */
export async function relayPass(client: RelayClient, ctx: BotContext, waitSec: number): Promise<number> {
  const updates = await client.updates(waitSec);
  for (const u of updates) {
    let reply: string;
    try {
      reply = await intakeDocument(await client.file(u.id), u.fileName ?? `telegram-${u.id}`, ctx);
    } catch (e) {
      if (!(e instanceof RelayError) || ![404, 410, 413].includes(e.status)) throw e;
      reply = e.status === 413 ? BOT_MSG.tooLarge : BOT_MSG.failed;
    }
    await client.done(u.id, reply);
  }
  return updates.length;
}

export interface RelayLoopOptions {
  /** Injectable for tests; defaults read the relay address from settings and the credential from the secrets. */
  getConfig?: () => { url: string; auth: string | null };
  makeClient?: (url: string, auth: string) => RelayClient;
  pollSeconds?: number;
  idleMs?: number;
  now?: () => Date;
}

export const relayConfig = () => ({ url: getSettings().telegramRelayUrl.trim(), auth: getSecret('telegram_relay_auth') });

/** Background loop; idle until the instance is connected to a shared bot. */
export function startRelayClient(getDeps: () => Deps | null, opts: RelayLoopOptions = {}): { stop(): void; done: Promise<void> } {
  const abort = new AbortController();
  const idleMs = opts.idleMs ?? 15_000;
  const getConfig = opts.getConfig ?? relayConfig;
  const makeClient = opts.makeClient ?? ((url: string, auth: string) => relayClient(url, auth));
  let lastError = '';

  async function loop(): Promise<void> {
    let failures = 0;
    while (!abort.signal.aborted) {
      let cfg: { url: string; auth: string | null } = { url: '', auth: null };
      try { cfg = getConfig(); } catch { /* settings or secrets unreadable: treat as not connected */ }
      if (!cfg.url || !cfg.auth) { await sleep(idleMs, abort.signal); continue; }
      try {
        await relayPass(makeClient(cfg.url, cfg.auth), { getDeps, now: opts.now }, opts.pollSeconds ?? 25);
        failures = 0;
        lastError = '';
      } catch (e) {
        const m = e instanceof Error ? e.message : 'error';
        if (m !== lastError) { console.error('telegram relay:', m); lastError = m; } // once per distinct problem
        failures++;
        await sleep(Math.min(idleMs * 2 ** Math.min(failures, 4), 5 * 60_000), abort.signal);
      }
    }
  }
  const done = loop().catch((e) => { console.error('telegram relay stopped:', e instanceof Error ? e.message : 'error'); });
  return { stop: () => abort.abort(), done };
}
