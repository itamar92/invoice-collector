import { ensureOwner, openAccounts } from '../server/accounts.js';
import { setTenantHooks } from '../server/auth.js';

/** Login of the owner account freshAccounts() creates. */
export const TEST_EMAIL = 'owner@test';

/**
 * A new in-memory accounts database with one owner account (TEST_EMAIL + APP_PASSWORD) and no tenant hooks,
 * so every request runs on the default database the test opened with openDb().
 */
export function freshAccounts(): void {
  openAccounts(':memory:');
  setTenantHooks(null);
  ensureOwner({ ADMIN_EMAIL: TEST_EMAIL, APP_PASSWORD: process.env.APP_PASSWORD }, null);
}
