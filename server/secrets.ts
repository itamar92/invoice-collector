import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { getDb } from './db.js';

export type SecretKey =
  | 'gmail_refresh' | 'dropbox_refresh' | 'gdrive_refresh' | 'morning_id' | 'morning_secret'
  | 'ai_key_anthropic' | 'ai_key_openai' | 'ai_key_gemini' | 'ssh_private_key' | 'telegram_bot_token' | 'telegram_relay_auth'
  | 'meta_cookies';

export const SECRET_KEYS: SecretKey[] = [
  'gmail_refresh', 'dropbox_refresh', 'gdrive_refresh', 'morning_id', 'morning_secret',
  'ai_key_anthropic', 'ai_key_openai', 'ai_key_gemini', 'ssh_private_key', 'telegram_bot_token', 'telegram_relay_auth',
  'meta_cookies',
];

/** AES-256-GCM key = sha256(SECRET_KEY). Read lazily so tests can set the env first. */
function key(): Buffer {
  const raw = process.env.SECRET_KEY;
  if (!raw) throw new Error('SECRET_KEY is not set');
  return createHash('sha256').update(raw).digest();
}

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** Format: base64(iv).base64(authTag).base64(body) */
export function encrypt(plain: string): string {
  const iv = randomBytes(IV_LENGTH);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map(b => b.toString('base64')).join('.');
}

export function decrypt(cipher: string): string {
  const parts = cipher.split('.');
  if (parts.length !== 3) throw new Error('Malformed ciphertext');
  const [iv, tag, body] = parts.map(p => Buffer.from(p, 'base64'));
  if (iv.length !== IV_LENGTH) throw new Error('Malformed ciphertext: bad iv length');
  if (tag.length !== TAG_LENGTH) throw new Error('Malformed ciphertext: bad tag length');
  const d = createDecipheriv('aes-256-gcm', key(), iv, { authTagLength: TAG_LENGTH });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

export function setSecret(k: SecretKey, value: string | null): void {
  if (value === null) {
    getDb().prepare('DELETE FROM secrets WHERE key = ?').run(k);
    return;
  }
  getDb().prepare(
    'INSERT INTO secrets (key, ciphertext) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET ciphertext = excluded.ciphertext',
  ).run(k, encrypt(value));
}

export function getSecret(k: SecretKey): string | null {
  const row = getDb().prepare('SELECT ciphertext FROM secrets WHERE key = ?').get(k) as { ciphertext: string } | undefined;
  return row ? decrypt(row.ciphertext) : null;
}

/** Which secrets are configured — never the values. */
export function secretStatus(): Record<SecretKey, boolean> {
  const present = new Set(getDb().prepare('SELECT key FROM secrets').pluck().all() as string[]);
  return Object.fromEntries(SECRET_KEYS.map(k => [k, present.has(k)])) as Record<SecretKey, boolean>;
}
