import type { Deps } from '../core/types.js';
import { MAX_UPLOAD_BYTES, UploadError, createUpload } from './upload.js';

/** What can be dropped in: the same kinds of file the upload button takes. */
const ACCEPTED = /\.(pdf|jpe?g|png)$/i;

/** Files that could not be taken in (unreadable, too large), keyed by path+size: reported once, not every tick. */
const refused = new Set<string>();

export interface InboxResult { taken: number; duplicates: number; errors: string[] }

/**
 * The drop-in inbox: PDFs and photos the owner puts by hand directly in the storage root (not in a year folder),
 * for invoices that have to be downloaded from a supplier's website. Each file becomes a queued item exactly like
 * an upload (the worker then files it under the folder template, so it ends up in the right year and category
 * folder) and the original is deleted from the root. The deletion is the recoverable kind (Dropbox keeps it 30 days),
 * and the PDF itself stays in the app either way.
 */
export async function collectInbox(deps: Deps): Promise<InboxResult> {
  const out: InboxResult = { taken: 0, duplicates: 0, errors: [] };
  const s = deps.settings;
  const store = deps.storage;
  if (!s.storageInbox || s.storageProvider !== 'dropbox' || !store.listFiles || !store.download || !store.remove) return out;
  // Filing straight into the root would make every filed document look like a new drop: refuse that template.
  if (s.folderTemplate.replaceAll('{root}', '').replace(/[\s/]/g, '') === '') {
    out.errors.push('storage inbox: the folder template files into the root folder itself, so the inbox is off');
    return out;
  }
  const files = await store.listFiles(s.storageRoot);
  for (const f of files) {
    if (f.name.startsWith('.') || f.name.startsWith('~') || !ACCEPTED.test(f.name)) continue;
    const key = `${f.path}|${f.size}`;
    if (refused.has(key)) continue;
    if (f.size > MAX_UPLOAD_BYTES) {
      refused.add(key);
      out.errors.push(`storage inbox: ${f.name} is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB and was left in place`);
      continue;
    }
    try {
      const data = await store.download(f.path);
      const r = createUpload('dropbox', f.name, data, deps.now());
      if (r.duplicateOf) out.duplicates++; else out.taken++;
    } catch (e) {
      if (e instanceof UploadError) {
        refused.add(key);
        out.errors.push(`storage inbox: ${f.name} could not be read (${e.code}) and was left in place`);
        continue;
      }
      out.errors.push(`storage inbox: ${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      continue; // network or permission trouble: try again next tick, file untouched
    }
    // Taken in: the item holds the PDF now. A failed delete only means it is seen again and dismissed as a duplicate.
    try { await store.remove(f.path); } catch (e) {
      out.errors.push(`storage inbox: ${f.name} was taken in but not removed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/** Tests only. */
export function resetInboxMemory(): void { refused.clear(); }
