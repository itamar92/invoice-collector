import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { compileRecipe, matchesRecipe, runRecipe } from '../server/core/recipe.js';
import { IL_DEFAULTS } from '../server/defaults/il.js';

const dir = new URL('../recipes/il/', import.meta.url);
const files = readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'vendors.json').sort();
const sidecar = JSON.parse(readFileSync(new URL('vendors.json', dir), 'utf8')) as
  Record<string, { displayName: string; defaultCategory?: string }>;
const FREE_MAIL = /(^|[.@])(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|walla|icloud|me|aol|proton|protonmail|zoho|gmx|mail)\.[a-z.]+$/i;
// Exact totals for the synthetic fixtures (thousands separators and decimals on purpose).
const EXPECTED_TOTAL: Record<string, number> = {
  'tzmigei-shabtai': 1150.5, 'bug-holland': 1349.9, carrefour: 1087.3, 'arnona-hod-hasharon': 1234.5,
  'eni-mobile': 1210.5, kvish6: 1064.8, partner: 1049.9,
};
const categories = new Set(IL_DEFAULTS.categories.map(c => c.name));

test('there are starter recipes', () => {
  assert.ok(files.length >= 15);
});

for (const file of files) {
  const raw = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
  test(`starter recipe ${file}`, () => {
    const r = compileRecipe(raw);
    assert.equal(`${r.vendorKey}.json`, file);
    const side = sidecar[r.vendorKey];
    assert.ok(side, 'vendor listed in vendors.json');
    assert.equal(side.displayName, r.displayName);
    if (side.defaultCategory !== undefined) assert.ok(categories.has(side.defaultCategory), `unknown category ${side.defaultCategory}`);
    if (r.aiAlways) {
      assert.deepEqual(r.fields, {});
      return;
    }
    const fixture = new URL(`../test/fixtures/il/${r.vendorKey}.txt`, import.meta.url);
    assert.ok(existsSync(fixture), `missing fixture for ${r.vendorKey}`);
    const text = readFileSync(fixture, 'utf8');
    const sender = r.match.senders?.[0]?.replace('*@', 'billing@') ?? 'unknown@example.com';
    assert.ok(matchesRecipe(r, sender, text), 'recipe matches its own fixture');
    const f = runRecipe(r, text);
    assert.ok(f.issueDate, 'issueDate');
    assert.ok(f.total !== null && f.total > 0, 'total');
    const expected = EXPECTED_TOTAL[r.vendorKey];
    if (expected !== undefined) assert.equal(f.total, expected);
  });
}

test('vendors.json has no entries without a recipe', () => {
  const keys = new Set(files.map(f => f.replace(/\.json$/, '')));
  for (const k of Object.keys(sidecar)) assert.ok(keys.has(k), `${k} has no recipe file`);
});

test('no starter recipe sender is on a free-mail domain', () => {
  for (const file of files) {
    const r = compileRecipe(JSON.parse(readFileSync(new URL(file, dir), 'utf8')));
    for (const sender of r.match.senders ?? []) assert.ok(!FREE_MAIL.test(sender), `${file}: free-mail sender ${sender}`);
  }
  assert.ok(FREE_MAIL.test('someone@gmail.com'));
  assert.ok(!FREE_MAIL.test('no-reply@10ten.co.il'));
});

test('akum matches its own name in any quote style, not a word that merely starts with אקו', async () => {
  const { compileRecipe: c, matchesRecipe: m } = await import('../server/core/recipe.js');
  const r = c(JSON.parse(readFileSync(new URL('akum.json', dir), 'utf8')));
  const line = 'תאריך אסמכתא: 10/01/2026';
  assert.equal(m(r, 'x@example.com', `מוצרים אקולוגיים בע"מ\n${line}`), false);
  assert.equal(m(r, 'x@example.com', `אקו"ם בע"מ\n${line}`), true);
  assert.equal(m(r, 'x@example.com', `אקו״ם בע״מ\n${line}`), true);
});
