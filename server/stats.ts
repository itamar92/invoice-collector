import { getDb } from './db.js';
import { getSettings } from './settings.js';

export interface CategoryStat { category: string | null; count: number; total: number }
/** `parts`: the month's count split by category, so the chart can stack it. */
export interface MonthStat { month: number; count: number; total: number; parts: { category: string | null; count: number }[] }
export interface Stats {
  year: number;
  /** Years that have filed documents, newest first; always includes the requested year. */
  years: number[];
  currency: string;
  count: number;
  total: number;
  /** Filed documents in another currency: counted, but left out of every amount. */
  otherCurrency: number;
  categories: CategoryStat[];
  months: MonthStat[];
}

/** A document's date: its issue date when extracted, else when it arrived. */
const DATE = `COALESCE(json_extract(fields_json, '$.issueDate'), created_at)`;
/** Filed documents only: the PDF is in storage (and, for 'done', handed to accounting where that applies). */
const FILED = `state IN ('stored', 'done')`;
const round = (n: number) => Math.round(n * 100) / 100;

/** How many filed documents went to each category in a year, and how they spread over its months. */
export function stats(year: number): Stats {
  const db = getDb();
  const currency = getSettings().currency;
  const rows = db.prepare(`
    SELECT json_extract(fields_json, '$.category') AS category,
           COALESCE(json_extract(fields_json, '$.currency'), ?) AS currency,
           CAST(substr(${DATE}, 6, 2) AS INTEGER) AS month,
           COUNT(*) AS count,
           COALESCE(SUM(json_extract(fields_json, '$.total')), 0) AS total
    FROM items
    WHERE ${FILED} AND substr(${DATE}, 1, 4) = ?
    GROUP BY 1, 2, 3
  `).all(currency, String(year)) as { category: string | null; currency: string; month: number; count: number; total: number }[];

  const byCategory = new Map<string | null, CategoryStat>();
  const months: MonthStat[] = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, count: 0, total: 0, parts: [] }));
  let count = 0, total = 0, otherCurrency = 0;
  for (const r of rows) {
    const category = r.category?.trim() || null;
    const amount = r.currency === currency ? r.total : 0;
    if (r.currency !== currency) otherCurrency += r.count;
    const c = byCategory.get(category) ?? { category, count: 0, total: 0 };
    c.count += r.count; c.total += amount;
    byCategory.set(category, c);
    const m = months[r.month - 1];
    if (m) {
      m.count += r.count; m.total += amount;
      const part = m.parts.find((p) => p.category === category);
      if (part) part.count += r.count; else m.parts.push({ category, count: r.count });
    }
    count += r.count; total += amount;
  }

  const years = (db.prepare(`SELECT DISTINCT CAST(substr(${DATE}, 1, 4) AS INTEGER) FROM items WHERE ${FILED}`).pluck().all() as number[])
    .filter((y) => Number.isInteger(y) && y > 0);
  return {
    year,
    years: [...new Set([...years, year])].sort((a, b) => b - a),
    currency,
    count,
    total: round(total),
    otherCurrency,
    categories: [...byCategory.values()].map((c) => ({ ...c, total: round(c.total) }))
      .sort((a, b) => b.count - a.count || b.total - a.total || (a.category ?? '').localeCompare(b.category ?? '')),
    months: months.map((m) => ({ ...m, total: round(m.total) })),
  };
}
