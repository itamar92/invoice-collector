import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFilename, buildFolder } from '../server/core/naming.js';
import { IL_DEFAULTS } from '../server/defaults/il.js';
import type { ExtractedFields } from '../server/core/types.js';
import type { Settings } from '../server/settings.js';

const s = { ...(structuredClone(IL_DEFAULTS) as unknown as Settings),
  storageRoot: '/Business/חשבוניות - קבלות' };
const f: ExtractedFields = {
  vendorName: 'אקו"ם', vendorTaxId: null, docType: 'tax_invoice_receipt', docNumber: null,
  issueDate: '2026-02-01', total: 1200, vat: null, net: null, currency: null,
  allocationNumber: null, description: 'דמי חבר 1/2026', category: 'שירותי הנהלת חשבונות',
};

test('filename spec example', () => {
  assert.equal(buildFilename(f, s), '2026-02-01_חשבונית מס קבלה_אקו"ם_דמי חבר 1-2026_1200_שח.pdf');
});
test('folder spec example', () => {
  assert.equal(buildFolder(f, s), '/Business/חשבוניות - קבלות/2026/שירותי הנהלת חשבונות');
});
test('amount formatting', () => {
  assert.match(buildFilename({ ...f, total: 59.9 }, s), /_59\.9_/);
  assert.match(buildFilename({ ...f, total: 59.5 + 0.4 }, s), /_59\.9_/);
  assert.match(buildFilename({ ...f, total: -118 }, s), /_-118_/);
});
test('foreign currency kept, own currency labelled', () => {
  assert.match(buildFilename({ ...f, currency: 'USD' }, s), /_USD\.pdf$/);
  assert.match(buildFilename({ ...f, currency: 'ILS' }, s), /_שח\.pdf$/);
});
test('null description collapses double underscore; null docType uses other', () => {
  const n = buildFilename({ ...f, description: null, docType: null }, s);
  assert.equal(n, '2026-02-01_מסמך_אקו"ם_1200_שח.pdf');
});
test('sanitizes hostile chars, collapses whitespace, caps at 60', () => {
  const n = buildFilename({ ...f, vendorName: 'a:b*c?\n  d' + 'x'.repeat(100) }, s);
  const vendor = n.split('_')[2];
  assert.equal(vendor.length, 60);
  assert.ok(vendor.startsWith('a-b-c-- d'));
});
test('folder sanitizes category and throws without required values', () => {
  assert.ok(buildFolder({ ...f, category: 'a/b' }, s).endsWith('/2026/a-b'));
  assert.throws(() => buildFolder({ ...f, category: null }, s));
  assert.throws(() => buildFolder({ ...f, issueDate: null }, s));
});
test('folder: no double or trailing slash', () => {
  assert.equal(buildFolder(f, { ...s, storageRoot: '/r/' }), '/r/2026/שירותי הנהלת חשבונות');
});

test('category ., .., blank are rejected', () => {
  for (const c of ['..', '.', '   ']) assert.throws(() => buildFolder({ ...f, category: c }, s), c);
});
test('issueDate must be YYYY-MM-DD for folder', () => {
  assert.throws(() => buildFolder({ ...f, issueDate: '../../x' }, s));
});
test('filename parts . and .. become -', () => {
  assert.match(buildFilename({ ...f, vendorName: '..' }, s), /_-_/);
  assert.doesNotMatch(buildFilename({ ...f, vendorName: '..' }, s), /\.\./);
});
test('year/category/root substituted in filename template', () => {
  const t = { ...s, filenameTemplate: '{year}_{category}_{root}_{amount}' };
  assert.equal(buildFilename(f, t), '2026_שירותי הנהלת חשבונות_-Business-חשבוניות - קבלות_1200.pdf');
});

test('folder: used placeholders are strict (description, amount)', () => {
  const t = { ...s, folderTemplate: '{root}/{year}/{description}' };
  assert.throws(() => buildFolder({ ...f, description: '..' }, t));
  assert.throws(() => buildFolder({ ...f, description: null }, t));
  const a = { ...s, folderTemplate: '{root}/{year}/{amount}' };
  assert.throws(() => buildFolder({ ...f, total: null }, a));
  assert.ok(buildFolder(f, a).endsWith('/2026/1200'));
});
test('folder: unused placeholders are not validated', () => {
  assert.doesNotThrow(() => buildFolder({ ...f, vendorName: null, docType: null, currency: null }, s));
});
