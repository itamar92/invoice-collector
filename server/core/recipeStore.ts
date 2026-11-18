import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../db.js';
import { compileRecipe, matchesRecipe, RecipeError, senderMatches, unsafeAiMatch, type Recipe } from './recipe.js';

export type VendorStatus = 'business' | 'personal' | 'ignored' | 'unreviewed';
export type RecipeSource = 'starter' | 'ai' | 'user';

export interface Vendor {
  key: string;
  displayName: string;
  status: VendorStatus;
  defaultCategory: string | null;
  createdAt: string;
}

interface VendorRow {
  key: string;
  display_name: string;
  status: VendorStatus;
  default_category: string | null;
  created_at: string;
}

const toVendor = (r: VendorRow): Vendor => ({
  key: r.key, displayName: r.display_name, status: r.status,
  defaultCategory: r.default_category, createdAt: r.created_at,
});

export function getVendor(key: string): Vendor | null {
  const row = getDb().prepare('SELECT * FROM vendors WHERE key = ?').get(key) as VendorRow | undefined;
  return row ? toVendor(row) : null;
}

/** Creates the vendor as `unreviewed`, or refreshes the display name. Never changes an existing status. */
export function upsertVendor(key: string, displayName: string): void {
  getDb().prepare(
    `INSERT INTO vendors (key, display_name, status, created_at) VALUES (?, ?, 'unreviewed', ?)
     ON CONFLICT(key) DO UPDATE SET display_name = excluded.display_name`,
  ).run(key, displayName, new Date().toISOString());
}

export function setVendorStatus(key: string, status: VendorStatus): void {
  getDb().prepare('UPDATE vendors SET status = ? WHERE key = ?').run(status, key);
}

export function setVendorCategory(key: string, category: string | null): void {
  getDb().prepare('UPDATE vendors SET default_category = ? WHERE key = ?').run(category, key);
}

export function listVendors(): Vendor[] {
  const rows = getDb().prepare('SELECT * FROM vendors ORDER BY display_name, key').all() as VendorRow[];
  return rows.map(toVendor);
}

/**
 * Active recipe for an email: a sender-pattern match beats a text-marker-only match; ties go to the newest.
 * A stored row that no longer compiles is skipped and logged by id/vendor only (never its content), so one bad
 * recipe cannot stop every document from being matched.
 */
export function findRecipe(sender: string, text: string): Recipe | null {
  const rows = getDb().prepare('SELECT id, vendor_key, json FROM recipes WHERE active = 1 ORDER BY id DESC')
    .all() as { id: number; vendor_key: string; json: string }[];
  let markerOnly: Recipe | null = null;
  for (const row of rows) {
    let r: Recipe;
    try {
      r = compileRecipe(JSON.parse(row.json));
    } catch {
      console.warn(`recipe ${row.id} (vendor ${row.vendor_key}) does not compile; skipped`);
      continue;
    }
    if (!matchesRecipe(r, sender, text)) continue;
    if (senderMatches(r, sender)) return r;
    markerOnly ??= r;
  }
  return markerOnly;
}

/** The vendor's active recipe, if any. */
export function getActiveRecipe(vendorKey: string): Recipe | null {
  const json = getDb().prepare('SELECT json FROM recipes WHERE vendor_key = ? AND active = 1 ORDER BY id DESC LIMIT 1')
    .pluck().get(vendorKey) as string | undefined;
  return json ? compileRecipe(JSON.parse(json)) : null;
}

/** Validates, deactivates the vendor's previous version and stores the new one. Returns the new row id. */
export function saveRecipe(r: Recipe, source: RecipeSource): number {
  const recipe = compileRecipe(r);
  if (source === 'ai') {
    // An AI recipe must not be able to claim other vendors' documents (what the vendor already had stays allowed).
    let current: Recipe | null = null;
    try { current = getActiveRecipe(recipe.vendorKey); } catch { current = null; }
    const problems = unsafeAiMatch(recipe.match, current?.match);
    if (problems.length) throw new RecipeError(`unsafe match: ${problems.join('; ')}`);
  }
  const db = getDb();
  return db.transaction(() => {
    upsertVendor(recipe.vendorKey, recipe.displayName);
    const last = db.prepare('SELECT COALESCE(MAX(version), 0) FROM recipes WHERE vendor_key = ?').pluck().get(recipe.vendorKey) as number;
    db.prepare('UPDATE recipes SET active = 0 WHERE vendor_key = ?').run(recipe.vendorKey);
    const info = db.prepare(
      'INSERT INTO recipes (vendor_key, version, json, source, created_at, active) VALUES (?, ?, ?, ?, ?, 1)',
    ).run(recipe.vendorKey, last + 1, JSON.stringify(recipe), source, new Date().toISOString());
    return Number(info.lastInsertRowid);
  })();
}

export function recipeHistory(vendorKey: string): { version: number; source: string; createdAt: string; recipe: Recipe }[] {
  const rows = getDb().prepare(
    'SELECT version, source, created_at, json FROM recipes WHERE vendor_key = ? ORDER BY version DESC',
  ).all(vendorKey) as { version: number; source: string; created_at: string; json: string }[];
  return rows.map(r => ({ version: r.version, source: r.source, createdAt: r.created_at, recipe: compileRecipe(JSON.parse(r.json)) }));
}

/**
 * Inserts every starter recipe in `dir` (*.json, sorted by name) whose vendor has no recipe yet.
 * Optional `vendors.json` in the same folder maps vendorKey -> { displayName, defaultCategory }.
 * A recipe that fails validation throws with its file name: starter recipes are shipped code.
 * Returns the number inserted.
 */
export function loadStarterRecipes(dir = 'recipes/il'): number {
  const sidecarFile = join(dir, 'vendors.json');
  const sidecar: Record<string, { displayName?: string; defaultCategory?: string }> =
    existsSync(sidecarFile) ? JSON.parse(readFileSync(sidecarFile, 'utf8')) : {};
  const files = readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'vendors.json').sort();
  const has = getDb().prepare('SELECT 1 FROM recipes WHERE vendor_key = ? LIMIT 1');
  let inserted = 0;
  for (const file of files) {
    let recipe: Recipe;
    try {
      recipe = compileRecipe(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    } catch (e) {
      throw new Error(`starter recipe ${file}: ${(e as Error).message}`);
    }
    if (has.get(recipe.vendorKey)) continue;
    saveRecipe(recipe, 'starter');
    const category = sidecar[recipe.vendorKey]?.defaultCategory;
    if (category) setVendorCategory(recipe.vendorKey, category);
    inserted++;
  }
  return inserted;
}
