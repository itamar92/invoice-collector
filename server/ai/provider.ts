import type { ZodType } from 'zod';
import { compileRecipe, runRecipe, type Recipe } from '../core/recipe.js';
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

export interface AiRequest { system: string; user: string; pdf?: Buffer }
export interface AiProvider {
  name: string;
  supportsPdf: boolean;
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

/**
 * Maps an SDK/HTTP failure. No HTTP status (connection error, timeout) -> unavailable;
 * 401/403 -> unavailable ("auth"); 408/409/429/5xx -> unavailable; any other 4xx means our request
 * was wrong -> plain Error (a bug that surfaces as needs_attention).
 */
export function mapProviderError(e: unknown): Error {
  if (e instanceof AiUnavailableError || e instanceof AiOutputError) return e;
  const err = e as { status?: unknown; code?: unknown; message?: unknown } | null;
  const status = typeof err?.status === 'number' ? err.status : typeof err?.code === 'number' ? err.code : undefined;
  const msg = typeof err?.message === 'string' ? err.message : String(e);
  if (status === undefined) return new AiUnavailableError(`ai unavailable: ${msg}`);
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
      return new AnthropicProvider(key, model ?? DEFAULT_MODELS.anthropic, deps.anthropic);
    }
    case 'openai': {
      const key = secret('ai_key_openai');
      if (!key) return new UnavailableProvider('openai', true, 'no api key');
      return new OpenAiProvider(key, model ?? DEFAULT_MODELS.openai, deps.openai);
    }
    case 'gemini': {
      const key = secret('ai_key_gemini');
      if (!key) return new UnavailableProvider('gemini', true, 'no api key');
      return new GeminiProvider(key, model ?? DEFAULT_MODELS.gemini, deps.gemini);
    }
    case 'ssh': {
      const ssh = s.ai.ssh;
      const key = secret('ssh_private_key');
      if (!ssh || !key) return new UnavailableProvider('ssh', false, 'no ssh configuration or key');
      return new SshAgentProvider(ssh, key, deps.sshClient);
    }
  }
}

/** Asks, validates; on bad JSON/schema retries once with the validation error appended, then AiOutputError. */
async function askValidated<T>(p: AiProvider, req: AiRequest, validate: (raw: unknown) => T): Promise<T> {
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
  input: { text: string; pdf?: Buffer; sender: string; categories: string[] },
): Promise<ExtractedFields> {
  const pdf = p.supportsPdf ? input.pdf : undefined;
  return askValidated(
    p,
    { system: EXTRACT_SYSTEM, user: extractUserPrompt({ ...input, hasPdf: pdf !== undefined }), pdf },
    schemaValidator<ExtractedFields>(ExtractedFieldsSchema),
  );
}

function reproduces(r: Recipe, text: string, f: ExtractedFields): boolean {
  const got = runRecipe(r, text);
  return got.issueDate === f.issueDate && got.total === f.total;
}

/**
 * Asks for a recipe, checks it against the same text; one retry on a miss, then returns the
 * last recipe flagged `aiAlways: true` so the vendor keeps using AI.
 */
export async function aiWriteRecipe(
  p: AiProvider,
  input: { text: string; sender: string; fields: ExtractedFields; previous?: Recipe },
): Promise<Recipe> {
  const validate = (raw: unknown): Recipe => {
    try {
      return compileRecipe(raw);
    } catch (e) {
      throw new AiOutputError((e as Error).message);
    }
  };
  let previous = input.previous;
  let last: Recipe | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const recipe = await askValidated(p, {
      system: RECIPE_SYSTEM,
      user: recipeUserPrompt({ ...input, previous }),
    }, validate);
    last = recipe;
    if (reproduces(recipe, input.text, input.fields)) return recipe;
    previous = recipe;
  }
  return { ...(last as Recipe), aiAlways: true };
}
