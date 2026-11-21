import { analyzeStress, normalize } from './normalize';
import { PSEUDO_FEATS, verbStems } from './tags';
import type { AnswerClass, Confusion, FeatKey, Form, ItemType, Lemma, RatingNum } from './types';

export type ClassifyInput = {
  given: string;
  expected: Form;
  /** Needed for wrong_form detection (T3 / T4). */
  lemma?: Lemma;
  feat?: FeatKey;
  /** Aspect partners of `lemma` (A3 wrong_aspect). */
  partners?: readonly Lemma[];
  yoLenient?: boolean;
};

export type ClassifyResult = {
  class: AnswerClass;
  confusion?: Confusion;
  /** spelling_rule only: spell.y_i | spell.o_e | spell.a_ya */
  tag?: string;
};

function candidates(f: Form): string[] {
  return [f.primary, ...f.variants];
}

/** Damerau-Levenshtein (optimal string alignment) distance. */
export function damerauLevenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array<number>(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[m]![n]!;
}

const pairIs = (x: string, y: string, a: string, b: string) => (x === a && y === b) || (x === b && y === a);

/** Returns the spelling-rule tag when `given` differs from `expectedRaw` by one rule-governed substitution. */
export function spellingRuleTag(given: string, expectedRaw: string, yoLenient: boolean): string | null {
  const { norm: e, stressed } = analyzeStress(expectedRaw, { yoLenient });
  if (given.length !== e.length) return null;
  let pos = -1;
  for (let i = 0; i < e.length; i++) {
    if (given[i] !== e[i]) {
      if (pos >= 0) return null;
      pos = i;
    }
  }
  if (pos < 1) return null;
  const prev = e[pos - 1]!;
  const x = e[pos]!;
  const y = given[pos]!;
  if ('гкхжшщч'.includes(prev) && pairIs(x, y, 'и', 'ы')) return 'spell.y_i';
  if ('жшщчц'.includes(prev) && pairIs(x, y, 'о', 'е') && !stressed.has(pos)) return 'spell.o_e';
  if ('гкхжшщчц'.includes(prev) && (pairIs(x, y, 'а', 'я') || pairIs(x, y, 'у', 'ю'))) return 'spell.a_ya';
  return null;
}

/** Spec section 7: first matching rule wins. */
export function classify(input: ClassifyInput): ClassifyResult {
  const yoLenient = input.yoLenient ?? true;
  const opts = { yoLenient };
  const given = normalize(input.given, opts);
  const cands = candidates(input.expected);

  // 1. correct
  if (cands.some((c) => normalize(c, opts) === given)) return { class: 'correct' };

  // 2. orthographic: only stress marks / ё-е differ (reachable when yoLenient is false)
  const loose = normalize(input.given, { yoLenient: true });
  if (cands.some((c) => normalize(c, { yoLenient: true }) === loose)) return { class: 'orthographic' };

  // 3. wrong_form: another form of the same lemma
  if (input.lemma && input.feat) {
    for (const [feat, form] of Object.entries(input.lemma.forms)) {
      if (feat === input.feat || PSEUDO_FEATS.includes(feat)) continue;
      if (candidates(form).some((c) => normalize(c, opts) === given)) {
        return { class: 'wrong_form', confusion: { expected: input.feat, given: feat } };
      }
    }
  }

  // 3.5 wrong_aspect: the answer is the partner verb (infinitive for T2, the same form for T3 / T4)
  if (input.lemma?.aspect && input.partners && input.partners.length > 0) {
    for (const p of input.partners) {
      if (!p.aspect || p.aspect === input.lemma.aspect) continue;
      const hit = input.feat
        ? (() => { const f = p.forms[input.feat!]; return f ? candidates(f).some((c) => normalize(c, opts) === given) : false; })()
        : normalize(p.bare, opts) === given;
      if (hit) return { class: 'wrong_aspect', confusion: { expected: input.lemma.aspect, given: p.aspect }, tag: 'verb.aspect.pair' };
    }
  }

  // 3.6 no_alternation: the stem's consonant alternation was not applied (B1).
  const alt = input.lemma?.alt;
  if (alt && input.lemma && input.feat?.startsWith('pres') && (alt.scope === 'all' || input.feat === 'pres.1sg')) {
    const stems = verbStems(input.lemma);
    const expected = normalize(input.expected.primary, opts);
    if (stems && stems.pres1 && expected.startsWith(stems.pres1)) {
      const c = expected.slice(0, stems.pres1.length - alt.to.length) + alt.from + expected.slice(stems.pres1.length);
      if (given === c) return { class: 'no_alternation', tag: 'verb.pres.alt' };
      if (input.feat === 'pres.1sg') {
        const swapped = c.endsWith('у') ? `${c.slice(0, -1)}ю` : c.endsWith('ю') ? `${c.slice(0, -1)}у` : '';
        if (swapped && given === swapped) return { class: 'no_alternation', tag: 'verb.pres.alt' };
      }
    }
    if (stems && stems.infFull.length > 0 && given.startsWith(stems.infFull) && !expected.startsWith(stems.infFull)) {
      return { class: 'no_alternation', tag: 'verb.pres.alt' };
    }
  }

  // 4. spelling_rule
  for (const c of cands) {
    const tag = spellingRuleTag(given, c, yoLenient);
    if (tag) return { class: 'spelling_rule', tag };
  }

  // 5. typo
  for (const c of cands) {
    const e = normalize(c, opts);
    if (e.length >= 4 && damerauLevenshtein(given, e) === 1) return { class: 'typo' };
  }

  return { class: 'wrong' };
}

export const LATENCY_LIMIT_MS: Record<ItemType, number> = {
  T1: 6000, T2: 15000, T3: 15000, T4: 15000, T5: 15000, T6: 40000, T10: 15000, T11: 15000,
};

export function isCorrectClass(c: AnswerClass): boolean {
  return c === 'correct' || c === 'orthographic';
}

/** Map a classification to the default FSRS rating (1 Again, 2 Hard, 3 Good). */
export function ratingFor(args: { class: AnswerClass; type: ItemType; hintUsed: boolean; latencyMs: number }): RatingNum {
  switch (args.class) {
    case 'wrong':
    case 'wrong_form':
    case 'wrong_aspect':
    case 'no_alternation':
    case 'spelling_rule':
      return 1;
    case 'typo':
      return args.type === 'T2' ? 1 : 2;
    case 'correct':
    case 'orthographic':
      return args.hintUsed || args.latencyMs > LATENCY_LIMIT_MS[args.type] ? 2 : 3;
  }
}

export const CLASS_JA: Record<AnswerClass, string> = {
  correct: '正解',
  orthographic: '正解（ё/е・アクセント表記の違い）',
  wrong_form: '別の語形',
  wrong_aspect: '体の取り違え',
  no_alternation: '子音交替の誤り',
  spelling_rule: '綴りの規則ミス',
  typo: 'タイプミス',
  wrong: '不正解',
};
