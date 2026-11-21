import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeMorningCategories, replaceWithMorningCategories } from '../src/morningCategories.js';
import type { MorningClassification } from '../src/api.js';

const c = (id: string, title: string, irsCode: number | null = null): MorningClassification =>
  ({ id, title, key: null, code: null, irsCode, type: null, income: null, vat: null });

test('each Morning category becomes a linked category; existing ones stay; same-name ones gain the link', () => {
  const r = mergeMorningCategories(
    [{ name: 'תקשורת', sendToAccounting: false }, { name: 'שלי', sendToAccounting: true }],
    [c('1', 'תקשורת'), c('2', 'דלק', 101), c('3', 'משרד')],
  );
  assert.equal(r.added, 2);
  assert.deepEqual(r.cats, [
    { name: 'תקשורת', sendToAccounting: false, accountingClassification: '1' },
    { name: 'שלי', sendToAccounting: true },
    { name: 'דלק', sendToAccounting: true, accountingClassification: '2' },
    { name: 'משרד', sendToAccounting: true, accountingClassification: '3' },
  ]);
  // Running it again adds nothing.
  assert.equal(mergeMorningCategories(r.cats, [c('1', 'תקשורת'), c('2', 'דלק', 101), c('3', 'משרד')]).added, 0);
});

test('duplicate Morning titles get distinct names; an already-linked classification is not added twice', () => {
  const r = mergeMorningCategories([{ name: 'רכב', sendToAccounting: true, accountingClassification: '9' }],
    [c('7', 'הוצאות', 10), c('8', 'הוצאות', 20), c('9', 'רכב ותחבורה')]);
  assert.deepEqual(r.cats.map((x) => x.name), ['רכב', 'הוצאות (10)', 'הוצאות (20)']);
  assert.equal(r.added, 2);
});

test('replace: only Morning categories remain, each linked; a matching one keeps its send choice', () => {
  const r = replaceWithMorningCategories(
    [{ name: 'תקשורת', sendToAccounting: false }, { name: 'שלי', sendToAccounting: true }, { name: 'רכב', sendToAccounting: false, accountingClassification: '3' }],
    [c('1', 'תקשורת'), c('2', 'דלק', 101), c('3', 'רכב ותחבורה')],
  );
  assert.deepEqual(r.cats, [
    { name: 'תקשורת', sendToAccounting: false, accountingClassification: '1' },
    { name: 'דלק', sendToAccounting: true, accountingClassification: '2' },
    { name: 'רכב ותחבורה', sendToAccounting: false, accountingClassification: '3' },
  ]);
  assert.equal(r.removed, 2);
});
