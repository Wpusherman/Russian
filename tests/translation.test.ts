import { describe, expect, it } from 'vitest';
import type { AIProvider } from '../src/ai/provider';
import type { GradeT7Output } from '../src/ai/schemas';
import { runGradeT7 } from '../src/ai/tasks';
import { buildTranslationSources, completedRussian } from '../src/core/translation';
import type { T4Payload } from '../src/db/db';

const payload = (p: Partial<T4Payload>): T4Payload => ({
  sentence_ru: 'Я живу в ___.', lemma: 'Москва', lemmaId: 'n-москва', feat: 'case.prep.sg', answer: 'Москве',
  translation_ja: '私はモスクワに住んでいます。', explain_ja: 'в＋前置格', ...p,
});

describe('T7 translation sources', () => {
  it('fills the blank, strips stress, and prefers AI items with natural Japanese', () => {
    expect(completedRussian('Я живу в ___.', 'Москве́')).toBe('Я живу в Москве.');
    expect(completedRussian('нет пропуска', 'Москве')).toBeNull();
    const items = [
      { id: 'T4:2', source: 'user' as const, payload: payload({ sentence_ru: 'сесть на ___', answer: 'стол', translation_ja: 'сесть на（+対）＋前置格' }) },
      { id: 'T4:1', source: 'ai' as const, payload: payload({}) },
    ];
    expect(buildTranslationSources(items, 5, () => 0)).toEqual([
      { itemId: 'T4:1', ja: '私はモスクワに住んでいます。', ru: 'Я живу в Москве.', lemma: 'Москва' },
    ]);
  });

  it('dedupes identical Japanese prompts and honours the limit', () => {
    const items = [
      { id: 'T4:1', source: 'ai' as const, payload: payload({}) },
      { id: 'T4:2', source: 'ai' as const, payload: payload({ sentence_ru: 'Он живёт в ___.', answer: 'Москве' }) },
      { id: 'T4:3', source: 'ai' as const, payload: payload({ translation_ja: 'これは本です。', sentence_ru: 'Это ___.', answer: 'книга' }) },
    ];
    expect(buildTranslationSources(items, 5, () => 0).map((s) => s.itemId)).toEqual(['T4:1', 'T4:3']);
    expect(buildTranslationSources(items, 1, () => 0)).toHaveLength(1);
  });
});

describe('runGradeT7', () => {
  const out: GradeT7Output = {
    results: [
      { attemptId: 0, score: 1, corrected: 'Я живу в Москве.', comment_ja: 'よい' },
      { attemptId: 9, score: 0, corrected: '', comment_ja: 'unknown id' },
      { attemptId: 0, score: 0.5, corrected: 'дубль', comment_ja: 'duplicate id' },
    ],
  };
  const provider: AIProvider = { run: async <T>() => out as T };

  it('keeps only known attempt ids once, in order', async () => {
    const r = await runGradeT7(provider, [{ attemptId: 0, ja: '私はモスクワに住んでいます。', given: 'Я живу в Москве.' }]);
    expect(r.results).toEqual([{ attemptId: 0, score: 1, corrected: 'Я живу в Москве.', comment_ja: 'よい' }]);
  });

  it('makes no AI call for an empty batch', async () => {
    let called = false;
    const p: AIProvider = { run: async <T>() => { called = true; return out as T; } };
    expect(await runGradeT7(p, [])).toEqual({ results: [] });
    expect(called).toBe(false);
  });
});
