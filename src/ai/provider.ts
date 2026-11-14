import type { AITask } from '../db/settings';
import { ZOD_BY_TASK, type JSONSchema } from './schemas';

export type { AITask, JSONSchema };

export interface AIProvider {
  run<T>(task: AITask, input: unknown, schema: JSONSchema): Promise<T>;
}

export type AIErrorKind = 'http' | 'network' | 'status' | 'parse' | 'schema' | 'nokey' | 'cancelled';

export class AIError extends Error {
  readonly kind: AIErrorKind;
  readonly status?: number;
  constructor(kind: AIErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'AIError';
    this.kind = kind;
    this.status = status;
  }
}

/** Strip a ```json fence (or any ``` fence) around the payload. */
export function stripFence(text: string): string {
  const t = text.trim();
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  return (m ? m[1]! : t).trim();
}

/** JSON.parse + zod validation for a task's output. Throws AIError('parse' | 'schema'). */
export function parseTaskOutput<T>(task: AITask, text: string): T {
  let data: unknown;
  try {
    data = JSON.parse(stripFence(text));
  } catch {
    throw new AIError('parse', 'JSONとして読み取れませんでした。');
  }
  const r = ZOD_BY_TASK[task].safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join(' / ');
    throw new AIError('schema', `出力がスキーマに合いません: ${issues}`);
  }
  return r.data as T;
}
