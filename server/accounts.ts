import crypto from 'node:crypto';
import { connectDb } from './db.js';
import type { Db } from './db.js';

/**
 * Accounts live in their own database (accounts.db), apart from each user's invoice database.
 * A user's `dbFile` (relative to DATA_DIR) is that user's invoice database; null means the process's
 * default database (tests and scripts that call openDb()).
 */
export const ACCOUNT_MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT,
        password_hash TEXT,
        google_sub TEXT UNIQUE,
        is_admin INTEGER NOT NULL DEFAULT 0,
        db_file TEXT,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX sessions_user ON sessions (user_id);
      CREATE TABLE invites (
        token_hash TEXT PRIMARY KEY,
        email TEXT,
        created_by TEXT REFERENCES users (id),
        created_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_by TEXT REFERENCES users (id),
        used_at TEXT
      );
      CREATE TABLE api_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    // Recipes every user's documents can use (server/core/sharedRecipes.ts): one per vendor, newest wins.
    version: 2,
    sql: `
      CREATE TABLE shared_recipes (
        vendor_key TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        json TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('ai','user')),
        contributed_by TEXT,
        updated_at TEXT NOT NULL,
        adopted INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
];

let adb: Db | null = null;

export function openAccounts(file: string): Db {
  adb?.close();
  adb = connectDb(file, ACCOUNT_MIGRATIONS);
  return adb;
}

export function accountsDb(): Db {
  if (!adb) throw new Error('Accounts database not opened: call openAccounts() first');
  return adb;
}

export const sha256hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('base64url');

// ---------- passwords (scrypt) ----------

export const MIN_PASSWORD = 10;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [kind, n, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p });
  return crypto.timingSafeEqual(got, expected);
}

// ---------- users ----------

export interface User {
  id: string; email: string; name: string | null; isAdmin: boolean; dbFile: string | null;
  disabled: boolean; createdAt: string; hasPassword: boolean; hasGoogle: boolean;
}
interface UserRow {
  id: string; email: string; name: string | null; password_hash: string | null; google_sub: string | null;
  is_admin: number; db_file: string | null; disabled: number; created_at: string;
}
const toUser = (r: UserRow): User => ({
  id: r.id, email: r.email, name: r.name, isAdmin: !!r.is_admin, dbFile: r.db_file, disabled: !!r.disabled,
  createdAt: r.created_at, hasPassword: !!r.password_hash, hasGoogle: !!r.google_sub,
});
const row = (sql: string, ...args: unknown[]) => accountsDb().prepare(sql).get(...args) as UserRow | undefined;

export const getUser = (id: string): User | null => { const r = row('SELECT * FROM users WHERE id = ?', id); return r ? toUser(r) : null; };
export const userByEmail = (email: string): User | null => { const r = row('SELECT * FROM users WHERE email = ?', email.trim()); return r ? toUser(r) : null; };
export const userByGoogle = (sub: string): User | null => { const r = row('SELECT * FROM users WHERE google_sub = ?', sub); return r ? toUser(r) : null; };
export const listUsers = (): User[] => (accountsDb().prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[]).map(toUser);
export const countUsers = (): number => accountsDb().prepare('SELECT COUNT(*) FROM users').pluck().get() as number;

export class AccountError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function createUser(u: {
  email: string; name?: string | null; password?: string | null; googleSub?: string | null;
  isAdmin?: boolean; dbFile?: string | null; id?: string;
}): User {
  const email = u.email.trim();
  if (!email) throw new AccountError(400, 'email_required');
  if (userByEmail(email)) throw new AccountError(409, 'email_taken');
  if (u.password != null && u.password.length < MIN_PASSWORD) throw new AccountError(400, 'password_too_short');
  const id = u.id ?? crypto.randomUUID();
  // A new user's invoices go to their own file; the id is a UUID, so the path is safe.
  const dbFile = u.dbFile === undefined ? `tenants/${id}.db` : u.dbFile;
  accountsDb().prepare(
    `INSERT INTO users (id, email, name, password_hash, google_sub, is_admin, db_file, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, email, u.name ?? null, u.password ? hashPassword(u.password) : null, u.googleSub ?? null,
    u.isAdmin ? 1 : 0, dbFile, new Date().toISOString());
  return getUser(id)!;
}

export function checkPassword(email: string, password: string): User | null {
  const r = row('SELECT * FROM users WHERE email = ?', email.trim());
  if (!r || r.disabled || !verifyPassword(password, r.password_hash)) return null;
  return toUser(r);
}

export function setPassword(userId: string, password: string): void {
  if (password.length < MIN_PASSWORD) throw new AccountError(400, 'password_too_short');
  accountsDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
}

export function updateProfile(userId: string, patch: { email?: string; name?: string | null }): User {
  const db = accountsDb();
  if (patch.email !== undefined) {
    const email = patch.email.trim();
    if (!email) throw new AccountError(400, 'email_required');
    const other = userByEmail(email);
    if (other && other.id !== userId) throw new AccountError(409, 'email_taken');
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, userId);
  }
  if (patch.name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(patch.name, userId);
  return getUser(userId)!;
}

export function linkGoogle(userId: string, sub: string): void {
  accountsDb().prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(sub, userId);
}

/** Disabling also ends the user's sessions and API token. The owner (admin) cannot be disabled. */
export function setDisabled(userId: string, disabled: boolean): void {
  const u = getUser(userId);
  if (!u) throw new AccountError(404, 'user_not_found');
  if (u.isAdmin && disabled) throw new AccountError(400, 'cannot_disable_admin');
  const db = accountsDb();
  db.transaction(() => {
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, userId);
    if (disabled) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM api_tokens WHERE user_id = ?').run(userId);
    }
  })();
}

// ---------- sessions ----------

export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export function createSession(userId: string): string {
  const token = newToken();
  const now = Date.now();
  const db = accountsDb();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256hex(token), userId, now, now + SESSION_MS);
  return token;
}

export function sessionUser(token: string): User | null {
  const r = accountsDb().prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`,
  ).get(sha256hex(token), Date.now()) as UserRow | undefined;
  return r ? toUser(r) : null;
}

export function deleteSession(token: string): void {
  accountsDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256hex(token));
}

/** Ends every session of a user except `keepToken` (after a password change). */
export function deleteOtherSessions(userId: string, keepToken: string | null): void {
  accountsDb().prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, keepToken ? sha256hex(keepToken) : '');
}

// ---------- invites ----------

export const INVITE_MS = 7 * 24 * 60 * 60 * 1000;
export interface Invite { id: string; email: string | null; createdAt: string; expiresAt: number; usedAt: string | null; usedBy: string | null }

/** Returns the one-time token (only its hash is stored); `id` in listings is a prefix of that hash. */
export function createInvite(createdBy: string, email: string | null): { token: string; expiresAt: number } {
  const token = newToken();
  const expiresAt = Date.now() + INVITE_MS;
  accountsDb().prepare('INSERT INTO invites (token_hash, email, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256hex(token), email?.trim() || null, createdBy, new Date().toISOString(), expiresAt);
  return { token, expiresAt };
}

export function listInvites(): Invite[] {
  return (accountsDb().prepare('SELECT * FROM invites ORDER BY created_at DESC').all() as {
    token_hash: string; email: string | null; created_at: string; expires_at: number; used_at: string | null; used_by: string | null;
  }[]).map((r) => ({ id: r.token_hash.slice(0, 16), email: r.email, createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at, usedBy: r.used_by }));
}

export function revokeInvite(id: string): boolean {
  if (!/^[0-9a-f]{16}$/.test(id)) return false;
  return accountsDb().prepare("DELETE FROM invites WHERE substr(token_hash, 1, 16) = ? AND used_at IS NULL").run(id).changes > 0;
}

/** An unused, unexpired invite for this token, or null. */
export function openInvite(token: string): { email: string | null } | null {
  const r = accountsDb().prepare('SELECT email, expires_at, used_at FROM invites WHERE token_hash = ?')
    .get(sha256hex(token)) as { email: string | null; expires_at: number; used_at: string | null } | undefined;
  if (!r || r.used_at || r.expires_at <= Date.now()) return null;
  return { email: r.email };
}

/**
 * Creates the user an invite admits, and marks the invite used, in one transaction.
 * An invite made out to an email admits only that email.
 */
export function acceptInvite(token: string, u: { email: string; name?: string | null; password?: string | null; googleSub?: string | null }): User {
  const db = accountsDb();
  return db.transaction(() => {
    const inv = openInvite(token);
    if (!inv) throw new AccountError(400, 'invite_invalid');
    if (inv.email && inv.email.toLowerCase() !== u.email.trim().toLowerCase()) throw new AccountError(400, 'invite_email_mismatch');
    const user = createUser({ ...u, isAdmin: false });
    db.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE token_hash = ?').run(new Date().toISOString(), user.id, sha256hex(token));
    return user;
  })();
}

// ---------- API tokens (read-only /api/v1) ----------

/** Replaces the user's API token; the token is returned once and only its hash is stored. */
export function createApiToken(userId: string): string {
  const token = newToken();
  accountsDb().prepare(
    'INSERT INTO api_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at',
  ).run(sha256hex(token), userId, new Date().toISOString());
  return token;
}

export function deleteApiToken(userId: string): void {
  accountsDb().prepare('DELETE FROM api_tokens WHERE user_id = ?').run(userId);
}

export function hasApiToken(userId: string): boolean {
  return !!accountsDb().prepare('SELECT 1 FROM api_tokens WHERE user_id = ?').get(userId);
}

export function apiTokenUser(token: string): User | null {
  const r = accountsDb().prepare(
    'SELECT u.* FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND u.disabled = 0',
  ).get(sha256hex(token)) as UserRow | undefined;
  return r ? toUser(r) : null;
}

export const adminUser = (): User | null => {
  const r = row('SELECT * FROM users WHERE is_admin = 1 ORDER BY created_at LIMIT 1');
  return r ? toUser(r) : null;
};

/**
 * First start on this accounts database: the owner account. Its invoices stay in the existing single-user
 * database (`ownerDbFile`, app.db), so an upgrade keeps every document, setting and connection.
 * Login is ADMIN_EMAIL (or "admin") with APP_PASSWORD; with only ADMIN_EMAIL, Google sign-in.
 */
export function ensureOwner(env: Record<string, string | undefined>, ownerDbFile: string | null): User | null {
  if (countUsers() > 0) return null;
  const email = env.ADMIN_EMAIL?.trim() || 'admin';
  const owner = createUser({ email, name: null, isAdmin: true, dbFile: ownerDbFile });
  // APP_PASSWORD was checked at boot (envProblems), with its own, older length rules.
  if (env.APP_PASSWORD) accountsDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(env.APP_PASSWORD), owner.id);
  return getUser(owner.id);
}
