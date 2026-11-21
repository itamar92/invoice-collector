import type { Problem } from './validate.js';
import type { AiProvider } from '../ai/provider.js';
import type { Category, Settings } from '../settings.js';

export type DocType = 'tax_invoice' | 'receipt' | 'tax_invoice_receipt' | 'credit_note' | 'other';

export const DOC_TYPE_HE: Record<DocType, string> = {
  tax_invoice: 'חשבונית מס',
  receipt: 'קבלה',
  tax_invoice_receipt: 'חשבונית מס קבלה',
  credit_note: 'חשבונית זיכוי',
  other: 'מסמך',
};

export interface ExtractedFields {
  vendorName: string | null;
  vendorTaxId: string | null;
  docType: DocType | null;
  docNumber: string | null;
  issueDate: string | null; // YYYY-MM-DD
  total: number | null;
  vat: number | null;
  net: number | null;
  currency: string | null;
  allocationNumber: string | null;
  description: string | null;
  category: string | null;
  /** The owner looked at a VAT that does not add up (e.g. a mixed-rate or partly exempt bill) and accepted it. */
  vatConfirmed?: boolean;
}

export type Provenance = 'recipe' | 'ai' | 'manual';

export type ItemState =
  | 'queued' | 'waiting_ai' | 'needs_attention' | 'awaiting_vendor' | 'awaiting_backfill_approval'
  | 'ready' | 'stored' | 'done' | 'ignored' | 'dismissed';

export const TERMINAL_STATES: readonly ItemState[] = ['done', 'ignored', 'dismissed'];

export type Reason =
  | Problem
  | 'unreadable_pdf' | 'scan_needs_api_ai' | 'no_recipe_no_ai' | 'ai_failed' | 'unknown_category'
  | 'no_document' | 'link_not_pdf' | 'link_blocked' | 'link_too_large' | 'link_failed' | 'storage_error'
  | 'accounting_error' | 'recipe_rewritten' | 'duplicate' | 'new_vendor' | 'internal_error';

/** Where filed PDFs go (Dropbox in v1, Task 11). */
export interface StorageDestination {
  put(folder: string, filename: string, pdf: Buffer): Promise<{ path: string; existed: boolean }>;
  /** `pdf` is the content about to be filed, so the destination can compare hashes for `sameContent`. */
  exists(folder: string, filename: string, pdf: Buffer): Promise<{ exists: boolean; sameContent: boolean }>;
  /** The folders directly inside `path` ('' = the top), for picking where to file. Read-only. */
  listFolders?(path: string): Promise<FolderEntry[]>;
  /** Creates `name` inside `parent` ('' = the top); an existing folder of that name is returned as it is. */
  createFolder?(parent: string, name: string): Promise<FolderEntry>;
}
export interface FolderEntry { name: string; path: string }
/** createFolder: a file (not a folder) already has that name. */
export class FolderConflictError extends Error {
  constructor(path: string) { super(`a file already exists at: ${path}`); this.name = 'FolderConflictError'; }
}
/** listFolders: the folder asked for does not exist. */
export class FolderNotFoundError extends Error {
  constructor(path: string) { super(`folder not found: ${path}`); this.name = 'FolderNotFoundError'; }
}

/** Where business expenses are sent (Morning in v1, Task 12). */
export interface AccountingDestination {
  /** `retry`: this item already had a send attempt (it may have reached the destination), so check for it first. */
  send(item: { pdf: Buffer; filename: string; fields: ExtractedFields; category: Category; retry?: boolean }):
    Promise<{ ref: string; mode: 'api_fields' | 'api_file' | 'email' }>;
}

export interface Deps {
  storage: StorageDestination;
  accounting: AccountingDestination | null;
  ai: AiProvider | null;
  settings: Settings;
  now: () => Date;
  /** Defaults to extractPdfText; injectable for tests. */
  extractText?: (pdf: Buffer) => Promise<{ text: string; pages: number; isScan: boolean }>;
}

/** Network, 429, 5xx from a destination: the pipeline retries with backoff. */
export class TransientError extends Error {
  constructor(message: string) { super(message); this.name = 'TransientError'; }
}

/** The accounting destination refused the document (4xx); message is its reason. Not retried. */
export class AccountingRejected extends Error {
  constructor(message: string) { super(message); this.name = 'AccountingRejected'; }
}
