import { getDb } from '../db.js';
import { NOT_INVOICE_QUERY } from '../sources/gmail.js';
import { UPLOAD_PREFIX } from './items.js';
import { FREE_MAIL_DOMAINS } from './recipeStore.js';

/**
 * A Gmail filter suggested from what the app already read: a few subject words that cover most real invoices,
 * then the sender domains of the invoices those words miss. One short rule instead of a line per vendor address.
 */
export interface FilterSuggestion {
  /** Paste into Gmail's "Has the words" (or search box, then "Create filter"). Empty when nothing was read yet. */
  query: string;
  subjects: { term: string; emails: number }[];
  senders: { sender: string; emails: number }[];
  /** Emails that held a real expense, and how many of them the query catches (all, by construction). */
  invoices: number;
  /** Emails that held nothing worth keeping (quotes, ignored vendors, own copies) that the query would still catch. */
  noise: number;
}

/** Subject words worth trying, most specific first. Hebrew and English, as Israeli vendors write them. */
const SUBJECT_TERMS = [
  'חשבונית מס', 'חשבונית', 'קבלה', 'חשבון', 'אישור תשלום', 'תשלום', 'invoice', 'receipt', 'bill', 'payment',
];
/** A word is used only if it covers at least this many invoices not yet covered... */
const MIN_NEW = 2;
/** ...and at least this share of the emails it catches are real invoices. */
const MIN_PRECISION = 0.75;

const SECOND_LEVEL = new Set(['co', 'org', 'net', 'ac', 'gov', 'muni', 'k12', 'com']);

/** `billing@mail.partner.net.il` -> `partner.net.il`; free-mail senders stay whole addresses. */
export function senderKey(sender: string): string {
  const addr = sender.trim().toLowerCase();
  const domain = addr.split('@')[1] ?? '';
  if (!domain || FREE_MAIL_DOMAINS.has(domain)) return addr;
  const parts = domain.split('.');
  const n = parts.length >= 3 && parts.at(-1)!.length === 2 && SECOND_LEVEL.has(parts.at(-2)!) ? 3 : 2;
  return parts.slice(-n).join('.');
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole words, as Gmail's subject: matches them (it does not find חשבונית inside החשבונית). */
const has = (subject: string, term: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${esc(term)}(?![\\p{L}\\p{N}])`, 'iu').test(subject);
const term = (s: string) => (s.includes(' ') ? `"${s}"` : s);

export function suggestFilter(): FilterSuggestion {
  const rows = getDb().prepare(
    `SELECT e.message_id AS id, e.sender AS sender, e.subject AS subject,
       MAX(CASE WHEN i.state != 'ignored' AND i.fields_json IS NOT NULL
                 AND (v.status IS NULL OR v.status != 'ignored') THEN 1 ELSE 0 END) AS good
     FROM emails e JOIN items i ON i.message_id = e.message_id LEFT JOIN vendors v ON v.key = i.vendor_key
     WHERE e.message_id NOT LIKE ? GROUP BY e.message_id`).all(`${UPLOAD_PREFIX}%`) as
    { id: string; sender: string | null; subject: string | null; good: number }[];
  const good = rows.filter((r) => r.good === 1);
  const bad = rows.filter((r) => r.good !== 1);
  if (good.length === 0) return { query: '', subjects: [], senders: [], invoices: 0, noise: 0 };

  const covered = new Set<string>();
  const subjects: FilterSuggestion['subjects'] = [];
  for (;;) {
    let best: { t: string; fresh: number; all: number } | null = null;
    for (const t of SUBJECT_TERMS) {
      if (subjects.some((s) => has(t, s.term))) continue; // "חשבונית" already covers "חשבונית מס"
      const hits = good.filter((r) => has(r.subject ?? '', t));
      const fresh = hits.filter((r) => !covered.has(r.id)).length;
      const noise = bad.filter((r) => has(r.subject ?? '', t)).length;
      if (fresh < MIN_NEW || hits.length / (hits.length + noise) < MIN_PRECISION) continue;
      if (!best || fresh > best.fresh) best = { t, fresh, all: hits.length };
    }
    if (!best) break;
    subjects.push({ term: best.t, emails: best.all });
    for (const r of good) if (has(r.subject ?? '', best.t)) covered.add(r.id);
  }
  // A broader word picked later makes a narrower one redundant ("חשבונית" after "חשבונית מס").
  const kept = subjects.filter((s) => !subjects.some((o) => o !== s && has(s.term, o.term)));

  const bySender = new Map<string, number>();
  for (const r of good) {
    if (covered.has(r.id) || !r.sender) continue;
    const k = senderKey(r.sender);
    bySender.set(k, (bySender.get(k) ?? 0) + 1);
  }
  const senders = [...bySender.entries()].map(([sender, emails]) => ({ sender, emails }))
    .sort((a, b) => b.emails - a.emails || a.sender.localeCompare(b.sender));

  const ors: string[] = [];
  if (kept.length) ors.push(`subject:(${kept.map((s) => term(s.term)).join(' OR ')})`);
  if (senders.length) ors.push(`from:(${senders.map((s) => s.sender).join(' OR ')})`);
  const query = `${ors.length > 1 ? `{${ors.join(' ')}}` : ors[0]} ${NOT_INVOICE_QUERY}`;

  const keys = new Set(senders.map((s) => s.sender));
  const noise = bad.filter((r) => kept.some((s) => has(r.subject ?? '', s.term)) || (r.sender && keys.has(senderKey(r.sender)))).length;
  return { query, subjects: kept, senders, invoices: good.length, noise };
}
