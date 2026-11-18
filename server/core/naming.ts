import { DOC_TYPE_HE, type ExtractedFields } from './types.js';
import type { Settings } from '../settings.js';

const MAX_PART = 60;

/** Replace path-hostile chars with '-', collapse whitespace, trim, cap length. Keeps double quotes. */
export function sanitizePart(v: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = v.replace(/[\/\\:*?<>|\u0000-\u001f\u007f]/g, '-').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, MAX_PART).trim();
}

function formatAmount(n: number): string {
  return String(Number(n.toFixed(2)));
}

function substitute(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? values[k] : m));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isBad = (v: string) => v === '' || v === '.' || v === '..';

function filenameValues(f: ExtractedFields, s: Settings): Record<string, string> {
  const currency = f.currency === null || f.currency === s.currency ? s.currencyLabel : f.currency;
  // description may legitimately be empty (collapsed later); every other part falls back to '-'
  const part = (v: string | null, allowEmpty = false) => {
    const c = sanitizePart(v ?? '');
    return c === '' && allowEmpty ? '' : isBad(c) ? '-' : c;
  };
  return {
    date: part(f.issueDate),
    year: part(f.issueDate && DATE_RE.test(f.issueDate) ? f.issueDate.slice(0, 4) : f.issueDate),
    docType: part(DOC_TYPE_HE[f.docType ?? 'other']),
    vendor: part(f.vendorName),
    description: part(f.description, true),
    category: part(f.category),
    amount: part(f.total === null ? null : formatAmount(f.total)),
    currency: part(currency),
    root: part(s.storageRoot),
  };
}

export function buildFilename(f: ExtractedFields, s: Settings): string {
  const out = substitute(s.filenameTemplate, filenameValues(f, s)).replace(/_{2,}/g, '_');
  return `${out.replace(/_+$/, '')}.pdf`;
}

export function buildFolder(f: ExtractedFields, s: Settings): string {
  if (!f.issueDate || !DATE_RE.test(f.issueDate)) throw new Error('buildFolder: missing or malformed issueDate ({year})');
  if (!f.category) throw new Error('buildFolder: missing category');
  const raw: Record<string, string | null> = {
    date: f.issueDate,
    year: f.issueDate.slice(0, 4),
    category: f.category,
    docType: DOC_TYPE_HE[f.docType ?? 'other'],
    vendor: f.vendorName,
    description: f.description,
    amount: f.total === null ? null : formatAmount(f.total),
    currency: f.currency === null || f.currency === s.currency ? s.currencyLabel : f.currency,
  };
  const used = new Set([...s.folderTemplate.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
  const values: Record<string, string> = { root: s.storageRoot }; // configured path, not sanitized
  for (const k of used) {
    if (k === 'root' || !(k in raw)) continue;
    const c = sanitizePart(raw[k] ?? '');
    if (isBad(c)) throw new Error(`buildFolder: unusable ${k}`);
    values[k] = c;
  }
  const joined = substitute(s.folderTemplate, values).replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/+$/, '') : joined;
}
