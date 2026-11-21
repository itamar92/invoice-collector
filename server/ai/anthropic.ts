import Anthropic from '@anthropic-ai/sdk';
import { AiOutputError, mapProviderError, parseJsonReply, type AiProvider, type AiRequest } from './provider.js';
import { tokens } from './usage.js';

export interface AnthropicLike {
  messages: { create(params: any): Promise<{ content: { type: string; text?: string }[]; usage?: Record<string, unknown> }> };
}

export class AnthropicProvider implements AiProvider {
  name = 'anthropic';
  supportsPdf = true;
  private client: AnthropicLike;
  constructor(apiKey: string, readonly model: string, client?: AnthropicLike) {
    this.client = client ?? (new Anthropic({ apiKey }) as unknown as AnthropicLike);
  }

  async completeJson(req: AiRequest): Promise<unknown> {
    const content: unknown[] = [];
    if (req.pdf) {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: req.pdf.toString('base64') },
      });
    }
    content.push({ type: 'text', text: req.user });
    let res;
    try {
      res = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: req.system,
        messages: [{ role: 'user', content }],
      });
    } catch (e) {
      throw mapProviderError(e);
    }
    const u = res.usage;
    // Cached prompt tokens are input too (billed at another rate, but still read).
    req.onUsage?.(u ? {
      inputTokens: (tokens(u.input_tokens) ?? 0) + (tokens(u.cache_creation_input_tokens) ?? 0) + (tokens(u.cache_read_input_tokens) ?? 0),
      outputTokens: tokens(u.output_tokens),
    } : null);
    const text = res.content.map((b) => (b.type === 'text' ? b.text ?? '' : '')).join('');
    if (!text.trim()) throw new AiOutputError('empty reply');
    return parseJsonReply(text);
  }

  async ping(): Promise<void> {
    try {
      await this.client.messages.create({
        model: this.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }],
      });
    } catch (e) {
      throw mapProviderError(e);
    }
  }
}
