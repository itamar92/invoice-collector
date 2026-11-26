import { createHash } from 'node:crypto';
import type { FolderEntry, StorageDestination } from '../core/types.js';
import { FolderNotFoundError, TransientError } from '../core/types.js';
import { getSecret } from '../secrets.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const CACHE_MS = 10 * 60 * 1000;

/** Full Drive access: the folder browser must see folders the user made, not only ones this app created. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

/** '/a//b/' → ['a', 'b']. Paths are '/'-separated names under My Drive, as with Dropbox. */
export function driveSegments(path: string): string[] {
  return path.split('/').map((s) => s.trim()).filter(Boolean);
}

/** '/' + segments joined: the human-readable path recorded on the item. */
const joinSegs = (segs: string[]) => '/' + segs.join('/');

/** A string literal inside a Drive `q` query: backslash and single quote escaped. */
export function driveQuote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export interface GoogleDriveOptions {
  fetchImpl?: typeof fetch;
  clientId?: string;
  clientSecret?: string;
  now?: () => number;
}

interface ApiResult { status: number; body: any; retryAfter: string | null }
interface DriveFile { id: string; name: string; mimeType?: string; md5Checksum?: string }

/**
 * Files PDFs under My Drive. Drive addresses everything by id, so the '/'-separated paths the pipeline uses are
 * resolved one name at a time (cached). Names are not unique in Drive: the oldest match wins, so repeated runs
 * keep landing in the same folder.
 */
export class GoogleDriveStorage implements StorageDestination {
  private readonly f: typeof fetch;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | null = null;
  /** Path ('/a/b') → folder id. '' is My Drive itself. */
  private readonly ids = new Map<string, string>([['', 'root']]);
  private idsAt = 0;

  constructor(opts: GoogleDriveOptions = {}) {
    this.f = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.clientId = opts.clientId ?? process.env.GOOGLE_CLIENT_ID;
    this.clientSecret = opts.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET;
    this.now = opts.now ?? Date.now;
  }

  async put(folder: string, filename: string, pdf: Buffer): Promise<{ path: string; existed: boolean }> {
    const segs = driveSegments(folder);
    const path = joinSegs([...segs, filename]);
    const parent = await this.folderId(segs, true);
    if (await this.findChild(parent!, filename, false)) return { path, existed: true };
    const boundary = `ic_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const meta = JSON.stringify({ name: filename, parents: [parent], mimeType: 'application/pdf' });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`
        + `--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`, 'utf8'),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    const r = await this.call((tok) => this.f(`${UPLOAD}?uploadType=multipart&fields=id,name`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    }));
    this.assertOk(r);
    return { path, existed: false };
  }

  async exists(folder: string, filename: string, pdf: Buffer): Promise<{ exists: boolean; sameContent: boolean }> {
    const parent = await this.folderId(driveSegments(folder), false);
    if (!parent) return { exists: false, sameContent: false };
    const f = await this.findChild(parent, filename, false);
    if (!f) return { exists: false, sameContent: false };
    return { exists: true, sameContent: f.md5Checksum === createHash('md5').update(pdf).digest('hex') };
  }

  /** Subfolders of `path` ('' or '/' = the top of My Drive), sorted by name. */
  async listFolders(path: string): Promise<FolderEntry[]> {
    const segs = driveSegments(path);
    const id = await this.folderId(segs, false);
    if (!id) throw new FolderNotFoundError(path);
    const out: FolderEntry[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const files = await this.list(`${driveQuote(id)} in parents and mimeType = '${FOLDER_MIME}' and trashed = false`, pageToken);
      for (const f of files.files) {
        const p = joinSegs([...segs, f.name]);
        if (!this.ids.has(p)) this.ids.set(p, f.id);
        out.push({ name: f.name, path: p });
      }
      if (!files.next) break;
      pageToken = files.next;
    }
    // Same-named folders show once: filing always goes to the oldest of them.
    const seen = new Set<string>();
    return out.filter((e) => (seen.has(e.path) ? false : (seen.add(e.path), true)))
      .sort((a, b) => a.name.localeCompare(b.name, 'he'));
  }

  /** Makes a folder now, so it can be browsed into and picked right away; an existing one is returned as it is. */
  async createFolder(parent: string, name: string): Promise<FolderEntry> {
    const segs = driveSegments(parent);
    const parentId = await this.folderId(segs, false);
    if (!parentId) throw new FolderNotFoundError(parent);
    const path = joinSegs([...segs, name]);
    const existing = await this.findChild(parentId, name, true);
    if (existing) { this.ids.set(path, existing.id); return { name, path }; }
    const made = await this.mkdir(parentId, name);
    this.ids.set(path, made.id);
    return { name: made.name || name, path };
  }

  /** Moves the filed document to the Drive trash (restorable from there for 30 days). */
  async remove(path: string): Promise<'removed' | 'not_found'> {
    const segs = driveSegments(path);
    const name = segs.pop();
    if (!name) return 'not_found';
    const parent = await this.folderId(segs, false);
    const f = parent ? await this.findChild(parent, name, false) : null;
    if (!f) return 'not_found';
    const r = await this.call((tok) => this.f(`${API}/files/${encodeURIComponent(f.id)}?fields=id`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    }));
    if (r.status === 404) return 'not_found';
    this.assertOk(r);
    return 'removed';
  }

  /** The id of the folder at `segs`; missing levels are made when `create`, else null. */
  private async folderId(segs: string[], create: boolean): Promise<string | null> {
    // Folders can be moved or trashed in Drive at any time: forget what was resolved every few minutes.
    if (this.now() - this.idsAt > CACHE_MS) { this.ids.clear(); this.ids.set('', 'root'); this.idsAt = this.now(); }
    let id = 'root';
    for (let i = 0; i < segs.length; i++) {
      const p = joinSegs(segs.slice(0, i + 1));
      const cached = this.ids.get(p);
      if (cached) { id = cached; continue; }
      const found = await this.findChild(id, segs[i], true);
      if (found) id = found.id;
      else if (create) id = (await this.mkdir(id, segs[i])).id;
      else return null;
      this.ids.set(p, id);
    }
    return id;
  }

  private async findChild(parentId: string, name: string, folder: boolean): Promise<DriveFile | null> {
    const kind = folder ? `mimeType = '${FOLDER_MIME}'` : `mimeType != '${FOLDER_MIME}'`;
    const r = await this.list(`${driveQuote(parentId)} in parents and name = ${driveQuote(name)} and ${kind} and trashed = false`);
    return r.files[0] ?? null;
  }

  private async mkdir(parentId: string, name: string): Promise<DriveFile> {
    const r = await this.call((tok) => this.f(`${API}/files?fields=id,name`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    }));
    if (r.status === 404) throw new FolderNotFoundError(name);
    this.assertOk(r);
    return { id: String(r.body.id), name: typeof r.body?.name === 'string' ? r.body.name : name };
  }

  private async list(q: string, pageToken?: string): Promise<{ files: DriveFile[]; next?: string }> {
    const u = new URL(`${API}/files`);
    u.search = new URLSearchParams({
      q, spaces: 'drive', orderBy: 'createdTime', pageSize: '1000',
      fields: 'nextPageToken, files(id, name, mimeType, md5Checksum)',
      ...(pageToken ? { pageToken } : {}),
    }).toString();
    const r = await this.call((tok) => this.f(u.toString(), { headers: { Authorization: `Bearer ${tok}` } }));
    this.assertOk(r);
    const files = Array.isArray(r.body?.files)
      ? (r.body.files as any[]).filter((f) => typeof f?.id === 'string' && typeof f?.name === 'string') as DriveFile[]
      : [];
    return { files, next: typeof r.body?.nextPageToken === 'string' ? r.body.nextPageToken : undefined };
  }

  private assertOk(r: ApiResult): void {
    if (r.status >= 200 && r.status < 300) return;
    const msg = `Google Drive ${r.status}: ${message(r.body) || 'error'}`;
    // Drive reports rate limits as 403 with a rate-limit reason as well as 429.
    if (r.status === 429 || r.status >= 500 || (r.status === 403 && /rateLimitExceeded/i.test(reasons(r.body)))) {
      throw new TransientError(r.retryAfter ? `${msg} (Retry-After ${r.retryAfter}s)` : msg);
    }
    throw new Error(msg);
  }

  /** Runs one API call with a valid access token; on 401 refreshes once and retries once. */
  private async call(run: (token: string) => Promise<Response>): Promise<ApiResult> {
    let r = await this.attempt(run, await this.accessToken());
    if (r.status === 401) {
      this.token = null;
      r = await this.attempt(run, await this.accessToken());
    }
    return r;
  }

  private async attempt(run: (token: string) => Promise<Response>, token: string): Promise<ApiResult> {
    let res: Response;
    try { res = await run(token); } catch (e) {
      throw new TransientError(`Google Drive network error: ${(e as Error).message}`);
    }
    return { status: res.status, body: await readBody(res), retryAfter: res.headers.get('retry-after') };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt - 60_000) return this.token.value;
    const refresh = getSecret('gdrive_refresh');
    if (!refresh) throw new Error('Google Drive is not connected');
    if (!this.clientId || !this.clientSecret) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set');
    let res: Response;
    try {
      res = await this.f('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token', refresh_token: refresh, client_id: this.clientId, client_secret: this.clientSecret,
        }).toString(),
      });
    } catch (e) { throw new TransientError(`Google Drive network error: ${(e as Error).message}`); }
    const body = await readBody(res);
    if (res.status === 429 || res.status >= 500) throw new TransientError(`Google token refresh ${res.status}`);
    if (res.status !== 200 || typeof body?.access_token !== 'string') {
      throw new Error(`Google token refresh failed (${res.status}): ${body?.error_description ?? body?.error ?? 'error'}`);
    }
    this.token = { value: body.access_token, expiresAt: this.now() + (Number(body.expires_in) || 3600) * 1000 };
    return this.token.value;
  }
}

async function readBody(res: Response): Promise<any> {
  const text = await res.text().catch(() => '');
  try { return text ? JSON.parse(text) : null; } catch { return { error: { message: text.slice(0, 200) } }; }
}
const message = (b: any): string => (typeof b?.error?.message === 'string' ? b.error.message : '');
const reasons = (b: any): string =>
  (Array.isArray(b?.error?.errors) ? b.error.errors.map((e: any) => String(e?.reason ?? '')).join(' ') : '');
