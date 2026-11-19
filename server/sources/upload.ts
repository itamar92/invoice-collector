import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { ImageError, isJpeg, jpegToPdf } from '../core/imagePdf.js';
import { UPLOAD_PREFIX, createEmail, createItem, getItem } from '../core/items.js';
import type { Item } from '../core/items.js';
import { processItem } from '../core/pipeline.js';
import type { Deps } from '../core/types.js';
import { updateSettings } from '../settings.js';
import { isPdf } from './gmail.js';

/** Where the owner handed the document in. Stored as the "sender" of the upload's source row. */
export type UploadSource = 'upload' | 'telegram';

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export class UploadError extends Error {
  constructor(readonly code: 'unsupported_file' | 'too_large' | 'empty_file', message?: string) {
    super(message ?? code);
    this.name = 'UploadError';
  }
}

/** A PDF as it is; a JPEG photo wrapped in a one-page PDF. Anything else is refused. */
export function toPdf(data: Buffer): Buffer {
  if (data.length === 0) throw new UploadError('empty_file');
  if (data.length > MAX_UPLOAD_BYTES) throw new UploadError('too_large');
  if (isPdf(data)) return data;
  if (isJpeg(data)) {
    try { return jpegToPdf(data); } catch (e) {
      if (e instanceof ImageError) throw new UploadError('unsupported_file', e.message);
      throw e;
    }
  }
  throw new UploadError('unsupported_file');
}

/** Display name for the item: no path, no control characters, at most 100 characters, always `.pdf`. */
function cleanName(name: string | null | undefined, fallback: string): string {
  const base = (name ?? '').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').trim()
    .replace(/\.(pdf|jpe?g|png|heic|heif|webp)$/i, '').slice(0, 96);
  return `${base || fallback}.pdf`;
}

/**
 * Stores a document the owner handed in directly (a photographed paper receipt or a PDF) as a queued item.
 * It has no Gmail message: its source row gets an `upload:` id and is marked as handled so nothing ever looks
 * for it in Gmail. The same file handed in twice is recorded as a dismissed duplicate (`duplicateOf`).
 */
export function createUpload(
  source: UploadSource, name: string | null | undefined, data: Buffer, now: Date = new Date(),
): { id: string; duplicateOf?: string } {
  const pdf = toPdf(data);
  const messageId = `${UPLOAD_PREFIX}${randomUUID()}`;
  const attachment = cleanName(name, source === 'telegram' ? 'telegram' : 'receipt');
  return getDb().transaction(() => {
    createEmail({
      messageId, threadId: '', sender: source, subject: attachment, receivedAt: now.toISOString(), mode: 'manual',
    });
    getDb().prepare('UPDATE emails SET gmail_marked = 1 WHERE message_id = ?').run(messageId);
    return createItem(messageId, attachment, pdf);
  })();
}

/**
 * Runs a freshly uploaded item through the pipeline right away, so the owner gets an answer while still holding
 * the receipt. Without deps (services not connected yet) it stays queued for the worker.
 */
export async function runUpload(id: string, deps: Deps | null): Promise<Item> {
  if (deps) {
    await processItem(id, deps);
    if (getItem(id)?.provenance === 'ai') updateSettings({ lastAiSuccessAt: deps.now().toISOString() });
  }
  return getItem(id)!;
}
