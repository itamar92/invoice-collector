import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, parseDate, parseDocType, hebrewMonthName, unmirrorAmount } from '../server/core/parse.js';

test('parseAmount handles separators, currency markers and signs', () => {
  assert.equal(parseAmount('1,234.50'), 1234.5);
  assert.equal(parseAmount('₪ 59.90'), 59.9);
  assert.equal(parseAmount('59.90-'), -59.9);
  assert.equal(parseAmount('59.90 ₪'), 59.9);
  assert.equal(parseAmount('-59.90'), -59.9);
  assert.equal(parseAmount('59.90 ש"ח'), 59.9);
  assert.equal(parseAmount('ש"ח 1,000'), 1000);
  assert.equal(parseAmount('59.90 NIS'), 59.9);
  assert.equal(parseAmount('NIS 12'), 12);
  assert.equal(parseAmount('1 234.50'), 1234.5);
});

test('parseAmount reads a trailing comma with 1-2 digits as a decimal comma', () => {
  assert.equal(parseAmount('59,90'), 59.9);
  assert.equal(parseAmount('1.234,50'), 1234.5);
  assert.equal(parseAmount('₪ 12,5'), 12.5);
  assert.equal(parseAmount('-59,90'), -59.9);
});

test('parseAmount treats other commas as thousands separators', () => {
  assert.equal(parseAmount('1,234.50'), 1234.5);
  assert.equal(parseAmount('1,200'), 1200);
  assert.equal(parseAmount('12,345,678'), 12345678);
});

test('parseAmount rounds to 2 decimals and rejects empty or non-numeric input', () => {
  assert.equal(parseAmount('10.456'), 10.46);
  assert.equal(parseAmount('0.1 + 0.2'), null);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('   '), null);
  assert.equal(parseAmount('₪'), null);
});

test('parseDate accepts the supported formats and returns YYYY-MM-DD', () => {
  assert.equal(parseDate('05/03/2026', 'DD/MM/YYYY'), '2026-03-05');
  assert.equal(parseDate('05/03/26', 'DD/MM/YY'), '2026-03-05');
  assert.equal(parseDate('05.03.2026', 'DD.MM.YYYY'), '2026-03-05');
  assert.equal(parseDate('05-03-2026', 'DD-MM-YYYY'), '2026-03-05');
  assert.equal(parseDate('2026-03-05', 'YYYY-MM-DD'), '2026-03-05');
});

test('parseDate rejects impossible dates instead of rolling over', () => {
  assert.equal(parseDate('31/02/2026', 'DD/MM/YYYY'), null);
  assert.equal(parseDate('29/02/2026', 'DD/MM/YYYY'), null);
  assert.equal(parseDate('29/02/2028', 'DD/MM/YYYY'), '2028-02-29');
  assert.equal(parseDate('32/01/2026', 'DD/MM/YYYY'), null);
  assert.equal(parseDate('05/13/2026', 'DD/MM/YYYY'), null);
  assert.equal(parseDate('not a date', 'DD/MM/YYYY'), null);
});

test('parseDocType matches combined forms before single forms', () => {
  assert.equal(parseDocType('חשבונית מס / קבלה'), 'tax_invoice_receipt');
  assert.equal(parseDocType('חשבונית מס-קבלה'), 'tax_invoice_receipt');
  assert.equal(parseDocType('Tax Invoice / Receipt'), 'tax_invoice_receipt');
  assert.equal(parseDocType('קבלה'), 'receipt');
  assert.equal(parseDocType('Receipt'), 'receipt');
  assert.equal(parseDocType('Tax Invoice'), 'tax_invoice');
  assert.equal(parseDocType('חשבונית מס'), 'tax_invoice');
  assert.equal(parseDocType('חשבונית זיכוי'), 'credit_note');
  assert.equal(parseDocType('Credit Note'), 'credit_note');
  assert.equal(parseDocType('some unrelated text'), null);
});

test('hebrewMonthName returns the Hebrew month for 1..12', () => {
  assert.equal(hebrewMonthName(1), 'ינואר');
  assert.equal(hebrewMonthName(12), 'דצמבר');
  assert.throws(() => hebrewMonthName(13));
});

test('parseAmount ignores bidi and zero-width marks around the number and sign', () => {
  assert.equal(parseAmount('‏59.90'), 59.9);
  assert.equal(parseAmount('59.90-‏'), -59.9);
  assert.equal(parseAmount('‫₪59.90‬'), 59.9);
  assert.equal(parseAmount('⁦₪ 59.90⁩'), 59.9);
  assert.equal(parseAmount('‎59.90​'), 59.9);
  assert.equal(parseAmount('﻿59.90'), 59.9);
  assert.equal(parseAmount('‭-59.90‬'), -59.9);
});

test('parseAmount maps U+2212 and U+05BE to a minus sign', () => {
  assert.equal(parseAmount('−59.90'), -59.9);
  assert.equal(parseAmount('59.90־'), -59.9);
  assert.equal(parseAmount('59.90−'), -59.9);
});

test('parseAmount accepts the Hebrew gershayim currency marker ש״ח (U+05F4)', () => {
  assert.equal(parseAmount('59.90 ש״ח'), 59.9);
  assert.equal(parseAmount('ש״ח 1,000'), 1000);
  assert.equal(parseAmount('ש״ח-59.90'), -59.9);
});

test('parseAmount treats a non-breaking space as a plain space', () => {
  assert.equal(parseAmount('59.90 ₪'), 59.9);
  assert.equal(parseAmount('ש"ח 1,000'), 1000);
  assert.equal(parseAmount('1 234.50'), 1234.5);
  assert.equal(parseAmount(' '), null);
});

test('parseDate ignores bidi marks and non-breaking spaces', () => {
  assert.equal(parseDate('‏05/03/2026', 'DD/MM/YYYY'), '2026-03-05');
  assert.equal(parseDate('05/03/2026‎', 'DD/MM/YYYY'), '2026-03-05');
  assert.equal(parseDate('‭05.03.2026‬', 'DD.MM.YYYY'), '2026-03-05');
  assert.equal(parseDate('05/03/2026 ', 'DD/MM/YYYY'), '2026-03-05');
});

test('parseDocType ignores bidi marks and matches a non-breaking space', () => {
  assert.equal(parseDocType('חשבונית‏ מס'), 'tax_invoice');
  assert.equal(parseDocType('חשבונית מס‎ / קבלה'), 'tax_invoice_receipt');
  assert.equal(parseDocType('חשבונית מס'), 'tax_invoice');
});

test('parseDocType: "חשבונית מס זיכוי" and "חשבונית מס/זיכוי" are credit notes, not tax invoices', () => {
  assert.equal(parseDocType('חשבונית מס זיכוי'), 'credit_note');
  assert.equal(parseDocType('חשבונית מס/זיכוי'), 'credit_note');
  assert.equal(parseDocType('חשבונית מס - זיכוי'), 'credit_note');
  assert.equal(parseDocType('חשבונית מס'), 'tax_invoice');
});

test('unmirrorAmount swaps the halves of a right-to-left amount', () => {
  assert.equal(parseAmount(unmirrorAmount('99 . 88')), 88.99);
  assert.equal(parseAmount(unmirrorAmount('90 . 1,049')), 1049.9);
  assert.equal(parseAmount(unmirrorAmount('01 . -10')), -10.01);
  assert.equal(parseAmount(unmirrorAmount('99.88 ₪')), 88.99);
  assert.equal(unmirrorAmount('79'), '79'); // no point: left as it is
});
