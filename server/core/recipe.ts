import RE2 from 're2';
import { z } from 'zod';
import { DOC_TYPE_HE, type DocType, type ExtractedFields } from './types.js';
import { hebrewMonthName, normalize, parseAmount, parseDate, parseDocType, type DateFormat } from './parse.js';

export class RecipeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipeError';
  }
}

export type FieldName = keyof ExtractedFields;
export type FieldRule =
  | {
      kind: 'regex';
      pattern: string;
      flags?: 'i' | 'm' | 'im';
      group?: number;
      parse: 'text' | 'amount' | 'date' | 'docType';
      dateFormat?: DateFormat;
    }
  | { kind: 'const'; value: string };

export interface Recipe {
  schemaVersion: 1;
  vendorKey: string;
  displayName: string;
  match: { senders?: string[]; textMarkers?: string[] };
  fields: Partial<Record<FieldName, FieldRule>>;
  description?: string;
  aiAlways?: boolean;
}

const FIELD_NAMES = [
  'vendorName', 'vendorTaxId', 'docType', 'docNumber', 'issueDate', 'total',
  'vat', 'net', 'currency', 'allocationNumber', 'description', 'category',
] as const satisfies readonly FieldName[];

const AMOUNT_FIELDS: ReadonlySet<string> = new Set(['total', 'vat', 'net']);
const PLACEHOLDERS: ReadonlySet<string> = new Set(['issueMonth', 'issueMonth-1', 'issueYear', 'docNumber']);
const DATE_FORMATS = ['DD/MM/YYYY', 'DD.MM.YYYY', 'DD/MM/YY', 'YYYY-MM-DD', 'DD-MM-YYYY'] as const;

const RegexRule = z.object({
  kind: z.literal('regex'),
  pattern: z.string().min(1).max(300),
  flags: z.enum(['i', 'm', 'im']).optional(),
  group: z.number().int().min(0).max(20).optional(),
  parse: z.enum(['text', 'amount', 'date', 'docType']),
  dateFormat: z.enum(DATE_FORMATS).optional(),
});
const ConstRule = z.object({ kind: z.literal('const'), value: z.string().max(300) });
const FieldRuleSchema = z.discriminatedUnion('kind', [RegexRule, ConstRule]);

const RecipeShape = z.object({
  schemaVersion: z.literal(1),
  vendorKey: z.string().regex(/^[a-z0-9-]{2,60}$/),
  displayName: z.string().min(1).max(100),
  match: z.object({
    senders: z.array(z.string().min(1).max(200)).max(10).optional(),
    textMarkers: z.array(z.string().min(1).max(200)).max(10).optional(),
  }),
  fields: z.record(z.enum(FIELD_NAMES), FieldRuleSchema).superRefine((fields, ctx) => {
    const entries = Object.entries(fields) as [FieldName, FieldRule][];
    if (entries.length > 20) ctx.addIssue({ code: 'custom', message: 'at most 20 fields' });
    for (const [name, rule] of entries) {
      const bad = (message: string) => ctx.addIssue({ code: 'custom', path: [name], message });
      if (rule.kind === 'const') {
        if (AMOUNT_FIELDS.has(name) || name === 'issueDate') bad(`const not allowed for ${name}`);
        else if (name === 'docType' && !Object.hasOwn(DOC_TYPE_HE, rule.value)) bad(`unknown docType "${rule.value}"`);
        continue;
      }
      const expected = AMOUNT_FIELDS.has(name) ? 'amount' : name === 'issueDate' ? 'date' : name === 'docType' ? 'docType' : 'text';
      if (rule.parse !== expected) bad(`field ${name} requires parse "${expected}"`);
      if (rule.parse === 'date' && !rule.dateFormat) bad('dateFormat is required for parse "date"');
    }
  }),
  description: z.string().max(300).optional().superRefine((tpl, ctx) => {
    for (const m of (tpl ?? '').matchAll(/\{([^}]*)\}/g)) {
      if (!PLACEHOLDERS.has(m[1] ?? '')) ctx.addIssue({ code: 'custom', message: `unknown placeholder {${m[1]}}` });
    }
  }),
  aiAlways: z.boolean().optional(),
});

/** Full validation: shape, field/parse compatibility, non-empty match, and every pattern compiles under RE2. */
export const RecipeSchema = RecipeShape.superRefine((r, ctx) => {
  if ((r.match.senders?.length ?? 0) + (r.match.textMarkers?.length ?? 0) === 0) {
    ctx.addIssue({ code: 'custom', path: ['match'], message: 'match needs at least one sender or text marker' });
  }
  for (const [name, rule] of Object.entries(r.fields)) {
    if (rule.kind !== 'regex') continue;
    try {
      new RE2(rule.pattern, rule.flags ?? '');
    } catch (e) {
      ctx.addIssue({ code: 'custom', path: ['fields', name], message: `invalid pattern: ${(e as Error).message}` });
    }
  }
});

// Compile-time checks: the zod output type and Recipe must be assignable both ways.
type Inferred = z.infer<typeof RecipeSchema>;
const _toRecipe = (x: Inferred): Recipe => x;
const _toInferred = (x: Recipe): Inferred => x;
void _toRecipe;
void _toInferred;

const compiled = new WeakMap<Recipe, Map<string, RE2>>();

function compilePatterns(r: Recipe): Map<string, RE2> {
  const map = new Map<string, RE2>();
  for (const [name, rule] of Object.entries(r.fields) as [FieldName, FieldRule][]) {
    if (rule.kind !== 'regex') continue;
    try {
      map.set(name, new RE2(rule.pattern, rule.flags ?? ''));
    } catch (e) {
      throw new RecipeError(`field ${name}: invalid pattern: ${(e as Error).message}`);
    }
  }
  compiled.set(r, map);
  return map;
}

/** Validates the recipe and compiles every pattern with RE2. Throws RecipeError. */
export function compileRecipe(input: unknown): Recipe {
  const parsed = RecipeSchema.safeParse(input);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new RecipeError(`invalid recipe: ${msg}`);
  }
  const recipe = parsed.data;
  compilePatterns(recipe);
  return recipe;
}

/** Shared mailbox providers: an address there says nothing about which vendor sent the document. */
const FREE_MAIL = /(^|[.@])(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|walla|icloud|me|aol|proton|protonmail|zoho|gmx|mail)\.[a-z.]+$/i;

export function isFreeMailSender(sender: string): boolean {
  return FREE_MAIL.test(sender.trim().toLowerCase());
}

/** Text every invoice carries: as a marker it would select any vendor's documents. */
const GENERIC_MARKERS: ReadonlySet<string> = new Set([
  'חשבונית', 'חשבונית מס', 'חשבונית מס קבלה', 'חשבונית מס/קבלה', 'חשבונית זיכוי', 'קבלה', 'מקור', 'העתק', 'נאמן למקור',
  'תאריך', 'סה"כ', 'סה"כ לתשלום', 'לתשלום', 'מע"מ', 'בע"מ', 'עוסק מורשה', 'ח.פ.', 'ח"פ', 'מספר', 'סכום',
  'invoice', 'tax invoice', 'receipt', 'total', 'date', 'amount', 'vat', 'ltd', 'bill', 'payment',
]);
const MIN_MARKER_LENGTH = 4;
const markerKey = (m: string) => normalize(m).replace(/[״”“″]/g, '"').replace(/[׳’‘′]/g, "'")
  .replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Why an AI-written match could select other vendors' documents (empty = safe): a wildcard or free-mail sender,
 * or a generic or very short text marker. Entries the vendor's current recipe already has (`allowed`: proven,
 * written by a person or shipped) are not re-judged.
 */
export function unsafeAiMatch(match: Recipe['match'], allowed?: Recipe['match']): string[] {
  const okSenders = new Set((allowed?.senders ?? []).map((x) => x.toLowerCase()));
  const okMarkers = new Set((allowed?.textMarkers ?? []).map(markerKey));
  const problems: string[] = [];
  for (const s of match.senders ?? []) {
    if (okSenders.has(s.toLowerCase())) continue;
    if (s.includes('*')) problems.push(`wildcard sender "${s}" is not allowed; use the exact address`);
    else if (isFreeMailSender(s)) problems.push(`free-mail sender "${s}" does not identify a vendor; use text markers instead`);
  }
  for (const m of match.textMarkers ?? []) {
    const k = markerKey(m);
    if (okMarkers.has(k)) continue;
    if (k.length < MIN_MARKER_LENGTH || GENERIC_MARKERS.has(k)) {
      problems.push(`text marker "${m}" is too generic; use the vendor's own name or tax id`);
    }
  }
  return problems;
}

/** True when the recipe has sender patterns and `sender` (a bare address) matches one of them. */
export function senderMatches(r: Recipe, sender: string): boolean {
  const senders = r.match.senders;
  if (!senders || senders.length === 0) return false;
  const s = sender.trim().toLowerCase();
  return senders.some((p) => {
    const pat = p.toLowerCase();
    return pat.startsWith('*@') ? s.endsWith(pat.slice(1)) : s === pat;
  });
}

/** Hebrew gershayim/geresh and typographic quotes as ASCII, so a marker like אקו"ם matches every spelling. */
const foldQuotes = (s: string) => s.replace(/[״”“″]/g, '"').replace(/[׳’‘′]/g, "'");

export function matchesRecipe(r: Recipe, sender: string, text: string): boolean {
  const { senders, textMarkers } = r.match;
  if (senders && senders.length > 0 && !senderMatches(r, sender)) return false;
  if (textMarkers) {
    const t = foldQuotes(normalize(text));
    if (!textMarkers.every((m) => t.includes(foldQuotes(normalize(m))))) return false;
  }
  return true;
}

function extract(rule: Extract<FieldRule, { kind: 'regex' }>, re: RE2, text: string): string | number | null {
  const m = re.exec(text);
  if (!m) return null;
  const group = rule.group ?? (m.length > 1 ? 1 : 0);
  const raw = m[group];
  if (raw === undefined) return null;
  switch (rule.parse) {
    case 'text': return raw.trim() || null;
    case 'amount': return parseAmount(raw);
    case 'date': return parseDate(raw, rule.dateFormat as DateFormat);
    case 'docType': return parseDocType(raw);
  }
}

function renderDescription(tpl: string, issueDate: string | null, docNumber: string | null): string | null {
  if (!issueDate) return null;
  const year = Number(issueDate.slice(0, 4));
  const month = Number(issueDate.slice(5, 7));
  return tpl.replace(/\{([^}]*)\}/g, (_, key: string) => {
    switch (key) {
      case 'issueMonth': return hebrewMonthName(month);
      case 'issueMonth-1': return hebrewMonthName(month === 1 ? 12 : month - 1);
      case 'issueYear': return String(year);
      default: return docNumber ?? '';
    }
  });
}

export function runRecipe(r: Recipe, rawText: string): ExtractedFields {
  const text = normalize(rawText);
  const patterns = compiled.get(r) ?? compilePatterns(r);
  const out: ExtractedFields = {
    vendorName: null, vendorTaxId: null, docType: null, docNumber: null, issueDate: null,
    total: null, vat: null, net: null, currency: null, allocationNumber: null,
    description: null, category: null,
  };
  const set = out as unknown as Record<FieldName, string | number | null>;
  for (const [name, rule] of Object.entries(r.fields) as [FieldName, FieldRule][]) {
    if (rule.kind === 'const') set[name] = rule.value as DocType | string;
    else set[name] = extract(rule, patterns.get(name) as RE2, text);
  }
  if (out.description === null && r.description !== undefined && !r.fields.description) {
    out.description = renderDescription(r.description, out.issueDate, out.docNumber);
  }
  return out;
}
