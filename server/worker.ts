import { getDb } from './db.js';
import { getSettings, updateSettings } from './settings.js';
import { retryIngestFailures } from './core/backfill.js';
import { recordIngestFailure } from './core/ingestFailures.js';
import { getItem, listItems, noteItem, transition } from './core/items.js';
import type { Item } from './core/items.js';
import { scanMissed } from './core/missed.js';
import { autoApproveWaitingVendors, processItem, setVendorDecision } from './core/pipeline.js';
import type { VendorStatus } from './core/recipeStore.js';
import type { Deps } from './core/types.js';
import { ingestMessage, markHandledIfComplete } from './sources/gmail.js';
import type { GmailSource } from './sources/gmail.js';
import { collectInbox } from './sources/storageInbox.js';

const MISSED_SCAN_HOUR = 6;

export interface WorkerContext { deps: Deps; gmail: GmailSource }
export interface WorkerOptions { intervalMs?: number; now?: () => Date }

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Local calendar date (YYYY-MM-DD) and hour in an IANA zone. */
function localParts(d: Date, tz: string): { date: string; hour: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/** Items the worker should run now: queued; waiting_ai/ready/stored when due (or left without a due time by a crash). */
function dueItems(nowIso: string): Item[] {
  const all = listItems({ state: ['queued', 'waiting_ai', 'ready', 'stored'], limit: 100_000 }).reverse();
  return all.filter((i) => i.state === 'queued' || i.nextAttemptAt === null || i.nextAttemptAt <= nowIso);
}

/**
 * Background worker. `tick()` is one full pass (exposed for "run now"); overlapping calls share the running pass.
 * lastAiSuccessAt is set when an item that was not AI-extracted before the tick is AI-extracted after it.
 */
export function startWorker(getDeps: () => WorkerContext, opts: WorkerOptions = {}): { stop(): void; tick(): Promise<void> } {
  const clock = opts.now ?? (() => new Date());
  let running: Promise<void> | null = null;

  async function pass(): Promise<void> {
    const settings = getSettings();
    if (!settings.setupComplete || !settings.backfillDone) return;
    const now = clock();
    const errors: string[] = [];
    const step = async (fn: () => Promise<void>) => { try { await fn(); } catch (e) { errors.push(msg(e)); } };

    let ctx: WorkerContext | null = null;
    await step(async () => { ctx = getDeps(); });
    if (ctx) {
      const { deps, gmail } = ctx as WorkerContext;
      const tz = settings.timezone;
      const local = localParts(now, tz);
      const yearStart = `${local.date.slice(0, 4)}-01-01`;

      await step(async () => { await retryIngestFailures(gmail, deps); }); // R21: every tick

      await step(async () => {
        // The whole tax year, not a window after the newest email: a message labelled today may be months old.
        // The query is bounded by date, excludes the done label, and is paged; known ids are skipped by
        // ingestMessage without a fetch.
        const after = yearStart.replaceAll('-', '/');
        const ids = await gmail.listCandidateMessages({ after, labelled: settings.gmailLabels.length > 0 });
        for (const id of ids) {
          try { await ingestMessage(gmail, id, 'ongoing'); } catch (e) { recordIngestFailure(id, 'ongoing', e); }
        }
      });

      await step(async () => { // vendor decisions saved while Gmail/Dropbox were not connected
        const rows = getDb().prepare(
          `SELECT DISTINCT v.key AS key, v.status AS status FROM items i JOIN vendors v ON v.key = i.vendor_key
           WHERE i.state = 'awaiting_vendor' AND v.status != 'unreviewed'`).all() as { key: string; status: VendorStatus }[];
        for (const v of rows) {
          try { await setVendorDecision(v.key, v.status, deps); } catch (e) { errors.push(msg(e)); }
        }
      });

      await step(async () => { await autoApproveWaitingVendors(deps); }); // setting on: nothing waits for the owner

      await step(async () => { // files dropped by hand in the storage root; queued here, filed by the step below
        const r = await collectInbox(deps);
        errors.push(...r.errors);
      });

      await step(async () => {
        for (const it of dueItems(now.toISOString())) {
          try {
            await processItem(it.id, deps);
            if (it.provenance !== 'ai' && getItem(it.id)?.provenance === 'ai') {
              updateSettings({ lastAiSuccessAt: now.toISOString() });
            }
          } catch (e) {
            try {
              transition(it.id, 'needs_attention', 'internal_error', msg(e));
            } catch { try { noteItem(it.id, `internal_error: ${msg(e)}`); } catch { /* DB unusable */ } }
          }
        }
      });

      await step(async () => {
        const ids = getDb().prepare(`SELECT message_id FROM emails WHERE gmail_marked = 0`).pluck().all() as string[];
        for (const id of ids) {
          try { await markHandledIfComplete(gmail, id); } catch (e) { errors.push(msg(e)); }
        }
      });

      await step(async () => {
        const last = getSettings().lastMissedScanAt;
        const doneToday = last !== null && localParts(new Date(last), tz).date === local.date;
        if (local.hour < MISSED_SCAN_HOUR || doneToday) return;
        await scanMissed(gmail, yearStart);
        updateSettings({ lastMissedScanAt: now.toISOString() });
      });
    }
    updateSettings({ lastTickAt: now.toISOString(), lastTickError: errors.length ? errors.join('; ') : null });
  }

  function tick(): Promise<void> {
    if (!running) running = pass().finally(() => { running = null; });
    return running;
  }

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (stopped) return;
    const ms = opts.intervalMs ?? Math.max(1, getSettings().pollMinutes) * 60_000; // re-read so settings changes apply
    timer = setTimeout(() => {
      tick().catch((e) => console.error('worker tick failed', e)).finally(schedule);
    }, ms);
    timer.unref();
  };
  schedule();
  return { stop: () => { stopped = true; clearTimeout(timer); }, tick };
}
