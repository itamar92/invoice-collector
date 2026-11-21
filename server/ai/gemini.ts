import { GoogleGenAI } from '@google/genai';
import { AiOutputError, mapProviderError, parseJsonReply, type AiProvider, type AiRequest } from './provider.js';
import { tokens } from './usage.js';

export interface GeminiLike {
  models: {
    generateContent(params: any): Promise<{ text?: string; usageMetadata?: Record<string, unknown> }>;
    get(params: { model: string }): Promise<unknown>;
  };
}

export class GeminiProvider implements AiProvider {
  name = 'gemini';
  supportsPdf = true;
  private client: GeminiLike;
  constructor(apiKey: string, readonly model: string, client?: GeminiLike) {
    this.client = client ?? (new GoogleGenAI({ apiKey }) as unknown as GeminiLike);
  }

  async completeJson(req: AiRequest): Promise<unknown> {
    const parts: unknown[] = [];
    if (req.pdf) parts.push({ inlineData: { mimeType: 'application/pdf', data: req.pdf.toString('base64') } });
    parts.push({ text: req.user });
    let res;
    try {
      res = await this.client.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts }],
        config: { systemInstruction: req.system, responseMimeType: 'application/json' },
      });
    } catch (e) {
      throw mapProviderError(e);
    }
    const m = res.usageMetadata;
    // Thinking tokens are billed as output.
    req.onUsage?.(m ? {
      inputTokens: tokens(m.promptTokenCount),
      outputTokens: (tokens(m.candidatesTokenCount) ?? 0) + (tokens(m.thoughtsTokenCount) ?? 0),
    } : null);
    if (!res.text?.trim()) throw new AiOutputError('empty reply');
    return parseJsonReply(res.text);
  }

  async ping(): Promise<void> {
    try {
      await this.client.models.get({ model: this.model });
    } catch (e) {
      throw mapProviderError(e);
    }
  }
}
