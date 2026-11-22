import type { Db } from '../db.js';
import { currentTenantId } from '../db.js';
import { compileRecipe, matchesRecipe, senderMatches, unsafeAiMatch, type Recipe } from './recipe.js';

/**
 * The recipe library shared by every user of the server (accounts.db). A recipe one user's AI wrote (or one a
 * user fixed by hand) is published here, so another user's first document from that vendor is read without AI.
 * Off (every call a no-op) until the server installs the library; tests install their own.
 */
let lib: Db | null = null;
export function useSharedRecipes(db: Db | null): void { lib = db; }

/**
 * What another user may receive: no category (category names are each user's own), and only a match that
 * cannot claim other vendors' documents (no free-mail or wildcard senders, no generic markers).
 * Null when the recipe should not be shared at all: an aiAlways recipe saves no tokens.
 */
export function shareable(r: Recipe): Recipe | null {
  if (r.aiAlways) return null;
  if (unsafeAiMatch(r.match).length > 0) return null;
  const { category: _drop, ...fields } = r.fields;
  void _drop;
  if (Object.keys(fields).length === 0) return null;
  try { return compileRecipe({ ...r, fields }); } catch { return null; }
}

/** Publishes (or replaces) the vendor's shared recipe. Never throws: sharing must not break a user's save. */
export function publishShared(r: Recipe, source: 'ai' | 'user'): void {
  if (!lib) return;
  const share = shareable(r);
  if (!share) return;
  try {
    lib.prepare(
      `INSERT INTO shared_recipes (vendor_key, display_name, json, source, contributed_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(vendor_key) DO UPDATE SET display_name = excluded.display_name, json = excluded.json,
         source = excluded.source, contributed_by = excluded.contributed_by, updated_at = excluded.updated_at`,
    ).run(share.vendorKey, share.displayName, JSON.stringify(share), source, currentTenantId(), new Date().toISOString());
  } catch (e) {
    console.warn(`shared recipe for ${share.vendorKey} not published:`, e instanceof Error ? e.message : 'error');
  }
}

/** Same rule as a user's own recipes: a sender match beats a marker-only match. */
export function findShared(sender: string, text: string): Recipe | null {
  if (!lib) return null;
  const rows = lib.prepare('SELECT vendor_key, json FROM shared_recipes ORDER BY updated_at DESC').all() as { vendor_key: string; json: string }[];
  let markerOnly: Recipe | null = null;
  for (const row of rows) {
    let r: Recipe;
    try { r = compileRecipe(JSON.parse(row.json)); } catch { continue; }
    if (!matchesRecipe(r, sender, text)) continue;
    if (senderMatches(r, sender)) return r;
    markerOnly ??= r;
  }
  return markerOnly;
}

export function noteAdopted(vendorKey: string): void {
  try { lib?.prepare('UPDATE shared_recipes SET adopted = adopted + 1 WHERE vendor_key = ?').run(vendorKey); } catch { /* count only */ }
}

/** For the owner's view: how many vendors are in the library and how often they saved an AI call. */
export function sharedStats(): { recipes: number; adopted: number } {
  if (!lib) return { recipes: 0, adopted: 0 };
  const r = lib.prepare('SELECT COUNT(*) AS recipes, COALESCE(SUM(adopted), 0) AS adopted FROM shared_recipes').get() as { recipes: number; adopted: number };
  return r;
}
