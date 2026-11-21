import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * Numbered migrations, applied in order and recorded in `schema_version`.
 * To change the schema, append one entry — never edit or reorder an applied one.
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE secrets (key TEXT PRIMARY KEY, ciphertext TEXT NOT NULL);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE vendors (
        key TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('business','personal','ignored','unreviewed')),
        default_category TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE recipes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vendor_key TEXT NOT NULL,
        version INTEGER NOT NULL,
        json TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('starter','ai','user')),
        created_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX recipes_vendor ON recipes (vendor_key, version);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE emails (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT,
        sender TEXT,
        subject TEXT,
        received_at TEXT,
        mode TEXT NOT NULL CHECK (mode IN ('ongoing','backfill','manual')),
        gmail_marked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES emails (message_id),
        attachment_name TEXT,
        pdf BLOB,
        sha256 TEXT UNIQUE,
        text TEXT,
        state TEXT NOT NULL,
        reason TEXT,
        fields_json TEXT,
        provenance TEXT,
        vendor_key TEXT,
        recipe_failed INTEGER NOT NULL DEFAULT 0,
        storage_path TEXT,
        accounting_ref TEXT,
        accounting_mode TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX items_message ON items (message_id);
      CREATE INDEX items_state ON items (state);
      CREATE UNIQUE INDEX items_doc_number ON items (
        vendor_key, json_extract(fields_json, '$.docNumber'), json_extract(fields_json, '$.docType')
      ) WHERE vendor_key IS NOT NULL
          AND json_extract(fields_json, '$.docNumber') IS NOT NULL
          AND state != 'dismissed';
      CREATE TABLE item_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL REFERENCES items (id),
        at TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        note TEXT
      );
      CREATE INDEX item_events_item ON item_events (item_id);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE missed (
        message_id TEXT PRIMARY KEY,
        sender TEXT,
        subject TEXT,
        received_at TEXT,
        found_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'queued', 'hidden'))
      );
      CREATE INDEX missed_status ON missed (status);
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE ingest_failures (
        message_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        error TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        first_at TEXT,
        last_at TEXT
      );
    `,
  },
  {
    // Shared Telegram bot hub (server/relay/hub.ts); stays empty on an instance that does not run one.
    version: 7,
    sql: `
      CREATE TABLE relay_tenants (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT
      );
      CREATE TABLE relay_pair_codes (
        code TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES relay_tenants (id),
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE relay_chats (
        chat_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES relay_tenants (id),
        name TEXT,
        linked_at TEXT NOT NULL
      );
      CREATE TABLE relay_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL REFERENCES relay_tenants (id),
        chat_id TEXT NOT NULL,
        file_id TEXT NOT NULL,
        file_name TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX relay_updates_tenant ON relay_updates (tenant_id, id);
    `,
  },
  {
    // One row per AI reply, with the tokens the provider reported (null when it did not say).
    version: 8,
    sql: `
      CREATE TABLE ai_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        day TEXT NOT NULL,
        purpose TEXT NOT NULL,
        item_id TEXT,
        provider TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER
      );
      CREATE INDEX ai_usage_item ON ai_usage (item_id);
      CREATE INDEX ai_usage_day ON ai_usage (day);
    `,
  },
];

export function migrate(db: Db, migrations = MIGRATIONS): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const current = (db.prepare('SELECT COALESCE(MAX(version), 0) FROM schema_version').pluck().get() as number);
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
    })();
  }
}

let db: Db | null = null;

export function openDb(file: string): Db {
  db?.close();
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error('Database not opened: call openDb() first');
  return db;
}
