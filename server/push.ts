import { createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, createCipheriv, sign } from 'node:crypto';
import { getDb } from './db.js';
import { getSecret, setSecret } from './secrets.js';

/**
 * Web Push (RFC 8030) to the browsers / home-screen apps the owner turned notifications on in. Messages are
 * encrypted for each subscription (RFC 8291, aes128gcm) and signed with this instance's VAPID key (RFC 8292);
 * no third-party library. The VAPID key pair is made on first use and kept with the other secrets.
 */

/** Push services of the browsers that support Web Push; any other endpoint is refused (the server POSTs to it). */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.apple\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/,
];

export interface PushSubscriptionInput { endpoint: string; keys: { p256dh: string; auth: string } }
export interface PushMessage { title: string; body: string; url: string; tag?: string }

const b64u = (b: Buffer) => b.toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');

export function isAllowedEndpoint(endpoint: string): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

interface Vapid { publicKey: string; privateJwk: { kty: string; crv: string; x: string; y: string; d: string } }

/** This instance's VAPID key pair; made and saved the first time it is needed. */
function vapid(): Vapid {
  const saved = getSecret('push_vapid');
  if (saved) return JSON.parse(saved) as Vapid;
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as Vapid['privateJwk'];
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
  const v: Vapid = { publicKey, privateJwk: jwk };
  setSecret('push_vapid', JSON.stringify(v));
  return v;
}

/** The public key the browser subscribes with (applicationServerKey), base64url of the raw P-256 point. */
export function vapidPublicKey(): string { return vapid().publicKey; }

/** `Authorization: vapid t=<JWT>, k=<public key>` for one push service. */
export function vapidAuthorization(endpoint: string, now = Date.now()): string {
  const v = vapid();
  const aud = new URL(endpoint).origin;
  // Apple requires a real mailto: or https: subject.
  const site = process.env.PUBLIC_URL?.startsWith('https://') ? process.env.PUBLIC_URL : 'mailto:noreply@invoice-collector.app';
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: site })));
  const key = createPrivateKey({ key: v.privateJwk, format: 'jwk' });
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${v.publicKey}`;
}

/** RFC 8291 aes128gcm body for one subscription: salt | rs | keyid(as_public) | ciphertext (single record). */
export function encryptPayload(payload: Buffer, p256dh: string, auth: string): Buffer {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const ecdh = createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

export function savePushSubscription(s: PushSubscriptionInput, userAgent: string | null, now = new Date()): void {
  getDb().prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
  ).run(s.endpoint, s.keys.p256dh, s.keys.auth, userAgent?.slice(0, 300) ?? null, now.toISOString());
}

export function deletePushSubscription(endpoint: string): void {
  getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

export function countPushSubscriptions(): number {
  return getDb().prepare('SELECT COUNT(*) FROM push_subscriptions').pluck().get() as number;
}

/**
 * Sends `msg` to every subscription. A subscription the push service says is gone (404/410) is forgotten.
 * Never throws: a failed push must not affect the document it is about.
 */
export interface PushResult { sent: number; failed: number; devices: number; errors: string[] }

export async function sendPush(msg: PushMessage, fetchImpl: typeof fetch = fetch): Promise<PushResult> {
  let rows: { endpoint: string; p256dh: string; auth: string }[];
  try {
    rows = getDb().prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all() as typeof rows;
  } catch { return { sent: 0, failed: 0, devices: 0, errors: [] }; }
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  // A failed push is otherwise invisible: say which push service refused it and why (Apple/Google send a reason).
  const fail = (endpoint: string, why: string) => {
    failed++;
    const host = (() => { try { return new URL(endpoint).hostname; } catch { return 'unknown'; } })();
    errors.push(`${host}: ${why}`.slice(0, 200));
    console.warn(`[push] ${host}: ${why}`);
  };
  const payload = Buffer.from(JSON.stringify(msg));
  for (const r of rows) {
    try {
      if (!isAllowedEndpoint(r.endpoint)) { deletePushSubscription(r.endpoint); fail(r.endpoint, 'endpoint not allowed'); continue; }
      const res = await fetchImpl(r.endpoint, {
        method: 'POST',
        headers: {
          // 'high': Apple sends anything lower at its low (power-saving) priority, which a locked iPhone may hold back
          // for a long time, so a new document's notification arrived only once the app was opened.
          Authorization: vapidAuthorization(r.endpoint), TTL: '86400', Urgency: 'high',
          'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
          ...(msg.tag ? { Topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
        },
        body: new Uint8Array(encryptPayload(payload, r.p256dh, r.auth)),
      });
      if (res.ok) sent++;
      else {
        const reason = await res.text().catch(() => '');
        fail(r.endpoint, `${res.status} ${reason.replace(/\s+/g, ' ').trim()}`.trim());
        if (res.status === 404 || res.status === 410) deletePushSubscription(r.endpoint);
      }
    } catch (e) { fail(r.endpoint, (e as Error).message || 'network error'); }
  }
  return { sent, failed, devices: rows.length, errors };
}
