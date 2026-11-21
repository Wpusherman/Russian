import { describe, expect, it } from 'vitest';
import { classify, damerauLevenshtein, ratingFor } from '../src/core/classify';
import { isUncertainGloss } from '../src/core/grade';
import { normalize } from '../src/core/normalize';
import { confusionCounts, DAY_MS, tagStats, wilsonLB } from '../src/core/stats';
import { expandTagPattern, tagsForFeat, verbConjType, confusionLabelJa } from '../src/core/tags';
import { TRANSLIT_TABLE, translit, translitLive } from '../src/core/translit';
import { mergeGloss, parseWordlistText } from '../src/core/wordlist';
import type { Attempt, Form, Lemma } from '../src/core/types';
import { convertAccent, splitForms } from '../scripts/build-dict';

const form = (primary: string, ...variants: string[]): Form => ({ primary, variants });

const kniga: Lemma = {
  id: 'n-книга', bare: 'книга', accented: 'кни\u0301га', pos: 'noun', rank: 59, level: 'A1', gender: 'f', animate: false,
  glossEn: ['book'],
  forms: {
    'case.nom.sg': form('кни\u0301га'), 'case.gen.sg': form('кни\u0301ги'), 'case.dat.sg': form('кни\u0301ге'),
    'case.acc.sg': form('кни\u0301гу'), 'case.ins.sg': form('кни\u0301гой', 'кни\u0301гою'), 'case.prep.sg': form('кни\u0301ге'),
    'case.nom.pl': form('кни\u0301ги'), 'case.gen.pl': form('кни\u0301г'), 'case.dat.pl': form('кни\u0301гам'),
    'case.acc.pl': form('кни\u0301ги'), 'case.ins.pl': form('кни\u0301гами'), 'case.prep.pl': form('кни\u0301гах'),
  },
};
const govorit: Lemma = {
  id: 'v-говорить', bare: 'говорить', accented: 'говори\u0301ть', pos: 'verb', rank: 5, level: 'A1', aspect: 'impf', glossEn: ['speak'],
  forms: {
    'pres.1sg': form('говорю\u0301'), 'pres.2sg': form('говори\u0301шь'), 'pres.3sg': form('говори\u0301т'),
    'pres.1pl': form('говори\u0301м'), 'pres.2pl': form('говори\u0301те'), 'pres.3pl': form('говоря\u0301т'),
    'past.m': form('говори\u0301л'), 'past.f': form('говори\u0301ла'),
  },
};

describe('normalize', () => {
  it('strips stress, case, spaces and trailing punctuation', () => {
    expect(normalize('  Кни\u0301га  ')).toBe('книга');
    expect(normalize('Я  чита\u0301ю   книгу.')).toBe('я читаю книгу');
    expect(normalize('Что это?!')).toBe('что это');
    expect(normalize('да…')).toBe('да');
  });
  it('folds ё only when yoLenient', () => {
    expect(normalize('Ёлка')).toBe('елка');
    expect(normalize('Ёлка', { yoLenient: false })).toBe('ёлка');
  });
  it('handles decomposed input (NFC)', () => {
    expect(normalize('и\u0306')).toBe('й');
    expect(normalize('е\u0308', { yoLenient: false })).toBe('ё');
  });
});

describe('translit', () => {
  it('converts every rule in the table', () => {
    const expected: Record<string, string> = {
      shch: 'щ', yo: 'ё', yu: 'ю', ya: 'я', ye: 'е', zh: 'ж', kh: 'х', ts: 'ц', ch: 'ч', sh: 'ш', eh: 'э',
      a: 'а', b: 'б', v: 'в', g: 'г', d: 'д', e: 'е', z: 'з', i: 'и', j: 'й', k: 'к', l: 'л', m: 'м', n: 'н',
      o: 'о', p: 'п', r: 'р', s: 'с', t: 'т', u: 'у', f: 'ф', h: 'х', x: 'х', c: 'ц', w: 'щ', y: 'ы', q: 'я',
      "'": 'ь', '#': 'ъ',
    };
    expect(Object.keys(TRANSLIT_TABLE).sort()).toEqual(Object.keys(expected).sort());
    for (const [lat, cyr] of Object.entries(expected)) expect(translit(lat), lat).toBe(cyr);
  });
  it('uses the longest match, left to right', () => {
    expect(translit('shchi')).toBe('щи');
    expect(translit('khorosho')).toBe('хорошо');
    expect(translit('zhizn\'')).toBe('жизнь');
    expect(translit('ob#yavlenie')).toBe('объявление');
    expect(translit('tsyeh')).toBe('цех'); // ts + ye + h
    expect(translit('ehto')).toBe('это');
    expect(translit('yozh')).toBe('ёж');
  });
  it('treats "/" as a separator that disappears', () => {
    expect(translit('ot/syuda')).toBe('отсюда');
    expect(translit('otsyuda')).toBe('оцюда');
    expect(translit('s/hodit\'')).toBe('сходить');
    expect(translit('shodit\'')).toBe('шодить');
    expect(translit('vy/uchit\'')).toBe('выучить');
  });
  it('keeps upper case', () => {
    expect(translit('Moskva')).toBe('Москва');
    expect(translit('Shchuka')).toBe('Щука');
    expect(translit('Ya')).toBe('Я');
    expect(translit('YA')).toBe('Я');
  });
  it('passes through Cyrillic, digits and punctuation', () => {
    expect(translit('привет, mir 123!')).toBe('привет, мир 123!');
  });
  it('keeps an ambiguous trailing token pending in live mode', () => {
    expect(translitLive('s')).toEqual({ done: '', pending: 's' });
    expect(translitLive('pis')).toEqual({ done: 'пи', pending: 's' });
    expect(translitLive('sh')).toEqual({ done: '', pending: 'sh' });
    expect(translitLive('shc')).toEqual({ done: '', pending: 'shc' });
    expect(translitLive('shch')).toEqual({ done: 'щ', pending: '' });
    expect(translitLive('sha')).toEqual({ done: 'ша', pending: '' });
    expect(translitLive('y')).toEqual({ done: '', pending: 'y' });
    expect(translitLive('ya')).toEqual({ done: 'я', pending: '' });
    expect(translitLive('s/')).toEqual({ done: 'с', pending: '' });
    expect(translitLive('ma')).toEqual({ done: 'ма', pending: '' });
  });
});

describe('classify', () => {
  it('correct', () => {
    expect(classify({ given: 'книге', expected: form('кни\u0301ге') }).class).toBe('correct');
    expect(classify({ given: ' Книгою. ', expected: form('кни\u0301гой', 'кни\u0301гою') }).class).toBe('correct');
    expect(classify({ given: 'еж', expected: form('ёж') }).class).toBe('correct'); // yoLenient default
  });
  it('orthographic', () => {
    expect(classify({ given: 'еж', expected: form('ёж'), yoLenient: false }).class).toBe('orthographic');
    expect(classify({ given: 'ёлка', expected: form('елка'), yoLenient: false }).class).toBe('orthographic');
    expect(classify({ given: 'идет', expected: form('идёт'), yoLenient: false }).class).toBe('orthographic');
  });
  it('wrong_form with confusion', () => {
    const r = classify({ given: 'книгу', expected: kniga.forms['case.prep.sg']!, lemma: kniga, feat: 'case.prep.sg' });
    expect(r).toEqual({ class: 'wrong_form', confusion: { expected: 'case.prep.sg', given: 'case.acc.sg' } });
    const r2 = classify({ given: 'говорит', expected: govorit.forms['pres.3pl']!, lemma: govorit, feat: 'pres.3pl' });
    expect(r2).toEqual({ class: 'wrong_form', confusion: { expected: 'pres.3pl', given: 'pres.3sg' } });
  });
  it('spelling_rule', () => {
    // и/ы after г к х ж ш щ ч
    expect(classify({ given: 'книгы', expected: form('кни\u0301ги') })).toEqual({ class: 'spelling_rule', tag: 'spell.y_i' });
    expect(classify({ given: 'ножы', expected: form('ножи\u0301') })).toEqual({ class: 'spelling_rule', tag: 'spell.y_i' });
    // unstressed о/е after ж ш щ ч ц
    expect(classify({ given: 'хорошого', expected: form('хоро\u0301шего') })).toEqual({ class: 'spelling_rule', tag: 'spell.o_e' });
    expect(classify({ given: 'мужом', expected: form('му\u0301жем') })).toEqual({ class: 'spelling_rule', tag: 'spell.o_e' });
    // а/я, у/ю after hushers, velars and ц
    expect(classify({ given: 'учю', expected: form('учу\u0301') })).toEqual({ class: 'spelling_rule', tag: 'spell.a_ya' });
    expect(classify({ given: 'слышят', expected: form('слы\u0301шат') })).toEqual({ class: 'spelling_rule', tag: 'spell.a_ya' });
  });
  it('does not apply the о/е rule to a stressed vowel', () => {
    // stressed о after ж: not a rule error -> falls through to typo (length >= 4)
    expect(classify({ given: 'ножем', expected: form('ножо\u0301м') }).class).toBe('typo');
  });
  it('wrong_form wins over spelling_rule and typo', () => {
    expect(classify({ given: 'книгам', expected: kniga.forms['case.ins.pl']!, lemma: kniga, feat: 'case.ins.pl' }).class).toBe('wrong_form');
  });
  it('typo (distance 1, length >= 4)', () => {
    expect(classify({ given: 'кинга', expected: form('кни\u0301га') }).class).toBe('typo'); // transposition
    expect(classify({ given: 'книа', expected: form('кни\u0301га') }).class).toBe('typo'); // deletion
    expect(classify({ given: 'говорритт', expected: form('говори\u0301т') }).class).toBe('wrong'); // distance 2
  });
  it('wrong', () => {
    expect(classify({ given: 'дим', expected: form('дом') }).class).toBe('wrong'); // length < 4
    expect(classify({ given: 'стол', expected: form('кни\u0301га') }).class).toBe('wrong');
    expect(classify({ given: '', expected: form('кни\u0301га') }).class).toBe('wrong');
  });
  it('Damerau-Levenshtein', () => {
    expect(damerauLevenshtein('абв', 'абв')).toBe(0);
    expect(damerauLevenshtein('абв', 'бав')).toBe(1);
    expect(damerauLevenshtein('абв', 'аб')).toBe(1);
    expect(damerauLevenshtein('абв', 'где')).toBe(3);
  });
});

describe('ratingFor', () => {
  const base = { hintUsed: false, latencyMs: 1000 };
  it('maps classes to FSRS ratings', () => {
    expect(ratingFor({ ...base, class: 'wrong', type: 'T3' })).toBe(1);
    expect(ratingFor({ ...base, class: 'wrong_form', type: 'T3' })).toBe(1);
    expect(ratingFor({ ...base, class: 'spelling_rule', type: 'T3' })).toBe(1);
    expect(ratingFor({ ...base, class: 'typo', type: 'T2' })).toBe(1);
    expect(ratingFor({ ...base, class: 'typo', type: 'T3' })).toBe(2);
    expect(ratingFor({ ...base, class: 'correct', type: 'T3' })).toBe(3);
    expect(ratingFor({ ...base, class: 'orthographic', type: 'T2' })).toBe(3);
  });
  it('caps at Hard with hints or slow answers', () => {
    expect(ratingFor({ class: 'correct', type: 'T2', hintUsed: true, latencyMs: 1000 })).toBe(2);
    expect(ratingFor({ class: 'correct', type: 'T1', hintUsed: false, latencyMs: 6001 })).toBe(2);
    expect(ratingFor({ class: 'correct', type: 'T1', hintUsed: false, latencyMs: 6000 })).toBe(3);
    expect(ratingFor({ class: 'correct', type: 'T3', hintUsed: false, latencyMs: 15001 })).toBe(2);
    expect(ratingFor({ class: 'correct', type: 'T6', hintUsed: false, latencyMs: 39000 })).toBe(3);
    expect(ratingFor({ class: 'correct', type: 'T6', hintUsed: false, latencyMs: 40001 })).toBe(2);
  });
});

describe('stats', () => {
  it('Wilson lower bound known values', () => {
    expect(Math.abs(wilsonLB(8, 10) - 0.49)).toBeLessThanOrEqual(0.001);
    expect(wilsonLB(0, 0)).toBe(0);
    expect(wilsonLB(0, 10)).toBeCloseTo(0, 6);
    expect(wilsonLB(10, 10)).toBeCloseTo(0.7225, 3);
    expect(wilsonLB(50, 100)).toBeCloseTo(0.4038, 3);
  });
  const now = Date.UTC(2026, 5, 30);
  const att = (daysAgo: number, cls: Attempt['class'], tags: string[], confusion?: Attempt['confusion']) =>
    ({ ts: now - daysAgo * DAY_MS, class: cls, tags, confusion });
  it('counts n / k per tag within 30 days; orthographic counts as correct', () => {
    const s = tagStats([
      att(1, 'correct', ['noun.gen.sg']), att(2, 'orthographic', ['noun.gen.sg']), att(3, 'typo', ['noun.gen.sg', 'vocab']),
      att(31, 'correct', ['noun.gen.sg']),
    ], now);
    expect(s.get('noun.gen.sg')).toMatchObject({ n: 3, k: 2 });
    expect(s.get('vocab')).toMatchObject({ n: 1, k: 0 });
    expect(s.get('noun.gen.sg')!.weakness).toBeCloseTo(1 - wilsonLB(2, 3), 10);
  });
  it('trend = last 7 days minus days 8-30, 0 when either side has n < 5', () => {
    const recent = [0, 1, 2, 3, 4].map((d) => att(d, 'correct', ['t']));
    const old = [10, 11, 12, 13, 14].map((d, i) => att(d, i < 2 ? 'correct' : 'wrong', ['t']));
    expect(tagStats([...recent, ...old], now).get('t')!.trend).toBeCloseTo(1 - 0.4, 10);
    expect(tagStats([...recent, ...old.slice(0, 4)], now).get('t')!.trend).toBe(0);
  });
  it('counts confusions', () => {
    const c = { expected: 'case.prep.sg', given: 'case.acc.sg' };
    const r = confusionCounts([
      att(1, 'wrong_form', [], c), att(2, 'wrong_form', [], c), att(3, 'wrong_form', [], { expected: 'a', given: 'b' }),
      att(40, 'wrong_form', [], c), att(1, 'wrong', []),
    ], now);
    expect(r[0]).toEqual({ ...c, n: 2 });
    expect(r).toHaveLength(2);
  });
});

describe('tags', () => {
  it('derives T3 tags from the FeatKey', () => {
    expect(tagsForFeat(kniga, 'case.gen.pl')).toEqual(['noun.gen.pl']);
    expect(tagsForFeat(kniga, 'case.gen.sg')).toEqual(['noun.gen.sg', 'spell.y_i']);
    expect(tagsForFeat(kniga, 'gender')).toEqual(['noun.gender']);
    expect(tagsForFeat(govorit, 'pres.1sg')).toEqual(['verb.pres.conj2']);
    expect(tagsForFeat(govorit, 'past.f')).toEqual(['verb.past']);
  });
  it('detects the conjugation type from pres.2sg', () => {
    expect(verbConjType(govorit)).toBe('conj2');
    const mk = (f: string): Lemma => ({ ...govorit, forms: { 'pres.2sg': form(f) } });
    expect(verbConjType(mk('чита\u0301ешь'))).toBe('conj1');
    expect(verbConjType(mk('идёшь'))).toBe('conj1');
    expect(verbConjType(mk('занима\u0301ешься'))).toBe('conj1');
    expect(verbConjType(mk('ешь'))).toBe('conj1');
    expect(verbConjType(mk('да\u0301шь'))).toBe('irreg');
    expect(verbConjType({ ...govorit, forms: {} })).toBe('irreg');
  });
  it('expands unit patterns', () => {
    expect(expandTagPattern('spell.*')).toEqual(['spell.y_i', 'spell.o_e', 'spell.a_ya']);
    expect(expandTagPattern('noun.*.pl')).toHaveLength(6);
    expect(expandTagPattern('adj.nom.*')).toEqual(['adj.nom.m', 'adj.nom.f', 'adj.nom.n', 'adj.nom.pl']);
  });
  it('labels confusions in Japanese', () => {
    expect(confusionLabelJa('case.prep.sg', 'case.acc.sg')).toBe('対格と前置格を取り違え');
  });
});

describe('uncertain gloss', () => {
  it('detects a trailing "?" written by the AI', () => {
    expect(isUncertainGloss('本?')).toBe(true);
    expect(isUncertainGloss('本？ ')).toBe(true);
    expect(isUncertainGloss('本')).toBe(false);
    expect(isUncertainGloss('?本')).toBe(false);
  });
});

describe('wordlist gloss merge', () => {
  it('mergeGloss appends new meanings, numbered from two on', () => {
    expect(mergeGloss('', 'ランプ')).toBe('ランプ'); // first gloss stays unnumbered (AI format too)
    expect(mergeGloss('ランプ', '電灯')).toBe('1. ランプ 2. 電灯');
    expect(mergeGloss('1. ランプ 2. 電灯', '照明')).toBe('1. ランプ 2. 電灯 3. 照明');
    expect(mergeGloss('1. ランプ 2. 電灯', '電灯')).toBe('1. ランプ 2. 電灯'); // same meaning: no duplicate
    expect(mergeGloss('ランプ、電灯', '照明')).toBe('1. ランプ 2. 電灯 3. 照明'); // existing "、" format is renumbered
    expect(mergeGloss('ランプ', '')).toBe('ランプ');
    expect(mergeGloss('本、書物', 'ほん')).toBe('1. 本 2. 書物 3. ほん'); // exact-match dedupe only
  });
  it('parseWordlistText appends the gloss of duplicate words instead of dropping them', () => {
    expect(parseWordlistText('лампа\tランプ\nлампа\t電灯\nлампа')).toEqual([{ word: 'лампа', glossJa: '1. ランプ 2. 電灯' }]);
    expect(parseWordlistText('книга\tほん\nкнига,本\nчитать')).toEqual([
      { word: 'книга', glossJa: '1. ほん 2. 本' },
      { word: 'читать' },
    ]);
    expect(parseWordlistText('слово\n\nСЛОВО\t意味')).toEqual([{ word: 'слово', glossJa: '意味' }]);
  });
  it('parseWordlistText keeps phrases and extracts the +case annotation', () => {
    expect(parseWordlistText('сесть на +対\t乗る')).toEqual([{ word: 'сесть на', hint: '+対', glossJa: '乗る' }]);
    expect(parseWordlistText('просить +対,頼む')).toEqual([{ word: 'просить', hint: '+対', glossJa: '頼む' }]);
    expect(parseWordlistText('только +複')).toEqual([{ word: 'только', hint: '+複' }]);
    expect(parseWordlistText('нет +属')).toEqual([{ word: 'нет', hint: '+生' }]); // 属 is normalised to 生
    expect(parseWordlistText('пользоваться +具')).toEqual([{ word: 'пользоваться', hint: '+造' }]); // 具 -> 造
    expect(parseWordlistText('нет +生 +属')).toEqual([{ word: 'нет', hint: '+生' }]); // same case after normalisation
    expect(parseWordlistText('играть в +対 +前\t…について遊ぶ')).toEqual([
      { word: 'играть в', hint: '+対+前', glossJa: '…について遊ぶ' },
    ]);
    expect(parseWordlistText('играть')).toEqual([{ word: 'играть' }]);
    expect(parseWordlistText('+対\tonly')).toEqual([]); // an annotation alone is not a word
  });
});

describe('build-dict helpers', () => {
  it("converts the apostrophe accent notation", () => {
    expect(convertAccent("челове'к")).toBe('челове\u0301к');
    expect(convertAccent("моё'")).toBe('моё');
    expect(convertAccent('год')).toBe('год');
  });
  it('splits multi-form cells', () => {
    expect(splitForms("рабо'той,  рабо'тою")).toEqual({ primary: 'рабо\u0301той', variants: ['рабо\u0301тою'] });
    expect(splitForms("*све'ты")).toEqual({ primary: 'све\u0301ты', variants: [] });
    expect(splitForms("то'т; того' (anim.)")).toEqual({ primary: 'то\u0301т', variants: ['того\u0301'] });
    expect(splitForms('  ')).toBeNull();
  });
});
