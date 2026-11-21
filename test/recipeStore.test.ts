import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, getDb } from '../server/db.js';
import { compileRecipe, isFreeMailSender, RecipeError, type Recipe } from '../server/core/recipe.js';
import {
  findRecipe, saveRecipe, recipeHistory, getVendor, upsertVendor, setVendorStatus,
  setVendorCategory, listVendors, loadStarterRecipes,
} from '../server/core/recipeStore.js';

function recipe(over: Partial<Recipe> = {}): Recipe {
  return compileRecipe({
    schemaVersion: 1,
    vendorKey: 'demo-cell',
    displayName: 'סלולר דמו',
    match: { senders: ['billing@demo-cell.co.il'] },
    fields: { total: { kind: 'regex', pattern: 'סה"כ:\\s*([\\d.]+)', parse: 'amount' } },
    ...over,
  });
}

test('saving v2 deactivates v1; findRecipe returns v2; history lists both', () => {
  openDb(':memory:');
  saveRecipe(recipe(), 'starter');
  const id2 = saveRecipe(recipe({ description: 'v2' }), 'user');
  assert.equal(typeof id2, 'number');
  assert.equal(findRecipe('billing@demo-cell.co.il', '')?.description, 'v2');
  const h = recipeHistory('demo-cell');
  assert.deepEqual(h.map(x => [x.version, x.source]), [[2, 'user'], [1, 'starter']]);
  assert.equal(h[1]!.recipe.vendorKey, 'demo-cell');
});

test('invalid recipe throws and leaves the previous version active', () => {
  openDb(':memory:');
  saveRecipe(recipe(), 'starter');
  const bad = { ...recipe(), fields: { total: { kind: 'regex', pattern: '(', parse: 'amount' } } } as unknown as Recipe;
  assert.throws(() => saveRecipe(bad, 'ai'), RecipeError);
  assert.equal(recipeHistory('demo-cell').length, 1);
  assert.ok(findRecipe('billing@demo-cell.co.il', ''));
});

test('sender match beats marker-only match; ties go to the newest', () => {
  openDb(':memory:');
  saveRecipe(recipe({ vendorKey: 'by-marker', displayName: 'm', match: { textMarkers: ['חשבונית'] } }), 'user');
  saveRecipe(recipe({ vendorKey: 'by-sender', displayName: 's', match: { senders: ['a@x.com'] } }), 'user');
  assert.equal(findRecipe('a@x.com', 'חשבונית')?.vendorKey, 'by-sender');
  assert.equal(findRecipe('b@x.com', 'חשבונית')?.vendorKey, 'by-marker');
  saveRecipe(recipe({ vendorKey: 'by-marker2', displayName: 'm2', match: { textMarkers: ['חשבונית'] } }), 'user');
  assert.equal(findRecipe('b@x.com', 'חשבונית')?.vendorKey, 'by-marker2');
  assert.equal(findRecipe('b@x.com', 'אחר'), null);
});

test('inactive recipes are not matched', () => {
  openDb(':memory:');
  saveRecipe(recipe(), 'user');
  saveRecipe(recipe({ match: { senders: ['new@demo-cell.co.il'] } }), 'user');
  assert.equal(findRecipe('billing@demo-cell.co.il', ''), null);
  assert.ok(findRecipe('new@demo-cell.co.il', ''));
});

test('vendors: new is unreviewed, status never downgraded, sorted list, category', () => {
  openDb(':memory:');
  upsertVendor('b-vendor', 'ב');
  upsertVendor('a-vendor', 'א');
  assert.equal(getVendor('a-vendor')?.status, 'unreviewed');
  setVendorStatus('a-vendor', 'business');
  upsertVendor('a-vendor', 'א חדש');
  assert.equal(getVendor('a-vendor')?.status, 'business');
  assert.equal(getVendor('a-vendor')?.displayName, 'א חדש');
  setVendorCategory('a-vendor', 'רכב - דלק');
  assert.equal(getVendor('a-vendor')?.defaultCategory, 'רכב - דלק');
  assert.equal(getVendor('nope'), null);
  assert.deepEqual(listVendors().map(v => v.key), ['a-vendor', 'b-vendor']);
});

test('saveRecipe creates the vendor as unreviewed', () => {
  openDb(':memory:');
  saveRecipe(recipe(), 'ai');
  assert.equal(getVendor('demo-cell')?.status, 'unreviewed');
});

test('loadStarterRecipes is idempotent, sorted, applies sidecar categories, reports the broken file', () => {
  openDb(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'recipes-'));
  writeFileSync(join(dir, 'b.json'), JSON.stringify(recipe({ vendorKey: 'vendor-b', displayName: 'B' })));
  writeFileSync(join(dir, 'a.json'), JSON.stringify(recipe({ vendorKey: 'vendor-a', displayName: 'A' })));
  writeFileSync(join(dir, 'vendors.json'), JSON.stringify({ 'vendor-a': { displayName: 'A', defaultCategory: 'רכב - דלק' } }));
  assert.equal(loadStarterRecipes(dir), 2);
  assert.equal(loadStarterRecipes(dir), 0);
  assert.equal(recipeHistory('vendor-a').length, 1);
  assert.equal(getVendor('vendor-a')?.defaultCategory, 'רכב - דלק');
  assert.equal(getVendor('vendor-b')?.defaultCategory, null);
  assert.equal(getVendor('vendor-a')?.status, 'unreviewed');
  writeFileSync(join(dir, 'c.json'), '{"schemaVersion":1}');
  assert.throws(() => loadStarterRecipes(dir), /c\.json/);
});

test('findRecipe skips (and logs without content) an active row that no longer compiles', (t) => {
  openDb(':memory:');
  saveRecipe(recipe(), 'starter');
  getDb().prepare(`INSERT INTO recipes (vendor_key, version, json, source, created_at, active)
                   VALUES ('broken-v', 1, ?, 'ai', '2026-01-01', 1)`)
    .run(JSON.stringify({ ...recipe({ vendorKey: 'broken-v' }), fields: { total: { kind: 'regex', pattern: '(', parse: 'amount' } } }));
  getDb().prepare(`INSERT INTO recipes (vendor_key, version, json, source, created_at, active)
                   VALUES ('garbled-v', 1, 'not json SECRETISH', 'ai', '2026-01-01', 1)`).run();
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(findRecipe('billing@demo-cell.co.il', '')?.vendorKey, 'demo-cell');
  assert.equal(warn.mock.callCount(), 2);
  const logged = warn.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
  assert.match(logged, /broken-v/);
  assert.doesNotMatch(logged, /SECRETISH|pattern/);
});

test('AI recipes may not claim other vendors: wildcard / free-mail senders and generic or short markers are refused', () => {
  openDb(':memory:');
  const bad: Recipe['match'][] = [
    { senders: ['*@demo-cell.co.il'] },
    { senders: ['someone@gmail.com'] },
    { senders: ['billing@demo-cell.co.il'], textMarkers: ['חשבונית מס'] },
    { textMarkers: ['קבלה', 'סלולר דמו בע"מ'] },
    { textMarkers: ['Invoice'] },
    { textMarkers: ['אב'] },
  ];
  for (const match of bad) {
    assert.throws(() => saveRecipe(recipe({ match }), 'ai'), RecipeError, JSON.stringify(match));
  }
  assert.equal(recipeHistory('demo-cell').length, 0);
  // Specific ones are fine, and starter/user recipes keep their wildcard senders.
  saveRecipe(recipe({ match: { senders: ['billing@demo-cell.co.il'], textMarkers: ['סלולר דמו בע"מ'] } }), 'ai');
  saveRecipe(recipe({ match: { senders: ['*@demo-cell.co.il'] } }), 'user');
  // A rewrite that keeps the vendor's existing (proven) match may carry its wildcard.
  saveRecipe(recipe({ match: { senders: ['*@demo-cell.co.il'] }, description: 'ai rewrite' }), 'ai');
  assert.equal(recipeHistory('demo-cell').length, 3);
  assert.ok(isFreeMailSender('x@walla.co.il') && isFreeMailSender('x@gmail.com') && !isFreeMailSender('x@demo-cell.co.il'));
});
