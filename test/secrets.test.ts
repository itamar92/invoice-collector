import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getDb } from '../server/db.js';
import { setSecret, getSecret, secretStatus, encrypt, decrypt } from '../server/secrets.js';

process.env.SECRET_KEY = 'test-key-for-unit-tests-only-0123456789';

test('secrets round-trip encrypted and status never leaks values', () => {
  openDb(':memory:');
  setSecret('morning_secret', 's3cr3t');
  assert.equal(getSecret('morning_secret'), 's3cr3t');
  assert.doesNotMatch(getDb().prepare('select ciphertext from secrets').pluck().get() as string, /s3cr3t/);
  assert.deepEqual(secretStatus().morning_secret, true);
  assert.deepEqual(secretStatus().gmail_refresh, false);
  assert.equal(getSecret('gmail_refresh'), null);
});

test('setSecret(null) deletes', () => {
  openDb(':memory:');
  setSecret('morning_id', 'x');
  setSecret('morning_id', null);
  assert.equal(getSecret('morning_id'), null);
  assert.equal(secretStatus().morning_id, false);
});

test('encrypt uses a fresh iv and rejects tampering', () => {
  const a = encrypt('hello');
  assert.notEqual(a, encrypt('hello'));
  assert.equal(decrypt(a), 'hello');
  const parts = a.split('.');
  parts[2] = Buffer.from('tampered').toString('base64');
  assert.throws(() => decrypt(parts.join('.')));
});

test('missing SECRET_KEY throws', () => {
  const k = process.env.SECRET_KEY;
  delete process.env.SECRET_KEY;
  assert.throws(() => encrypt('x'), /SECRET_KEY/);
  process.env.SECRET_KEY = k;
});
