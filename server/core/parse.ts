import type { DocType } from './types.js';

export type DateFormat = 'DD/MM/YYYY' | 'DD.MM.YYYY' | 'DD/MM/YY' | 'YYYY-MM-DD' | 'DD-MM-YYYY';

const CURRENCY_MARKERS = /₪|ש"ח|ש״ח|NIS/gi;
const INVISIBLE_MARKS = /[​‎‏‪-‮⁦-⁩﻿]/g;

/** Strips bidi/zero-width marks and maps typographic minus signs to '-'. Shared by all parsers. */
export function normalize(raw: string): string {
  return raw.replace(INVISIBLE_MARKS, '').replace(/[−־]/g, '-');
}

/**
 * Parses a money string into a number rounded to 2 decimals.
 * A comma is a decimal separator when it is followed by exactly 1-2 digits at the
 * end ("59,90" -> 59.9, "1.234,50" -> 1234.5); otherwise commas are thousands
 * separators ("1,234.50", "12,345,678"). A currency marker may appear anywhere and
 * a sign may be leading ("-59.90") or trailing ("59.90-").
 * Returns null for empty or non-numeric input.
 */
export function parseAmount(raw: string): number | null {
  let s = normalize(raw).replace(CURRENCY_MARKERS, '').trim();
  const negative = s.startsWith('-') || s.endsWith('-');
  s = s.replace(/^-|-$/g, '').trim();
  if (/,\d{1,2}$/.test(s)) {
    s = s.replace(/[.\s]/g, '').replace(/,(\d{1,2})$/, '.$1');
  } else {
    s = s.replace(/[\s,]/g, '');
  }
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const magnitude = Math.round(Number(s) * 100) / 100;
  return negative ? -magnitude : magnitude;
}

/**
 * Undoes a right-to-left PDF text layer that wrote an amount's two halves in reverse order: "99 . 88" is 88.99,
 * "01 . -10" is -10.01. The halves around the decimal point swap; input with no point is left as it is.
 */
export function unmirrorAmount(raw: string): string {
  const m = /^\s*(\S+?)\s*\.\s*(\S+?)\s*$/.exec(normalize(raw).replace(CURRENCY_MARKERS, ''));
  return m ? `${m[2]}.${m[1]}` : raw;
}

const DATE_PATTERNS: Record<DateFormat, { re: RegExp; order: 'dmy' | 'ymd'; yearDigits: 2 | 4 }> = {
  'DD/MM/YYYY': { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, order: 'dmy', yearDigits: 4 },
  'DD.MM.YYYY': { re: /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, order: 'dmy', yearDigits: 4 },
  'DD-MM-YYYY': { re: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, order: 'dmy', yearDigits: 4 },
  'DD/MM/YY': { re: /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, order: 'dmy', yearDigits: 2 },
  'YYYY-MM-DD': { re: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, order: 'ymd', yearDigits: 4 },
};

/**
 * Parses a date in the given format into YYYY-MM-DD.
 * Impossible dates (e.g. 31/02) return null: the parsed parts are round-tripped
 * through Date.UTC and must come back unchanged, so JS month rollover is never accepted.
 * Two-digit years map to 20YY.
 */
export function parseDate(raw: string, format: DateFormat): string | null {
  const { re, order, yearDigits } = DATE_PATTERNS[format];
  const m = re.exec(normalize(raw).trim());
  if (!m) return null;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [year, month, day] = order === 'dmy' ? [c, b, a] : [a, b, c];
  const fullYear = yearDigits === 2 ? 2000 + year : year;
  const probe = new Date(Date.UTC(fullYear, month - 1, day));
  if (
    probe.getUTCFullYear() !== fullYear ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(fullYear).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Maps Hebrew or English document-type wording to a DocType.
 * Combined "tax invoice + receipt" forms are checked before the single forms.
 */
export function parseDocType(raw: string): DocType | null {
  const text = normalize(raw).trim();
  if (/חשבונית\s*מס\s*[/\-&]?\s*קבלה|tax\s*invoice\s*[/\-&]?\s*receipt/i.test(text)) return 'tax_invoice_receipt';
  if (/חשבונית\s*(מס\s*[/\-]?\s*)?זיכוי|credit\s*note/i.test(text)) return 'credit_note';
  if (/חשבונית\s*מס|tax\s*invoice/i.test(text)) return 'tax_invoice';
  if (/קבלה|receipt/i.test(text)) return 'receipt';
  return null;
}

const HEBREW_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

export function hebrewMonthName(month1to12: number): string {
  const name = HEBREW_MONTHS[month1to12 - 1];
  if (month1to12 < 1 || month1to12 > 12 || name === undefined) {
    throw new RangeError(`month must be 1..12, got ${month1to12}`);
  }
  return name;
}
