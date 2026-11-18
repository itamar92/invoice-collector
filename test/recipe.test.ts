import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RecipeSchema, compileRecipe, matchesRecipe, runRecipe, RecipeError } from '../server/core/recipe.js';

const text = readFileSync(new URL('./fixtures/synthetic-phone-bill.txt', import.meta.url), 'utf8');

const valid = {
  schemaVersion: 1,
  vendorKey: 'demo-cell',
  displayName: 'סלולר דמו',
  match: { senders: ['*@demo-cell.co.il'], textMarkers: ['סלולר דמו', 'חשבונית מס'] },
  fields: {
    vendorName: { kind: 'const', value: 'סלולר דמו בע"מ' },
    docType: { kind: 'regex', pattern: '(חשבונית מס)', parse: 'docType' },
    docNumber: { kind: 'regex', pattern: 'מספר חשבונית:\\s*(\\d+)', parse: 'text' },
    issueDate: { kind: 'regex', pattern: 'תאריך:\\s*([\\d/]+)', parse: 'date', dateFormat: 'DD/MM/YYYY' },
    total: { kind: 'regex', pattern: 'סה"כ לתשלום:\\s*([\\d.,]+)', parse: 'amount' },
    vat: { kind: 'regex', pattern: 'nomatch(\\d+)', parse: 'amount' },
  },
  description: 'חשבון טלפון חודש {issueMonth-1}',
};

test('runRecipe extracts fields', () => {
  const f = runRecipe(compileRecipe(valid), text);
  assert.equal(f.issueDate, '2026-04-10');
  assert.equal(f.total, 59.9);
  assert.equal(f.docType, 'tax_invoice');
  assert.equal(f.docNumber, '7770001');
  assert.equal(f.vendorName, 'סלולר דמו בע"מ');
  assert.equal(f.vat, null);
  assert.equal(f.net, null);
  assert.equal(f.description, 'חשבון טלפון חודש מרץ');
});

test('description: January wraps to December, field rule wins, null date', () => {
  const jan = compileRecipe({ ...valid, fields: { issueDate: valid.fields.issueDate } });
  assert.equal(runRecipe(jan, 'תאריך: 05/01/2026').description, 'חשבון טלפון חודש דצמבר');
  const withRule = compileRecipe({
    ...valid,
    fields: { ...valid.fields, description: { kind: 'const', value: 'ידני' } },
  });
  assert.equal(runRecipe(withRule, text).description, 'ידני');
  assert.equal(runRecipe(jan, 'nothing').description, null);
});

test('description template placeholders issueYear and docNumber', () => {
  const r = compileRecipe({ ...valid, description: '{docNumber}/{issueYear}/{issueMonth}' });
  assert.equal(runRecipe(r, text).description, '7770001/2026/אפריל');
});

test('matchesRecipe', () => {
  const r = compileRecipe(valid);
  assert.equal(matchesRecipe(r, 'billing@demo-cell.co.il', text), true);
  assert.equal(matchesRecipe(r, 'Billing@DEMO-CELL.co.il', text), true);
  assert.equal(matchesRecipe(r, 'x@sub.demo-cell.co.il', text), false);
  assert.equal(matchesRecipe(r, 'billing@demo-cell.co.il', text.replace('חשבונית מס', 'x')), false);
});

test('RE2 is linear on catastrophic patterns', () => {
  const r = compileRecipe({ ...valid, fields: { total: { kind: 'regex', pattern: '(a+)+$', parse: 'amount' } } });
  const t0 = Date.now();
  runRecipe(r, 'a'.repeat(50_000) + 'b');
  assert.ok(Date.now() - t0 < 200);
});

test('compileRecipe rejects bad recipes', () => {
  const bad = (patch: object) => assert.throws(() => compileRecipe({ ...valid, ...patch }), RecipeError);
  bad({ fields: { total: { kind: 'eval', value: 'x' } } });
  bad({ fields: { total: { kind: 'regex', pattern: '(?<=a)b', parse: 'amount' } } });
  bad({ vendorKey: '../x' });
  bad({ fields: { total: { kind: 'regex', pattern: 'a'.repeat(301), parse: 'amount' } } });
  bad({ description: 'x {bogus}' });
  bad({ fields: { total: { kind: 'const', value: '5' } } });
  bad({ fields: { docType: { kind: 'const', value: 'nope' } } });
  bad({ fields: { issueDate: { kind: 'regex', pattern: '(\\d+)', parse: 'date' } } });
  bad({ match: { textMarkers: Array(11).fill('x') } });
});

test('docType const rejects inherited object keys', () => {
  for (const value of ['toString', 'constructor', '__proto__']) {
    assert.throws(() => compileRecipe({ ...valid, fields: { docType: { kind: 'const', value } } }), RecipeError);
  }
  const ok = compileRecipe({ ...valid, fields: { docType: { kind: 'const', value: 'receipt' } } });
  assert.equal(runRecipe(ok, text).docType, 'receipt');
});

test('RecipeSchema itself rejects RE2-invalid patterns', () => {
  const r = { ...valid, fields: { total: { kind: 'regex', pattern: '(?<=a)b', parse: 'amount' } } };
  assert.equal(RecipeSchema.safeParse(r).success, false);
  assert.equal(RecipeSchema.safeParse(valid).success, true);
});

test('match must have at least one sender or marker', () => {
  for (const match of [{}, { senders: [], textMarkers: [] }, { senders: [] }]) {
    assert.throws(() => compileRecipe({ ...valid, match }), RecipeError);
    assert.equal(RecipeSchema.safeParse({ ...valid, match }).success, false);
  }
});
