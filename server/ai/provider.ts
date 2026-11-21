import type { ZodType } from 'zod';
import { checkRecipe, compileRecipe, describeCheck, unsafeAiMatch, type Recipe } from '../core/recipe.js';
import type { ExtractedFields } from '../core/types.js';
import { getSecret, type SecretKey } from '../secrets.js';
import type { Settings } from '../settings.js';
import {
  EXTRACT_SYSTEM, ExtractedFieldsSchema, RECIPE_SYSTEM, extractUserPrompt, recipeUserPrompt,
} from './prompts.js';
import { AnthropicProvider, type AnthropicLike } from './anthropic.js';
import { OpenAiProvider, type OpenAiLike } from './openai.js';
import { GeminiProvider, type GeminiLike } from './gemini.js';
import { SshAgentProvider, type SshClientFactory } from './sshAgent.js';
import { inboxDir } from './inbox.js';
import { recordAiUsage, type AiUsage, type UsageTag } from './usage.js';

export interface AiRequest {
  system: string; user: string; pdf?: Buffer;
  /** Called once per reply received (also when the reply turns out unusable: its tokens were spent). */
  onUsage?: (u: AiUsage | null) => void;
}
export interface AiProvider {
  name: string;
  /** The model asked, for the usage record. */
  model?: string;
  supportsPdf: boolean;
  /** Attach the PDF only when the document has no text layer (a scan or photo); text goes as text. */
  pdfOnlyForScans?: boolean;
  completeJson(req: AiRequest): Promise<unknown>;
  ping(): Promise<void>;
}

/** Network, 5xx, 429, SSH connect failure, auth failure, missing key. Items wait and retry. */
export class AiUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'AiUnavailableError'; }
}
/** Reply was not valid JSON or failed schema validation. */
export class AiOutputError extends Error {
  constructor(message: string) { super(message); this.name = 'AiOutputError'; }
}

// Verify against provider docs at setup.
export const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-5', // verify against provider docs at setup
  gemini: 'gemini-2.5-flash', // verify against provider docs at setup
} as const;

const NETWORK_ERROR = /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR|socket hang up|fetch failed|network|timed? ?out|connection error/i;

/** True for connection/timeout failures (no HTTP response), judged by name, code, message or cause code. */
function isNetworkError(e: unknown): boolean {
  const err = e as { name?: unknown; code?: unknown; message?: unknown; cause?: { code?: unknown } } | null;
  if (typeof err?.name === 'string' && /Connection|Timeout|Abort/.test(err.name)) return true;
  return [err?.code, err?.message, err?.cause?.code, typeof e === 'string' ? e : undefined]
    .some((v) => typeof v === 'string' && NETWORK_ERROR.test(v));
}

/**
 * Maps an SDK/HTTP failure. Network failure (connection, timeout, fetch failed) -> unavailable;
 * 401/403 -> unavailable ("auth"); 408/409/429/5xx -> unavailable. Anything else (other 4xx: our request was
 * wrong; no status and not network-like: a bug or an unexpected reply) -> plain Error, which the pipeline turns
 * into needs_attention/ai_failed instead of waiting forever.
 */
export function mapProviderError(e: unknown): Error {
  if (e instanceof AiUnavailableError || e instanceof AiOutputError) return e;
  const err = e as { status?: unknown; code?: unknown; message?: unknown } | null;
  const status = typeof err?.status === 'number' ? err.status : typeof err?.code === 'number' ? err.code : undefined;
  const msg = typeof err?.message === 'string' ? err.message : String(e);
  if (status === undefined) {
    return isNetworkError(e) ? new AiUnavailableError(`ai unavailable: ${msg}`) : new Error(`ai request failed: ${msg}`);
  }
  if (status === 401 || status === 403) return new AiUnavailableError(`ai auth failed (${status}): check the API key`);
  if (status === 408 || status === 409 || status === 429 || status >= 500) {
    return new AiUnavailableError(`ai unavailable (${status}): ${msg}`);
  }
  return new Error(`ai request rejected (${status}): ${msg}`);
}

/** Strips ```json fences and parses; throws AiOutputError when the reply is not one JSON value. */
export function parseJsonReply(text: string): unknown {
  let s = text.trim();
  const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(s);
  if (fence) s = (fence[1] ?? '').trim();
  try {
    return JSON.parse(s);
  } catch {
    throw new AiOutputError(`reply is not valid JSON: ${s.slice(0, 80)}`);
  }
}

export interface AiDeps {
  anthropic?: AnthropicLike;
  openai?: OpenAiLike;
  gemini?: GeminiLike;
  sshClient?: SshClientFactory;
  getSecret?: (k: SecretKey) => string | null;
  /** Shared folder for the SSH agent to read documents from; defaults to AI_INBOX_DIR. */
  inboxDir?: string | null;
}

class UnavailableProvider implements AiProvider {
  supportsPdf: boolean;
  constructor(public name: string, supportsPdf: boolean, private reason: string) { this.supportsPdf = supportsPdf; }
  async completeJson(): Promise<unknown> { throw new AiUnavailableError(this.reason); }
  async ping(): Promise<void> { throw new AiUnavailableError(this.reason); }
}

export function getAiProvider(s: Pick<Settings, 'ai'>, deps: AiDeps = {}): AiProvider | null {
  const { mode, model } = s.ai;
  if (mode === 'none') return null;
  const secret = deps.getSecret ?? getSecret;
  switch (mode) {
    case 'anthropic': {
      const key = secret('ai_key_anthropic');
      if (!key) return new UnavailableProvider('anthropic', true, 'no api key');
      return new AnthropicProvider(key, model?.trim() || DEFAULT_MODELS.anthropic, deps.anthropic);
    }
    case 'openai': {
      const key = secret('ai_key_openai');
      if (!key) return new UnavailableProvider('openai', true, 'no api key');
      return new OpenAiProvider(key, model?.trim() || DEFAULT_MODELS.openai, deps.openai);
    }
    case 'gemini': {
      const key = secret('ai_key_gemini');
      if (!key) return new UnavailableProvider('gemini', true, 'no api key');
      return new GeminiProvider(key, model?.trim() || DEFAULT_MODELS.gemini, deps.gemini);
    }
    case 'ssh': {
      const ssh = s.ai.ssh;
      const key = secret('ssh_private_key');
      const inbox = deps.inboxDir !== undefined ? deps.inboxDir : inboxDir();
      if (!ssh || !key) return new UnavailableProvider('ssh', inbox !== null, 'no ssh configuration or key');
      return new SshAgentProvider(ssh, key, deps.sshClient, inbox);
    }
  }
}

/** Asks, validates; on bad JSON/schema retries once with the validation error appended, then AiOutputError. */
async function askValidated<T>(p: AiProvider, request: AiRequest, validate: (raw: unknown) => T, tag?: UsageTag): Promise<T> {
  const req: AiRequest = tag
    ? { ...request, onUsage: (u) => recordAiUsage(tag, p.name, p.model ?? null, u) }
    : request;
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = attempt === 0 ? req : {
      ...req,
      user: `${req.user}\n\nYour previous reply was rejected: ${lastError}\nReply again with one corrected JSON object only.`,
    };
    try {
      return validate(await p.completeJson(r));
    } catch (e) {
      if (!(e instanceof AiOutputError)) throw e;
      lastError = e.message;
    }
  }
  throw new AiOutputError(lastError);
}

function schemaValidator<T>(schema: ZodType<T, any, any>): (raw: unknown) => T {
  return (raw) => {
    const r = schema.safeParse(raw);
    if (!r.success) {
      throw new AiOutputError(r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
    }
    return r.data;
  };
}

export function aiExtract(
  p: AiProvider,
  input: { text: string; pdf?: Buffer; isScan?: boolean; sender: string; categories: string[] },
  tag: UsageTag = { purpose: 'extract' },
): Promise<ExtractedFields> {
  const { isScan, ...rest } = input;
  const pdf = p.supportsPdf && (!p.pdfOnlyForScans || isScan) ? input.pdf : undefined;
  return askValidated(
    p,
    { system: EXTRACT_SYSTEM, user: extractUserPrompt({ ...rest, hasPdf: pdf !== undefined }), pdf },
    schemaValidator<ExtractedFields>(ExtractedFieldsSchema),
    tag,
  );
}

/** The recipe reads the same date and total from the text as the given (correct) fields. */
export function reproduces(r: Recipe, text: string, f: ExtractedFields): boolean {
  return checkRecipe(r, text, f).ok;
}

/**
 * Asks for a recipe, checks it against the same text; one retry on a miss, then returns the
 * last recipe flagged `aiAlways: true` so the vendor keeps using AI.
 */
export async function aiWriteRecipe(
  p: AiProvider,
  input: { text: string; sender: string; fields: ExtractedFields; previous?: Recipe; feedback?: string },
  tag: UsageTag = { purpose: 'recipe' },
): Promise<Recipe> {
  const validate = (raw: unknown): Recipe => {
    let r: Recipe;
    try {
      r = compileRecipe(raw);
    } catch (e) {
      throw new AiOutputError((e as Error).message);
    }
    const unsafe = unsafeAiMatch(r.match, input.previous?.match);
    if (unsafe.length) throw new AiOutputError(`unsafe match: ${unsafe.join('; ')}`);
    return r;
  };
  let previous = input.previous;
  // What the current recipe reads wrong on this document, so the AI starts from the actual mistake.
  const before = previous && checkRecipe(previous, input.text, input.fields);
  let misses = before && !before.ok ? describeCheck(before) : undefined;
  let last: Recipe | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const recipe = await askValidated(p, {
      system: RECIPE_SYSTEM,
      user: recipeUserPrompt({ ...input, previous, misses }),
    }, validate, tag);
    last = recipe;
    const check = checkRecipe(recipe, input.text, input.fields);
    if (check.ok) return recipe;
    previous = recipe;
    misses = describeCheck(check);
  }
  return { ...(last as Recipe), aiAlways: true };
}
