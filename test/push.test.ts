import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { openDb, getDb } from '../server/db.js';
import {
  countPushSubscriptions, encryptPayload, isAllowedEndpoint, savePushSubscription, sendPush, vapidAuthorization, vapidPublicKey,
} from '../server/push.js';

process.env.SECRET_KEY = 'test-key-for-unit-tests-only-0123456789';
beforeEach(() => { openDb(':memory:'); });

/** A browser's side: its key pair and auth secret, and RFC 8291 decryption. */
function browser() {
  const ecdh = createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const auth = randomBytes(16);
  const decrypt = (body: Buffer) => {
    const salt = body.subarray(0, 16);
    const idlen = body[20]!;
    const asPublic = body.subarray(21, 21 + idlen);
    const ct = body.subarray(21 + idlen);
    const shared = ecdh.computeSecret(asPublic);
    const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), pub, asPublic]), 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
    return plain.subarray(0, plain.length - 1).toString('utf8');
  };
  return { p256dh: pub.toString('base64url'), auth: auth.toString('base64url'), decrypt };
}

test('encryptPayload: the browser decrypts exactly the message (aes128gcm, rs 4096)', () => {
  const b = browser();
  const body = encryptPayload(Buffer.from('{"title":"חשבונית חדשה"}'), b.p256dh, b.auth);
  assert.equal(body.readUInt32BE(16), 4096);
  assert.equal(b.decrypt(body), '{"title":"חשבונית חדשה"}');
});

test('VAPID: one key pair kept; the JWT is signed by it for the push service origin', () => {
  const key = vapidPublicKey();
  assert.equal(vapidPublicKey(), key);
  assert.equal(Buffer.from(key, 'base64url').length, 65);
  const h = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', Date.UTC(2026, 10, 26));
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h)!;
  assert.equal(k, key);
  const [hd, cl, sig] = jwt!.split('.');
  assert.equal(JSON.parse(Buffer.from(cl!, 'base64url').toString()).aud, 'https://fcm.googleapis.com');
  const raw = Buffer.from(key, 'base64url');
  const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${hd}.${cl}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url')));
});

test('only real push services are allowed as endpoints', () => {
  assert.ok(isAllowedEndpoint('https://fcm.googleapis.com/fcm/send/x'));
  assert.ok(isAllowedEndpoint('https://web.push.apple.com/QG'));
  assert.ok(isAllowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
  assert.ok(!isAllowedEndpoint('http://fcm.googleapis.com/x'));
  assert.ok(!isAllowedEndpoint('https://169.254.169.254/latest'));
  assert.ok(!isAllowedEndpoint('https://evil.example/push.apple.com'));
});

test('sendPush: encrypted POST to each device; a device the service says is gone is forgotten', async () => {
  const a = browser(); const b = browser();
  savePushSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: { p256dh: a.p256dh, auth: a.auth } }, 'ua');
  savePushSubscription({ endpoint: 'https://web.push.apple.com/b', keys: { p256dh: b.p256dh, auth: b.auth } }, 'ua');
  const seen: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) });
    return url.includes('apple') ? new Response('{"reason":"Unregistered"}', { status: 410 }) : new Response(null, { status: 201 });
  }) as unknown as typeof fetch;
  const r = await sendPush({ title: 'T', body: 'B', url: '/items/1' }, f);
  assert.deepEqual(r, { sent: 1, failed: 1, devices: 2, errors: ['web.push.apple.com: 410 {"reason":"Unregistered"}'] });
  assert.equal(seen[0]!.headers['Content-Encoding'], 'aes128gcm');
  assert.match(seen[0]!.headers.Authorization!, /^vapid t=/);
  assert.equal(seen[0]!.headers.Urgency, 'high', 'Apple holds back lower-urgency pushes on a locked iPhone');
  assert.deepEqual(JSON.parse(a.decrypt(seen[0]!.body)), { title: 'T', body: 'B', url: '/items/1' });
  assert.equal(countPushSubscriptions(), 1);
  assert.equal(getDb().prepare('SELECT endpoint FROM push_subscriptions').pluck().get(), 'https://fcm.googleapis.com/fcm/send/a');
});
