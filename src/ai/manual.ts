import { SYSTEM_PROMPTS } from './prompts';
import { AIError, parseTaskOutput, type AIProvider, type AITask, type JSONSchema } from './provider';

/** "system prompt + output schema + input JSON" as one text block for the clipboard. */
export function buildManualPrompt(task: AITask, input: unknown, schema: JSONSchema): string {
  return [
    '# 指示（システムプロンプト）',
    SYSTEM_PROMPTS[task],
    '',
    '# 出力スキーマ（このJSON Schemaに厳密に従ったJSONだけを出力すること。説明文は不要）',
    '```json',
    JSON.stringify(schema),
    '```',
    '',
    '# 入力JSON',
    '```json',
    JSON.stringify(input),
    '```',
  ].join('\n');
}

export type ManualRequest = { task: AITask; prompt: string };
/**
 * UI bridge: shows the prompt (copy button) and a textarea; calls `validate` with the pasted
 * response so errors can be shown in place, and resolves with the text once it is accepted.
 * Resolves with null when the user cancels.
 */
export type ManualAsk = (req: ManualRequest, validate: (text: string) => string | null) => Promise<string | null>;

export class ManualProvider implements AIProvider {
  constructor(private readonly ask: ManualAsk) {}

  async run<T>(task: AITask, input: unknown, schema: JSONSchema): Promise<T> {
    const prompt = buildManualPrompt(task, input, schema);
    const validate = (text: string): string | null => {
      try {
        parseTaskOutput(task, text);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
    const text = await this.ask({ task, prompt }, validate);
    if (text === null) throw new AIError('cancelled', 'キャンセルしました。');
    return parseTaskOutput<T>(task, text);
  }
}
