import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envProblems, initDataStore } from '../server/boot.js';
import { getDb } from '../server/db.js';
import { findRecipe } from '../server/core/recipeStore.js';
import { getSettings, updateSettings } from '../server/settings.js';

process.env.SECRET_KEY = 'test-key-for-unit-tests-only-0123456789';

const LONG = 'x'.repeat(40);
const good = { SECRET_KEY: LONG, APP_PASSWORD: 'a-long-enough-password', API_TOKEN: 'y'.repeat(40), NODE_ENV: 'production' };

test('envProblems: a sound production config passes', () => {
  assert.deepEqual(envProblems(good), []);
  assert.deepEqual(envProblems({ ...good, API_TOKEN: undefined, APP_PASSWORD: undefined }), []);
});

test('envProblems: .env.example placeholders are refused in every mode, values never echoed', () => {
  for (const env of [
    { ...good, APP_PASSWORD: 'change-me' },
    { ...good, SECRET_KEY: 'replace-with-64-hex-chars' },
    { ...good, API_TOKEN: 'replace-with-another-random-string' },
    { ...good, APP_PASSWORD: 'change-me', NODE_ENV: 'development' },
  ]) {
    const p = envProblems(env);
    assert.equal(p.length, 1, JSON.stringify(env));
    assert.match(p[0], /example/);
    assert.doesNotMatch(p.join(' '), /change-me|replace-with/);
  }
});

test('envProblems: too short or missing values', () => {
  assert.match(envProblems({ ...good, SECRET_KEY: undefined }).join(), /SECRET_KEY is not set/);
  assert.match(envProblems({ ...good, SECRET_KEY: 'short' }).join(), /SECRET_KEY.*32/);
  assert.match(envProblems({ ...good, API_TOKEN: 'short' }).join(), /API_TOKEN.*32/);
  assert.match(envProblems({ ...good, APP_PASSWORD: 'short-pw' }).join(), /APP_PASSWORD.*12/);
});

test('envProblems: a short password is allowed only outside production or in demo mode on a demo data folder', () => {
  assert.deepEqual(envProblems({ ...good, APP_PASSWORD: 'demo', NODE_ENV: 'development' }), []);
  assert.deepEqual(envProblems({ ...good, APP_PASSWORD: 'demo', DEMO: '1', DATA_DIR: './data-demo' }), []);
  // The Docker image: production, DATA_DIR=/data. DEMO=1 there does not unlock it.
  assert.equal(envProblems({ ...good, APP_PASSWORD: 'demo', DEMO: '1', DATA_DIR: '/data' }).length, 1);
  assert.equal(envProblems({ ...good, APP_PASSWORD: 'demo' }).length, 1);
});

test('initDataStore loads the starter recipes once (idempotent) and marks an interrupted backfill', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ic-boot-')), 'app.db');
  initDataStore(file);
  const n = getDb().prepare(`SELECT COUNT(*) FROM recipes WHERE source = 'starter'`).pluck().get() as number;
  assert.ok(n >= 15, `starter recipes loaded: ${n}`);
  assert.equal(findRecipe('nobody@example.com', 'אקו"ם בע"מ\nתאריך אסמכתא: 10/01/2026')?.vendorKey, 'akum');
  updateSettings({ backfillStartedAt: '2026-06-15T08:00:00Z' });
  initDataStore(file); // second boot
  assert.equal(getDb().prepare(`SELECT COUNT(*) FROM recipes WHERE source = 'starter'`).pluck().get(), n);
  assert.equal(getSettings().backfillError, 'interrupted');
});
