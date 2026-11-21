import { createHash } from 'node:crypto';
import type { FolderEntry, StorageDestination } from '../core/types.js';
import { FolderConflictError, FolderNotFoundError, TransientError } from '../core/types.js';
import { getSecret } from '../secrets.js';

const BLOCK = 4 * 1024 * 1024;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();

/** Dropbox content_hash: sha256 of the concatenated sha256 of each 4 MB block, hex. */
export function dropboxContentHash(buf: Buffer): string {
  const hashes: Buffer[] = [];
  for (let i = 0; i < buf.length; i += BLOCK) hashes.push(sha256(buf.subarray(i, i + BLOCK)));
  return sha256(Buffer.concat(hashes)).toString('hex');
}

/** '/' + folder + '/' + filename with duplicate slashes collapsed. */
export function toDropboxPath(folder: string, filename: string): string {
  return ('/' + folder + '/' + filename).replace(/\/{2,}/g, '/');
}

/** Dropbox-API-Arg must be ASCII: escape every non-ASCII UTF-16 unit as \uXXXX. */
function asciiJson(v: unknown): string {
  return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

export interface DropboxOptions {
  fetchImpl?: typeof fetch;
  appKey?: string;
  now?: () => number;
}

interface ApiResult { status: number; body: any; retryAfter: string | null }

export class DropboxStorage implements StorageDestination {
  private readonly f: typeof fetch;
  private readonly appKey: string | undefined;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(opts: DropboxOptions = {}) {
    this.f = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.appKey = opts.appKey ?? process.env.DROPBOX_APP_KEY;
    this.now = opts.now ?? Date.now;
  }

  async put(folder: string, filename: string, pdf: Buffer): Promise<{ path: string; existed: boolean }> {
    const path = toDropboxPath(folder, filename);
    const arg = asciiJson({ path, mode: 'add', autorename: false, strict_conflict: true, mute: true });
    const r = await this.call((tok) => this.f('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Dropbox-API-Arg': arg, 'Content-Type': 'application/octet-stream' },
      body: pdf,
    }));
    if (r.status === 409 && /path\/conflict|conflict/.test(summary(r.body))) return { path, existed: true };
    this.assertOk(r);
    return { path: typeof r.body?.path_display === 'string' ? r.body.path_display : path, existed: false };
  }

  async exists(folder: string, filename: string, pdf: Buffer): Promise<{ exists: boolean; sameContent: boolean }> {
    const path = toDropboxPath(folder, filename);
    const r = await this.call((tok) => this.f('https://api.dropboxapi.com/2/files/get_metadata', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }));
    if (r.status === 409 && summary(r.body).includes('not_found')) return { exists: false, sameContent: false };
    this.assertOk(r);
    return { exists: true, sameContent: r.body?.content_hash === dropboxContentHash(pdf) };
  }

  /** Subfolders of `path` ('' or '/' = the top of the Dropbox, or of the app folder), sorted by name. */
  async listFolders(path: string): Promise<FolderEntry[]> {
    const p = path.replace(/\/{2,}/g, '/').replace(/\/$/, '');
    const req = (url: string, body: unknown) => this.call((tok) => this.f(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    let r = await req('https://api.dropboxapi.com/2/files/list_folder',
      { path: p === '' ? '' : p.startsWith('/') ? p : `/${p}`, recursive: false, include_deleted: false, limit: 2000 });
    if (r.status === 409 && /not_found|not_folder/.test(summary(r.body))) throw new FolderNotFoundError(path);
    const out: FolderEntry[] = [];
    for (let page = 0; ; page++) {
      this.assertOk(r);
      for (const e of r.body?.entries ?? []) {
        if (e?.['.tag'] === 'folder' && typeof e.name === 'string' && typeof e.path_display === 'string') {
          out.push({ name: e.name, path: e.path_display });
        }
      }
      if (!r.body?.has_more || page >= 20) break; // 20 pages × 2000 is far beyond any real folder
      r = await req('https://api.dropboxapi.com/2/files/list_folder/continue', { cursor: r.body.cursor });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'he'));
  }

  /** Makes a folder now (not on the first filing), so it can be browsed into and picked right away. */
  async createFolder(parent: string, name: string): Promise<FolderEntry> {
    const p = ('/' + parent + '/' + name).replace(/\/{2,}/g, '/').replace(/\/$/, '');
    const r = await this.call((tok) => this.f('https://api.dropboxapi.com/2/files/create_folder_v2', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p, autorename: false }),
    }));
    const s = summary(r.body);
    if (r.status === 409 && /path\/conflict\/folder/.test(s)) return { name, path: p }; // already there: fine
    if (r.status === 409 && /path\/conflict/.test(s)) throw new FolderConflictError(p);
    if (r.status === 409 && /path\/not_found|path\/malformed/.test(s)) throw new FolderNotFoundError(parent);
    this.assertOk(r);
    const md = r.body?.metadata;
    return { name: typeof md?.name === 'string' ? md.name : name, path: typeof md?.path_display === 'string' ? md.path_display : p };
  }

  private assertOk(r: ApiResult): void {
    if (r.status >= 200 && r.status < 300) return;
    const msg = `Dropbox ${r.status}: ${summary(r.body) || 'error'}`;
    if (r.status === 429 || r.status >= 500) {
      throw new TransientError(r.retryAfter ? `${msg} (Retry-After ${r.retryAfter}s)` : msg);
    }
    throw new Error(msg);
  }

  /** Runs one API call with a valid access token; on expired_access_token refreshes once and retries once. */
  private async call(run: (token: string) => Promise<Response>): Promise<ApiResult> {
    let r = await this.attempt(run, await this.accessToken());
    if (r.status === 401 && summary(r.body).startsWith('expired_access_token')) {
      this.token = null;
      r = await this.attempt(run, await this.accessToken());
    }
    return r;
  }

  private async attempt(run: (token: string) => Promise<Response>, token: string): Promise<ApiResult> {
    let res: Response;
    try { res = await run(token); } catch (e) {
      throw new TransientError(`Dropbox network error: ${(e as Error).message}`);
    }
    return { status: res.status, body: await readBody(res), retryAfter: res.headers.get('retry-after') };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt - 60_000) return this.token.value;
    const refresh = getSecret('dropbox_refresh');
    if (!refresh) throw new Error('Dropbox is not connected');
    if (!this.appKey) throw new Error('DROPBOX_APP_KEY is not set');
    let res: Response;
    try {
      res = await this.f('https://api.dropbox.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: this.appKey }).toString(),
      });
    } catch (e) { throw new TransientError(`Dropbox network error: ${(e as Error).message}`); }
    const body = await readBody(res);
    if (res.status === 429 || res.status >= 500) throw new TransientError(`Dropbox token refresh ${res.status}`);
    if (res.status !== 200 || typeof body?.access_token !== 'string') {
      throw new Error(`Dropbox token refresh failed (${res.status}): ${body?.error_description ?? body?.error ?? 'error'}`);
    }
    this.token = { value: body.access_token, expiresAt: this.now() + (Number(body.expires_in) || 14400) * 1000 };
    return this.token.value;
  }
}

async function readBody(res: Response): Promise<any> {
  const text = await res.text().catch(() => '');
  try { return JSON.parse(text); } catch { return { error_summary: text.slice(0, 200) }; }
}
const summary = (b: any): string => (typeof b?.error_summary === 'string' ? b.error_summary : '');
