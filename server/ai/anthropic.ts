import Anthropic from '@anthropic-ai/sdk';
import { AiOutputError, mapProviderError, parseJsonReply, type AiProvider, type AiRequest } from './provider.js';

export interface AnthropicLike {
  messages: { create(params: any): Promise<{ content: { type: string; text?: string }[] }> };
}

export class AnthropicProvider implements AiProvider {
  name = 'anthropic';
  supportsPdf = true;
  private client: AnthropicLike;
  constructor(apiKey: string, private model: string, client?: AnthropicLike) {
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
