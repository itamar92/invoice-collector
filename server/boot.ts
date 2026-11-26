import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { markInterruptedBackfill } from './core/backfill.js';
import { loadStarterRecipes } from './core/recipeStore.js';

/** Placeholder values shipped in .env.example: a server started with any of them is not configured. */
const EXAMPLE_VALUES: Record<string, string> = {
  APP_PASSWORD: 'change-me',
  SECRET_KEY: 'replace-with-64-hex-chars',
  API_TOKEN: 'replace-with-another-random-string',
};
const MIN_LENGTH = { APP_PASSWORD: 12, SECRET_KEY: 32, API_TOKEN: 32 } as const;

/**
 * What is wrong with the credentials in `env` (empty = fine). Messages name the variable, never its value.
 * A short APP_PASSWORD is tolerated only outside production, or in demo mode (DEMO=1) on a data folder whose
 * name contains "demo" (npm run demo); the Docker image (production, DATA_DIR=/data) never qualifies.
 */
export function envProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  const demo = env.DEMO === '1' && path.basename(path.resolve(env.DATA_DIR || './data')).includes('demo');
  const lenient = env.NODE_ENV !== 'production' || demo;
  for (const name of ['SECRET_KEY', 'APP_PASSWORD', 'API_TOKEN'] as const) {
    const v = env[name];
    if (v === undefined || v === '') {
      if (name === 'SECRET_KEY') problems.push('SECRET_KEY is not set (see .env.example)');
      continue; // APP_PASSWORD / API_TOKEN unset: that login path is closed
    }
    if (v === EXAMPLE_VALUES[name]) problems.push(`${name} is still the .env.example placeholder; set a real value`);
    else if (v.length < MIN_LENGTH[name] && !(name === 'APP_PASSWORD' && lenient)) {
      problems.push(`${name} is too short (at least ${MIN_LENGTH[name]} characters)`);
    }
  }
  return problems;
}

const STARTER_RECIPES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'recipes', 'il');

/** Brings the current database (a tenant's, or the default one) up to date for this boot. Safe on every start. */
export function prepareTenantDb(recipesDir = STARTER_RECIPES): void {
  loadStarterRecipes(recipesDir); // new vendors, and fixes to untouched starters: never replaces a learned or edited one
  markInterruptedBackfill(); // a backfill job lives in memory: one running before this boot was cut short
}

/** Opens the default database and brings it up to date (scripts and tests; the server uses tenant databases). */
export function initDataStore(dbFile: string, recipesDir = STARTER_RECIPES): void {
  openDb(dbFile);
  prepareTenantDb(recipesDir);
}
