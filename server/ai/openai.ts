import OpenAI from 'openai';
import { AiOutputError, mapProviderError, parseJsonReply, type AiProvider, type AiRequest } from './provider.js';
import { tokens } from './usage.js';

export interface OpenAiLike {
  responses: { create(params: any): Promise<{ output_text?: string; usage?: Record<string, unknown> }> };
}

export class OpenAiProvider implements AiProvider {
  name = 'openai';
  supportsPdf = true;
  private client: OpenAiLike;
  constructor(apiKey: string, readonly model: string, client?: OpenAiLike) {
    this.client = client ?? (new OpenAI({ apiKey }) as unknown as OpenAiLike);
  }

  async completeJson(req: AiRequest): Promise<unknown> {
    const content: unknown[] = [];
    if (req.pdf) {
      content.push({
        type: 'input_file',
        filename: 'invoice.pdf',
        file_data: `data:application/pdf;base64,${req.pdf.toString('base64')}`,
      });
    }
    content.push({ type: 'input_text', text: req.user });
    let res;
    try {
      res = await this.client.responses.create({
        model: this.model,
        instructions: req.system,
        input: [{ role: 'user', content }],
        text: { format: { type: 'json_object' } },
      });
    } catch (e) {
      throw mapProviderError(e);
    }
    req.onUsage?.(res.usage ? { inputTokens: tokens(res.usage.input_tokens), outputTokens: tokens(res.usage.output_tokens) } : null);
    if (!res.output_text?.trim()) throw new AiOutputError('empty reply');
    return parseJsonReply(res.output_text);
  }

  async ping(): Promise<void> {
    try {
      await this.client.responses.create({ model: this.model, input: 'ping', max_output_tokens: 16 });
    } catch (e) {
      throw mapProviderError(e);
    }
  }
}
