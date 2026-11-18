import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFields } from '../server/core/validate.js';
import { IL_DEFAULTS } from '../server/defaults/il.js';
import type { ExtractedFields } from '../server/core/types.js';
import type { Settings } from '../server/settings.js';

const s = structuredClone(IL_DEFAULTS) as unknown as Settings;
const TODAY = '2026-06-15';
const base: ExtractedFields = {
  vendorName: 'Acme', vendorTaxId: null, docType: 'tax_invoice', docNumber: null,
  issueDate: '2026-06-01', total: 118, vat: 18, net: 100, currency: null,
  allocationNumber: null, description: null, category: null,
};
const run = (o: Partial<ExtractedFields>) => validateFields({ ...base, ...o }, s, TODAY);
const problems = (o: Partial<ExtractedFields>) => {
  const r = run(o);
  return r.ok ? [] : r.problems;
};

test('consistent vat is ok', () => assert.deepEqual(run({}), { ok: true }));
test('vat mismatch with net', () => assert.deepEqual(problems({ vat: 17 }), ['vat_mismatch']));
test('zero vat ok', () => assert.deepEqual(run({ total: 100, vat: 0, net: null }), { ok: true }));
test('total+vat only: consistent and mismatch', () => {
  assert.deepEqual(run({ net: null }), { ok: true });
  assert.deepEqual(problems({ net: null, vat: 10 }), ['vat_mismatch']);
});
test('no vat skips vat check', () => assert.deepEqual(run({ vat: null, net: null }), { ok: true }));
test('future date', () => assert.deepEqual(problems({ issueDate: '2026-06-16' }), ['future_date']));
test('too old: before 1 Jan of previous year', () => {
  assert.deepEqual(problems({ issueDate: '2024-12-31' }), ['too_old']);
  assert.deepEqual(run({ issueDate: '2025-01-01' }), { ok: true });
});
test('missing and bad date', () => {
  assert.deepEqual(problems({ issueDate: null }), ['missing_date']);
  assert.deepEqual(problems({ issueDate: '2026-02-30' }), ['bad_date']);
  assert.deepEqual(problems({ issueDate: '01/02/2026' }), ['bad_date']);
});
test('missing total / nonpositive', () => {
  assert.deepEqual(problems({ total: null }), ['missing_total']);
  assert.ok(problems({ total: 0, vat: null, net: null }).includes('nonpositive_total'));
  assert.ok(problems({ total: -5, vat: null, net: null }).includes('nonpositive_total'));
});
test('credit note may be negative, compared by absolute value', () => {
  assert.deepEqual(run({ docType: 'credit_note', total: -118, vat: -18, net: -100 }), { ok: true });
  assert.deepEqual(problems({ docType: 'credit_note', total: -118, vat: -17, net: -100 }), ['vat_mismatch']);
});
test('missing vendor blank/null', () => {
  assert.deepEqual(problems({ vendorName: null }), ['missing_vendor']);
  assert.deepEqual(problems({ vendorName: '  ' }), ['missing_vendor']);
});
test('collects all problems', () => {
  assert.deepEqual(problems({ vendorName: null, issueDate: null, total: null }), [
    'missing_vendor', 'missing_date', 'missing_total',
  ]);
});

test('sum tolerance boundary at exactly 0.05 is accepted (float safe)', () => {
  assert.deepEqual(run({ net: 10.28, vat: 1.85, total: 12.18 }), { ok: true });
});
test('negative vat on non-credit doc is a mismatch (signed compare)', () => {
  assert.deepEqual(problems({ docType: 'tax_invoice', total: 118, vat: -18, net: 100 }), ['vat_mismatch']);
});
