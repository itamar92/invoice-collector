import type { ExtractedFields } from './types.js';
import type { Settings } from '../settings.js';

export type Problem =
  | 'missing_date'
  | 'missing_total'
  | 'bad_date'
  | 'future_date'
  | 'too_old'
  | 'nonpositive_total'
  | 'vat_mismatch'
  | 'missing_vendor';

function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const cents = (x: number) => Math.round(x * 100);

function vatConsistent(f: ExtractedFields, vatRate: number): boolean {
  if (f.total === null || f.vat === null) return true;
  const sign = (x: number) => (f.docType === 'credit_note' ? Math.abs(x) : x);
  const total = cents(sign(f.total));
  const vat = cents(sign(f.vat));
  const EPS = 1e-9;
  const tol = Math.max(5, Math.abs(total) * 0.005) + EPS;
  if (f.net !== null) {
    const net = cents(sign(f.net));
    if (Math.abs(net + vat - total) > 5) return false;
    return vat === 0 || Math.abs((net * vatRate) / 100 - vat) <= tol;
  }
  return vat === 0 || Math.abs((total * vatRate) / (100 + vatRate) - vat) <= tol;
}

export function validateFields(
  f: ExtractedFields,
  s: Settings,
  today: string,
): { ok: true } | { ok: false; problems: Problem[] } {
  const problems: Problem[] = [];

  if (f.vendorName === null || f.vendorName.trim() === '') problems.push('missing_vendor');

  if (f.issueDate === null) problems.push('missing_date');
  else if (!isRealDate(f.issueDate)) problems.push('bad_date');
  else {
    if (f.issueDate > today) problems.push('future_date');
    const taxYear = Number(today.slice(0, 4));
    if (f.issueDate < `${taxYear - 1}-01-01`) problems.push('too_old');
  }

  if (f.total === null) problems.push('missing_total');
  else {
    if (f.docType !== 'credit_note' && f.total <= 0) problems.push('nonpositive_total');
    if (!vatConsistent(f, s.vatRate)) problems.push('vat_mismatch');
  }

  return problems.length ? { ok: false, problems } : { ok: true };
}
