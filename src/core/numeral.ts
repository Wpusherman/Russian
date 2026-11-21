import type { FeatKey, Form, Lemma } from './types';

/** Numbers used by the T11 numeral drill. */
export const T11_NUMBERS: readonly number[] = [
  ...Array.from({ length: 30 }, (_, i) => i + 1), 40, 50, 100, 1000,
];

export type NumeralCase = 'case.nom.sg' | 'case.gen.sg' | 'case.gen.pl';

/** Russian government: 1 (not 11) -> nom.sg, 2-4 (not 12-14) -> gen.sg, otherwise gen.pl. */
export function numeralCase(n: number): NumeralCase {
  const tens = n % 100;
  if (tens >= 11 && tens <= 14) return 'case.gen.pl';
  const ones = n % 10;
  if (ones === 1) return 'case.nom.sg';
  if (ones >= 2 && ones <= 4) return 'case.gen.sg';
  return 'case.gen.pl';
}

/** The numeral itself for 1 / 2 (agrees in gender). */
const NUMERAL_WORD: Record<1 | 2, Partial<Record<'m' | 'f' | 'n', string>>> = {
  1: { m: 'оди\u0301н', f: 'одна\u0301', n: 'одно\u0301' },
  2: { m: 'два\u0301', f: 'две', n: 'два\u0301' },
};

export function numeralWord(n: number, gender: Lemma['gender']): string | null {
  if (n !== 1 && n !== 2) return null;
  if (!gender || gender === 'pl') return null;
  return NUMERAL_WORD[n][gender] ?? null;
}

/** Expected answer for "n + noun": the noun form, with the numeral prefixed for 1 / 2. */
export function numeralExpected(lemma: Lemma, n: number): Form | null {
  const feat: FeatKey = numeralCase(n);
  const noun = lemma.forms[feat];
  if (!noun) return null;
  if (n !== 1 && n !== 2) return noun;
  const num = numeralWord(n, lemma.gender);
  if (!num) return null;
  return { primary: `${num} ${noun.primary}`, variants: noun.variants.map((v) => `${num} ${v}`) };
}

/** Nouns usable by the drill: A1-A2 with a genitive plural form. */
export function isNumeralEligible(lemma: Lemma): boolean {
  return lemma.pos === 'noun' && (lemma.level === 'A1' || lemma.level === 'A2') && !!lemma.forms['case.gen.pl'];
}

export function numeralPrompt(n: number, lemma: Lemma): string {
  return `${n} ___（${lemma.bare}）`;
}
