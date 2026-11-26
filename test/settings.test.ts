import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, openDb, migrate, MIGRATIONS } from '../server/db.js';
import { IL_DEFAULTS } from '../server/defaults/il.js';
import { getSettings, updateSettings } from '../server/settings.js';

test('defaults come from IL_DEFAULTS until changed', () => {
  openDb(':memory:');
  assert.equal(getSettings().vatRate, 18);
  assert.equal(getSettings().categories.length, 33);
  assert.ok(getSettings().categories.every(c => c.sendToAccounting));
  updateSettings({ vatRate: 17 });
  assert.equal(getSettings().vatRate, 17);
  assert.equal(getSettings().currency, 'ILS');
});

test('settings persist per database and IL_DEFAULTS is never mutated', () => {
  openDb(':memory:');
  updateSettings({ gmailLabels: ['invoices'] });
  assert.deepEqual(getSettings().gmailLabels, ['invoices']);
  const cats = getSettings().categories.map(c => c.name === 'רכב - דלק' ? { ...c, sendToAccounting: false } : c);
  updateSettings({ categories: cats });
  assert.equal(getSettings().categories.find(c => c.name === 'רכב - דלק')!.sendToAccounting, false);
  assert.equal(IL_DEFAULTS.categories.find(c => c.name === 'רכב - דלק')!.sendToAccounting, true);
  // mutating a returned object must not leak into the defaults either
  getSettings().categories[0].name = 'x';
  assert.notEqual(IL_DEFAULTS.categories[0].name, 'x');
  openDb(':memory:');
  assert.deepEqual(getSettings().gmailLabels, []);
});

test('a single label stored the old way (gmailLabel) is read as a one-item list, and saving drops it', () => {
  openDb(':memory:');
  getDb().prepare("INSERT INTO settings (key, value) VALUES ('gmailLabel', ?)").run(JSON.stringify('n8n/Recipts'));
  assert.deepEqual(getSettings().gmailLabels, ['n8n/Recipts']);
  updateSettings({ gmailLabels: ['n8n/Recipts', 'קבלות - Recipts'] });
  assert.deepEqual(getSettings().gmailLabels, ['n8n/Recipts', 'קבלות - Recipts']);
  assert.equal(getDb().prepare("SELECT COUNT(*) FROM settings WHERE key = 'gmailLabel'").pluck().get(), 0);
  openDb(':memory:');
  getDb().prepare("INSERT INTO settings (key, value) VALUES ('gmailLabel', 'null')").run();
  assert.deepEqual(getSettings().gmailLabels, []);
});

test('migrate is idempotent: re-running on the same database changes nothing', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO settings (key, value) VALUES ('vatRate', '17')").run();
  const before = db.prepare('SELECT * FROM schema_version').all();
  migrate(db);
  migrate(db);
  assert.deepEqual(db.prepare('SELECT * FROM schema_version').all(), before);
  assert.equal(before.length, MIGRATIONS.length);
  assert.equal(getSettings().vatRate, 17);
});

test('migrate applies only migrations newer than the recorded version', () => {
  const db = openDb(':memory:');
  const extra = [...MIGRATIONS, { version: MIGRATIONS.length + 1, sql: 'CREATE TABLE t (id INTEGER)' }];
  migrate(db, extra);
  migrate(db, extra);
  assert.equal(db.prepare('SELECT max(version) FROM schema_version').pluck().get(), MIGRATIONS.length + 1);
  assert.equal(db.prepare("SELECT count(*) FROM sqlite_master WHERE name='t'").pluck().get(), 1);
});
