/**
 * Shared temp folder for the SSH agent (docs/SETUP.md, section 5): to let the agent read a document, the app
 * writes it to `<inbox>/<id>/document.pdf`, the agent host's wrapper runs Claude Code with that one directory as
 * its only working directory, and the directory is removed as soon as the analysis ends, whatever the outcome.
 * A periodic sweep removes anything older that a crash left behind. The database keeps its own copy as always.
 *
 * On the agent host the folder is owned by the app container's user, group-readable by the agent user only.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AiUnavailableError } from './provider.js';

export const INBOX_FILE = 'document.pdf';
/** Same shape the wrapper (deploy/ic-agent.sh) accepts. */
export const INBOX_ID = /^[A-Za-z0-9-]{16,64}$/;
/** Leftovers older than this are removed by the sweep (an analysis never runs this long). */
export const INBOX_MAX_AGE_MS = 15 * 60_000;
export const INBOX_SWEEP_EVERY_MS = 10 * 60_000;

/** The folder inside the app (AI_INBOX_DIR), or null when the feature is off. */
export function inboxDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env.AI_INBOX_DIR?.trim();
  return dir ? path.resolve(dir) : null;
}

/**
 * Writes `pdf` to a fresh `<dir>/<id>/document.pdf` (directory 0750, file 0640: the group is the agent's),
 * runs `fn(id)`, and removes the directory afterwards, on success, error or timeout alike.
 * A folder the app cannot write is an AiUnavailableError: a setup problem the item waits out.
 */
export async function withInboxFile<T>(dir: string, pdf: Buffer, fn: (id: string) => Promise<T>): Promise<T> {
  const id = randomUUID();
  const sub = path.join(dir, id);
  try {
    // The new directory inherits the inbox's group and setgid bit, so the file gets the agent's group. Never chmod
    // it unless the umask stripped group access: chmod by a non-member of that group clears setgid (Linux).
    fs.mkdirSync(sub, { mode: 0o750 });
    if ((fs.statSync(sub).mode & 0o050) !== 0o050) fs.chmodSync(sub, 0o750);
    fs.writeFileSync(path.join(sub, INBOX_FILE), pdf, { mode: 0o640, flag: 'wx' });
    fs.chmodSync(path.join(sub, INBOX_FILE), 0o640);
  } catch (e) {
    removeQuietly(sub);
    throw new AiUnavailableError(`cannot write to the AI inbox folder ${dir}: ${(e as Error).message}`);
  }
  try {
    return await fn(id);
  } finally {
    removeQuietly(sub);
  }
}

/** True when the app can create and remove an entry in the inbox (the Settings connection check). */
export function checkInbox(dir: string): void {
  const probe = path.join(dir, `.probe-${randomUUID()}`);
  try {
    fs.mkdirSync(probe);
  } catch (e) {
    throw new AiUnavailableError(`cannot write to the AI inbox folder ${dir}: ${(e as Error).message}`);
  } finally {
    removeQuietly(probe);
  }
}

/** Removes entries older than `maxAgeMs` (by modification time). Returns how many were removed. */
export function sweepInbox(dir: string, maxAgeMs = INBOX_MAX_AGE_MS, now = Date.now()): number {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      if (now - fs.lstatSync(p).mtimeMs < maxAgeMs) continue;
      fs.rmSync(p, { recursive: true, force: true });
      removed++;
    } catch { /* gone already, or not ours */ }
  }
  return removed;
}

/** Sweeps now and then every INBOX_SWEEP_EVERY_MS; no-op when the feature is off. */
export function startInboxSweeper(dir: string | null = inboxDir()): { stop(): void } {
  if (!dir) return { stop() {} };
  const run = () => {
    const n = sweepInbox(dir);
    if (n) console.log(`ai inbox: removed ${n} leftover entr${n === 1 ? 'y' : 'ies'}`);
  };
  run();
  const t = setInterval(run, INBOX_SWEEP_EVERY_MS);
  t.unref();
  return { stop: () => clearInterval(t) };
}

function removeQuietly(p: string): void {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort; the sweep retries */ }
}
