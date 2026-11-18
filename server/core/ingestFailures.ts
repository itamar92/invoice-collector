import { getDb } from '../db.js';

export interface IngestFailure {
  messageId: string; mode: 'ongoing' | 'backfill' | 'manual'; error: string;
  attempts: number; firstAt: string; lastAt: string;
}

/** Remembers a message whose fetch/ingest failed so a worker can retry it (upsert; attempts + 1). */
export function recordIngestFailure(messageId: string, mode: IngestFailure['mode'], error: unknown): void {
  const t = new Date().toISOString();
  const msg = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  getDb().prepare(
    `INSERT INTO ingest_failures (message_id, mode, error, attempts, first_at, last_at) VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET mode = excluded.mode, error = excluded.error,
       attempts = attempts + 1, last_at = excluded.last_at`).run(messageId, mode, msg, t, t);
}

export function clearIngestFailure(messageId: string): void {
  getDb().prepare('DELETE FROM ingest_failures WHERE message_id = ?').run(messageId);
}

export function listIngestFailures(): IngestFailure[] {
  return (getDb().prepare('SELECT * FROM ingest_failures ORDER BY first_at, message_id').all() as Record<string, unknown>[])
    .map((r) => ({
      messageId: r.message_id as string, mode: r.mode as IngestFailure['mode'], error: r.error as string,
      attempts: r.attempts as number, firstAt: r.first_at as string, lastAt: r.last_at as string,
    }));
}
