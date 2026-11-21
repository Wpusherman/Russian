import { describe, expect, it } from 'vitest';
import { grade } from '../src/core/grade';
import { isNumeralEligible, numeralCase, numeralExpected, numeralWord, T11_NUMBERS } from '../src/core/numeral';
import type { Form, Lemma } from '../src/core/types';

const f = (primary: string): Form => ({ primary, variants: [] });
const kniga: Lemma = {
  id: 'n-книга', bare: 'книга', accented: 'кни\u0301га', pos: 'noun', rank: 1, level: 'A1', gender: 'f', glossEn: ['book'],
  forms: {
    'case.nom.sg': f('кни\u0301га'), 'case.gen.sg': f('кни\u0301ги'), 'case.gen.pl': f('книг'),
  },
};
const unknown: Lemma = { ...kniga, id: 'n-х', gender: undefined, bare: 'х', level: 'A2' };

describe('numeral drill (T11)', () => {
  it('uses the 1 / 2-4 / other government rule, including the 11-14 exceptions', () => {
    expect(numeralCase(1)).toBe('case.nom.sg');
    expect(numeralCase(2)).toBe('case.gen.sg');
    expect(numeralCase(4)).toBe('case.gen.sg');
    expect(numeralCase(5)).toBe('case.gen.pl');
    expect(numeralCase(11)).toBe('case.gen.pl');
    expect(numeralCase(12)).toBe('case.gen.pl');
    expect(numeralCase(14)).toBe('case.gen.pl');
    expect(numeralCase(21)).toBe('case.nom.sg');
    expect(numeralCase(22)).toBe('case.gen.sg');
    expect(numeralCase(25)).toBe('case.gen.pl');
    expect(numeralCase(40)).toBe('case.gen.pl');
    expect(numeralCase(100)).toBe('case.gen.pl');
    expect(numeralCase(1000)).toBe('case.gen.pl');
    expect(T11_NUMBERS).toHaveLength(34);
    expect(T11_NUMBERS[0]).toBe(1);
    expect(T11_NUMBERS.at(-1)).toBe(1000);
  });

  it('agrees the numeral in gender for 1 and 2, and asks for the noun form otherwise', () => {
    expect(numeralExpected(kniga, 1)).toEqual({ primary: 'одна\u0301 кни\u0301га', variants: [] });
    expect(numeralExpected(kniga, 2)).toEqual({ primary: 'две кни\u0301ги', variants: [] });
    expect(numeralExpected(kniga, 5)).toEqual({ primary: 'книг', variants: [] });
    expect(numeralExpected(kniga, 21)).toEqual({ primary: 'кни\u0301га', variants: [] });
    expect(numeralExpected(kniga, 22)).toEqual({ primary: 'кни\u0301ги', variants: [] });
    expect(numeralExpected(kniga, 11)).toEqual({ primary: 'книг', variants: [] });
    expect(numeralWord(1, 'm')).toBe('оди\u0301н');
    expect(numeralWord(2, 'f')).toBe('две');
    expect(numeralWord(2, 'pl')).toBeNull();
    expect(numeralWord(5, 'm')).toBeNull();
  });

  it('never asks 1 / 2 for a noun whose gender is unknown', () => {
    expect(numeralExpected(unknown, 1)).toBeNull();
    expect(numeralExpected(unknown, 2)).toBeNull();
    expect(numeralExpected(unknown, 5)).toEqual({ primary: 'книг', variants: [] });
  });

  it('uses only A1-A2 nouns that have a genitive plural', () => {
    expect(isNumeralEligible(kniga)).toBe(true);
    expect(isNumeralEligible({ ...kniga, level: 'B1' })).toBe(false);
    expect(isNumeralEligible({ ...kniga, forms: { 'case.nom.sg': f('книга') } })).toBe(false);
    expect(isNumeralEligible({ ...kniga, pos: 'other' })).toBe(false);
  });

  it('grades T11 answers against the composed form', () => {
    const q = { type: 'T11' as const, itemId: 'T11:n-книга:5', lemmaId: kniga.id, tags: ['num.gov'], lemma: kniga, num: 5, expected: numeralExpected(kniga, 5)! };
    expect(grade(q, { kind: 'text', text: 'книг' }, { yoLenient: true })).toMatchObject({ class: 'correct', expected: 'книг' });
    expect(grade(q, { kind: 'text', text: 'книги' }, { yoLenient: true }).class).not.toBe('correct');
    const q1 = { ...q, num: 1, expected: numeralExpected(kniga, 1)! };
    expect(grade(q1, { kind: 'text', text: 'одна книга' }, { yoLenient: true }).class).toBe('correct');
    expect(grade(q1, { kind: 'text', text: 'книга' }, { yoLenient: true }).class).toBe('wrong'); // the numeral is required for 1 / 2
  });
});
