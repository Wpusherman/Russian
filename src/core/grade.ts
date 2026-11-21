import { classify, damerauLevenshtein } from './classify';
import { normalize, normalizeSentence, stripAccent } from './normalize';
import { featLabelJa } from './tags';
import type { AnswerClass, Confusion, FeatKey, Form, Lemma } from './types';

type Base = { itemId: string; lemmaId: string; tags: string[] };

export type QuestionT1 = Base & { type: 'T1'; lemma: Lemma; options: string[]; correct: number; hint?: string };
export type QuestionT2 = Base & { type: 'T2'; lemma: Lemma; gloss: string; expected: Form; hint?: string; partners?: Lemma[]; note?: string };
export type QuestionT3 = Base & { type: 'T3'; lemma: Lemma; feat: FeatKey; gloss: string; expected: Form; partners?: Lemma[]; /** No card history yet: show the alternation card even when correct (B1). */ first?: boolean };
export type QuestionT4 = Base & {
  type: 'T4'; lemma: Lemma; feat: FeatKey; sentence: string; translation: string; explain: string; expected: Form; partners?: Lemma[];
};
export type QuestionT5 = Base & { type: 'T5'; lemma: Lemma; gloss: string; word: string; stressed: number[] };
export type QuestionT6 = Base & { type: 'T6'; sentence: string; translation: string };
export type QuestionT10 = Base & {
  type: 'T10'; lemma: Lemma; feat: FeatKey; sentence: string; translation: string; cue: string; impf: string; pf: string;
  expected: Form; partners?: Lemma[];
};
export type QuestionT9 = Base & {
  type: 'T9'; adjective: Lemma; noun: Lemma; nounForm: Form; feat: FeatKey; expected: Form;
};
export type QuestionT11 = Base & { type: 'T11'; lemma: Lemma; num: number; expected: Form };
export type Question = QuestionT1 | QuestionT2 | QuestionT3 | QuestionT4 | QuestionT5 | QuestionT6 | QuestionT9 | QuestionT10 | QuestionT11;

export type Answer = { kind: 'choice'; index: number } | { kind: 'text'; text: string } | { kind: 'stress'; index: number };

export type Graded = {
  class: AnswerClass;
  confusion?: Confusion;
  /** Question tags plus the spelling-rule tag when one was violated. */
  tags: string[];
  given: string;
  /** Correct answer for display (with stress marks). */
  expected: string;
  /** Short prompt description stored with the attempt (used in AI samples). */
  prompt: string;
  /** B5: set only when the answer contained an accent mark (true = position matches). */
  stressOk?: boolean;
};

/** Display gloss: glossJa if present, otherwise the first two English glosses. */
export function glossOf(lemma: Pick<Lemma, 'glossJa' | 'glossEn'>): string {
  if (lemma.glossJa) return lemma.glossJa;
  return lemma.glossEn.slice(0, 2).join(', ');
}

/** A2: when a verb and its aspect partner share the same display gloss, show the aspect nuance. */
export function aspectNote(lemma: Pick<Lemma, 'aspect' | 'glossJa' | 'glossEn'>, partners: readonly Lemma[]): string | null {
  if (!lemma.aspect || lemma.aspect === 'both' || partners.length === 0) return null;
  const key = (g: string) => normalize(g).replace(/[?？]$/, '');
  const own = key(glossOf(lemma));
  if (!own) return null;
  if (!partners.some((p) => key(glossOf(p)) === own)) return null;
  return lemma.aspect === 'impf' ? '（過程・反復）' : '（1回・完了）';
}

/** An AI gloss marked as uncertain by a trailing "?" (shown in a lighter colour). */
export function isUncertainGloss(gloss: string): boolean {
  return /[?？]$/.test(gloss.trim());
}

/** B5: compare typed stress positions with the expected ones (undefined when nothing was typed). */
export function typedStressOk(given: string, expected: string): boolean | undefined {
  if (!given.includes('́')) return undefined;
  return stressInfo(given).stressed.join(',') === stressInfo(expected).stressed.join(',');
}

/** Word without stress marks plus the indexes of its stressed characters (ё counts as stressed). */
export function stressInfo(accented: string): { word: string; stressed: number[] } {
  let word = '';
  const stressed: number[] = [];
  for (const ch of accented.normalize('NFC')) {
    if (ch === '\u0301') {
      if (word.length > 0) stressed.push(word.length - 1);
    } else if (ch === '\u0300') {
      continue;
    } else {
      if (ch === 'ё' || ch === 'Ё') stressed.push(word.length);
      word += ch;
    }
  }
  return { word, stressed: [...new Set(stressed)] };
}

export function fillBlank(sentence: string, answer: string): string {
  return sentence.replace('___', stripAccent(answer));
}

/** First `count` letters of the answer (hint for T2 / T3). */
export function hintText(expected: Form, count: number): string {
  return stripAccent(expected.primary).slice(0, count);
}

function withTag(tags: string[], tag?: string): string[] {
  return tag && !tags.includes(tag) ? [...tags, tag] : tags;
}

export function grade(q: Question, a: Answer, opts: { yoLenient: boolean }): Graded {
  switch (q.type) {
    case 'T1': {
      const idx = a.kind === 'choice' ? a.index : -1;
      return {
        class: idx === q.correct ? 'correct' : 'wrong', tags: q.tags, given: q.options[idx] ?? '',
        expected: q.options[q.correct] ?? '', prompt: stripAccent(q.lemma.accented),
      };
    }
    case 'T2': {
      const text = a.kind === 'text' ? a.text : '';
      const r = classify({ given: text, expected: q.expected, lemma: q.lemma, partners: q.partners, yoLenient: opts.yoLenient });
      const stressOk = typedStressOk(text, q.expected.primary);
      return {
        class: r.class, confusion: r.confusion, tags: withTag(q.tags, r.tag), given: text, expected: q.expected.primary, prompt: q.gloss,
        ...(stressOk !== undefined ? { stressOk } : {}),
      };
    }
    case 'T3':
    case 'T4':
    case 'T10': {
      const text = a.kind === 'text' ? a.text : '';
      const r = classify({ given: text, expected: q.expected, lemma: q.lemma, feat: q.feat, partners: q.partners, yoLenient: opts.yoLenient });
      const prompt = q.type === 'T3'
        ? `${q.lemma.bare} / ${q.feat.replace(/^case\./, '')}`
        : `${q.sentence} (${q.lemma.bare})`;
      const stressOk = q.type === 'T3' ? typedStressOk(text, q.expected.primary) : undefined;
      return {
        class: r.class, confusion: r.confusion, tags: withTag(q.tags, r.tag), given: text, expected: q.expected.primary, prompt,
        ...(stressOk !== undefined ? { stressOk } : {}),
      };
    }
    case 'T5': {
      const idx = a.kind === 'stress' ? a.index : -1;
      const mark = (i: number) => (i >= 0 && i < q.word.length ? q.word.slice(0, i + 1) + '\u0301' + q.word.slice(i + 1) : '');
      return {
        class: q.stressed.includes(idx) ? 'correct' : 'wrong', tags: q.tags, given: mark(idx),
        expected: q.lemma.accented, prompt: q.word,
      };
    }
    case 'T9': {
      const text = a.kind === 'text' ? a.text : '';
      const r = classify({ given: text, expected: q.expected, lemma: q.adjective, feat: q.feat, yoLenient: opts.yoLenient });
      return {
        class: r.class, confusion: r.confusion, tags: withTag(q.tags, r.tag), given: text, expected: q.expected.primary,
        prompt: `${q.adjective.bare} + ${q.noun.bare} / ${q.feat.replace(/^adj\./, '')}`,
      };
    }
    case 'T11': {
      const text = a.kind === 'text' ? a.text : '';
      const r = classify({ given: text, expected: q.expected, yoLenient: opts.yoLenient });
      return { class: r.class, tags: q.tags, given: text, expected: q.expected.primary, prompt: `${q.num} ${q.lemma.bare}` };
    }
    case 'T6': {
      const text = a.kind === 'text' ? a.text : '';
      const g = normalizeSentence(text, opts);
      const e = normalizeSentence(q.sentence, opts);
      let cls: AnswerClass;
      if (g === e) cls = 'correct';
      else if (normalizeSentence(text, { yoLenient: true }) === normalizeSentence(q.sentence, { yoLenient: true })) cls = 'orthographic';
      else if (damerauLevenshtein(g, e) === 1) cls = 'typo';
      else cls = 'wrong';
      return { class: cls, tags: q.tags, given: text, expected: q.sentence, prompt: '(dictation)' };
    }
  }
}

/** Japanese description of what is being asked (T3). */
export function targetLabel(q: QuestionT3 | QuestionT4): string {
  return featLabelJa(q.feat, q.lemma);
}
