import { getDb } from './db.js';
import { IL_DEFAULTS } from './defaults/il.js';

export type Category = { name: string; sendToAccounting: boolean; accountingClassification?: string };
export type AiSettings = {
  mode: 'anthropic' | 'openai' | 'gemini' | 'ssh' | 'none';
  model?: string;
  ssh?: { host: string; port: number; user: string; hostKeySha256: string };
};
/** The one cloud the PDFs are filed to. Only one is connected at a time. */
export type StorageProvider = 'dropbox' | 'gdrive';
export type MorningSettings = { mode: 'api_fields' | 'api_file' | 'email' | null; inboxEmail?: string };

export type Settings = {
  locale: 'he';
  currency: string;
  currencyLabel: string;
  vatRate: number;
  gmailLabel: string | null;
  /** OAuth scopes granted for Gmail (not a secret); the UI checks it for gmail.send. */
  gmailScopes: string[];
  storageProvider: StorageProvider;
  storageRoot: string;
  folderTemplate: string;
  filenameTemplate: string;
  categories: Category[];
  ai: AiSettings;
  morning: MorningSettings;
  setupComplete: boolean;
  backfillDone: boolean;
  backfillStartedAt: string | null;
  /** Background backfill run (POST /api/backfill/start): when it ended, its counts, or its sanitized error. */
  backfillFinishedAt: string | null;
  backfillResult: { emails: number; items: number; failed: number } | null;
  backfillError: string | null;
  pollMinutes: number;
  /** IANA zone for the daily missed-scan time and the tax year. */
  timezone: string;
  /** Worker status for the UI (ISO timestamps / message). */
  lastTickAt: string | null;
  lastTickError: string | null;
  lastAiSuccessAt: string | null;
  lastMissedScanAt: string | null;
  /** Telegram chats allowed to hand in receipts through the bot (numeric chat ids, as strings). */
  telegramChatIds: string[];
  /** Address of a shared Telegram bot service (hub) this instance connects to; empty = none. */
  telegramRelayUrl: string;
};

/** Each setting is one row (JSON-encoded); rows absent from the table fall back to IL_DEFAULTS. */
export function getSettings(): Settings {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const out: Record<string, unknown> = structuredClone(IL_DEFAULTS);
  for (const r of rows) if (r.key in IL_DEFAULTS) out[r.key] = JSON.parse(r.value);
  return out as Settings;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const db = getDb();
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in IL_DEFAULTS) || v === undefined) continue;
      upsert.run(k, JSON.stringify(v));
    }
  })();
  return getSettings();
}
