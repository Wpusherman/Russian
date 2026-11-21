import { z } from 'zod';
import type { AITask } from '../db/settings';

export type JSONSchema = { [key: string]: unknown };

// ---------- analyze ----------

export const analyzeZ = z.object({
  diagnosis: z.array(z.object({ tag: z.string(), hypothesis_ja: z.string(), evidence: z.string() })).max(5),
  tag_weights: z.array(z.object({ tag: z.string(), w: z.number().min(0.5).max(3) })).max(10),
  new_items: z.array(z.object({
    sentence_ru: z.string(), lemma: z.string(), feat: z.string(), answer: z.string(),
    translation_ja: z.string(), explain_ja: z.string(),
  })).max(20),
  tips_ja: z.string(),
  feature_requests: z.array(z.object({ title: z.string(), rationale: z.string(), spec: z.string() })).max(3),
});
export type AnalyzeOutput = z.infer<typeof analyzeZ>;
export type NewItem = AnalyzeOutput['new_items'][number];

const str = { type: 'string' };
const obj = (required: string[], properties: Record<string, unknown>) => ({ type: 'object', required, properties });

export const analyzeJsonSchema: JSONSchema = obj(['diagnosis', 'tag_weights', 'new_items', 'tips_ja', 'feature_requests'], {
  diagnosis: { type: 'array', maxItems: 5, items: obj(['tag', 'hypothesis_ja', 'evidence'], { tag: str, hypothesis_ja: str, evidence: str }) },
  tag_weights: { type: 'array', maxItems: 10, items: obj(['tag', 'w'], { tag: str, w: { type: 'number', minimum: 0.5, maximum: 3 } }) },
  new_items: {
    type: 'array', maxItems: 20,
    items: obj(['sentence_ru', 'lemma', 'feat', 'answer', 'translation_ja', 'explain_ja'], {
      sentence_ru: str, lemma: str, feat: str, answer: str, translation_ja: str, explain_ja: str,
    }),
  },
  tips_ja: str,
  feature_requests: { type: 'array', maxItems: 3, items: obj(['title', 'rationale', 'spec'], { title: str, rationale: str, spec: str }) },
});

// ---------- gloss ----------

export const glossZ = z.object({ items: z.array(z.object({ id: z.string(), ja: z.string() })) });
export type GlossOutput = z.infer<typeof glossZ>;
export const glossJsonSchema: JSONSchema = obj(['items'], { items: { type: 'array', items: obj(['id', 'ja'], { id: str, ja: str }) } });

// ---------- note ----------

export const noteZ = z.object({ title: z.string(), body_md: z.string() });
export type NoteOutput = z.infer<typeof noteZ>;
export const noteJsonSchema: JSONSchema = obj(['title', 'body_md'], { title: str, body_md: str });

// ---------- explain ----------

export const explainZ = z.object({ explain_ja: z.string() });
export type ExplainOutput = z.infer<typeof explainZ>;
export const explainJsonSchema: JSONSchema = obj(['explain_ja'], { explain_ja: str });

// ---------- aspect_items (A5 / T10) ----------

export const aspectItemsZ = z.object({
  items: z.array(z.object({
    sentence_ru: z.string(), impf: z.string(), pf: z.string(), correct: z.union([z.literal('impf'), z.literal('pf')]),
    feat: z.string(), answer: z.string(), translation_ja: z.string(), cue_ja: z.string().max(60),
  })).max(20),
});
export type AspectItemsOutput = z.infer<typeof aspectItemsZ>;
export type AspectItem = AspectItemsOutput['items'][number];
export const aspectItemsJsonSchema: JSONSchema = obj(['items'], {
  items: {
    type: 'array', maxItems: 20,
    items: obj(['sentence_ru', 'impf', 'pf', 'correct', 'feat', 'answer', 'translation_ja', 'cue_ja'], {
      sentence_ru: str, impf: str, pf: str, correct: { type: 'string', enum: ['impf', 'pf'] },
      feat: str, answer: str, translation_ja: str, cue_ja: { type: 'string', maxLength: 60 },
    }),
  },
});

// ---------- grade_t7 (M7) ----------

export const gradeT7Z = z.object({
  results: z.array(z.object({
    attemptId: z.number(), score: z.union([z.literal(0), z.literal(0.5), z.literal(1)]), corrected: z.string(), comment_ja: z.string(),
  })),
});
export const gradeT7JsonSchema: JSONSchema = obj(['results'], {
  results: {
    type: 'array',
    items: obj(['attemptId', 'score', 'corrected', 'comment_ja'], {
      attemptId: { type: 'number' }, score: { type: 'number', enum: [0, 0.5, 1] }, corrected: str, comment_ja: str,
    }),
  },
});

export const ZOD_BY_TASK: Record<AITask, z.ZodType> = {
  analyze: analyzeZ, gloss: glossZ, note: noteZ, explain: explainZ, grade_t7: gradeT7Z, aspect_items: aspectItemsZ,
};
export const JSON_SCHEMA_BY_TASK: Record<AITask, JSONSchema> = {
  analyze: analyzeJsonSchema, gloss: glossJsonSchema, note: noteJsonSchema, explain: explainJsonSchema, grade_t7: gradeT7JsonSchema,
  aspect_items: aspectItemsJsonSchema,
};
