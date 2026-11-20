import type { Category, MorningClassification } from './api.js';

/**
 * One category per Morning classification, named after it (so each gets its own Dropbox folder through
 * {category}) and already linked to it. Existing categories stay; one whose name matches a Morning title only
 * gains the link. Returns the merged list and how many were added.
 */
export function mergeMorningCategories(cats: Category[], items: MorningClassification[]): { cats: Category[]; added: number } {
  const titles = new Map<string, number>();
  for (const c of items) titles.set(c.title.trim(), (titles.get(c.title.trim()) ?? 0) + 1);
  const out = cats.map((c) => ({ ...c }));
  let added = 0;
  for (const c of items) {
    const title = c.title.trim();
    if (!title) continue;
    // Two Morning categories with the same title still need two folder names.
    const name = (titles.get(title) ?? 0) > 1 ? `${title} (${c.irsCode ?? c.code ?? c.id})` : title;
    const existing = out.find((x) => x.name.trim() === name);
    if (existing) { if (!existing.accountingClassification) existing.accountingClassification = c.id; continue; }
    if (out.some((x) => x.accountingClassification === c.id)) continue; // already linked under another name
    out.push({ name, sendToAccounting: true, accountingClassification: c.id });
    added++;
  }
  return { cats: out, added };
}
