import type { AITask } from '../db/settings';
import { SYSTEM_PROMPTS } from './prompts';
import { AIError, parseTaskOutput, type AIProvider, type JSONSchema } from './provider';

export const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';
export const GEMINI_PATH = '/v1beta/interactions';
export const API_REVISION = '2026-05-20';
export const RETRY_DELAYS_MS = [2000, 4000, 8000];

export type GeminiOptions = {
  apiKey: string;
  models: Record<AITask, string>;
  useProxy?: boolean;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Called once per HTTP request that reached the API and got a response (usage counter). */
  onCall?: () => void | Promise<void>;
};

type Step = { type?: string; content?: { type?: string; text?: string }[] };
type InteractionResponse = { status?: string; steps?: Step[]; error?: { message?: string } };

export function thinkingLevel(task: AITask): 'medium' | 'low' {
  return task === 'analyze' ? 'medium' : 'low';
}

/** Text of the last `model_output` step. */
export function extractText(res: InteractionResponse): string {
  const outputs = (res.steps ?? []).filter((s) => s.type === 'model_output');
  const last = outputs[outputs.length - 1];
  if (!last) throw new AIError('parse', '応答に model_output がありません。');
  return (last.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
}

export class GeminiProvider implements AIProvider {
  constructor(private readonly opts: GeminiOptions) {}

  async run<T>(task: AITask, input: unknown, schema: JSONSchema): Promise<T> {
    const { apiKey, models } = this.opts;
    if (!apiKey) throw new AIError('nokey', 'Gemini APIキーが設定されていません（設定画面で入力してください）。');
    const fetchFn = this.opts.fetchFn ?? fetch;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const url = (this.opts.useProxy ? '/gemini' : GEMINI_ORIGIN) + GEMINI_PATH;
    const body = JSON.stringify({
      model: models[task],
      system_instruction: SYSTEM_PROMPTS[task],
      input: typeof input === 'string' ? input : JSON.stringify(input),
      store: false,
      response_format: { type: 'text', mime_type: 'application/json', schema },
      generation_config: { thinking_level: thinkingLevel(task), max_output_tokens: 8192 },
    });

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchFn(url, {
          method: 'POST',
          headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json', 'Api-Revision': API_REVISION },
          body,
        });
      } catch (e) {
        throw new AIError('network', `通信エラー（ブラウザからの直接呼び出しがCORSで拒否された可能性があります。プロキシを有効にしてください）: ${e instanceof Error ? e.message : String(e)}`);
      }
      await this.opts.onCall?.();
      if (res.status === 429 || res.status >= 500) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) throw new AIError('http', `Gemini API エラー (HTTP ${res.status})。再試行しても失敗しました。`, res.status);
        await sleep(delay);
        continue;
      }
      if (!res.ok) {
        let msg = '';
        try {
          msg = ((await res.json()) as InteractionResponse).error?.message ?? '';
        } catch {
          msg = '';
        }
        throw new AIError('http', `Gemini API エラー (HTTP ${res.status}) ${msg}`.trim(), res.status);
      }
      let json: InteractionResponse;
      try {
        json = (await res.json()) as InteractionResponse;
      } catch {
        throw new AIError('parse', '応答をJSONとして読み取れませんでした。');
      }
      if (json.status !== 'completed') throw new AIError('status', `Gemini の応答が完了していません (status: ${String(json.status)})。`);
      return parseTaskOutput<T>(task, extractText(json));
    }
  }
}

/** Date key in America/Los_Angeles (Gemini quotas reset at midnight Pacific time). */
export function ptDate(ts: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
