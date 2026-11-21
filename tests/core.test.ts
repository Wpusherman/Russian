import { describe, expect, it } from 'vitest';
import { CLASS_JA, classify, damerauLevenshtein, ratingFor, reflexiveWarning } from '../src/core/classify';
import { aspectNote, isUncertainGloss, typedStressOk } from '../src/core/grade';
import { normalize } from '../src/core/normalize';
import { spellingViolations } from '../src/core/spelling';
import { applyAccentKey } from '../src/core/accent';
import { confusionCounts, DAY_MS, tagStats, wilsonLB } from '../src/core/stats';
import { ASPECT_FEAT, aspectBadge, expandTagPattern, tagsForFeat, verbConjType, confusionLabelJa } from '../src/core/tags';
import { itemIdT9, parseItemId } from '../src/core/session';
import { TRANSLIT_TABLE, translit, translitLive } from '../src/core/translit';
import { dedupeGloss, mergeGloss, parseWordlistText } from '../src/core/wordlist';
import type { Attempt, Form, Lemma } from '../src/core/types';
import { UNITS } from '../src/content/units';
import { alternationFor, convertAccent, inferGender, splitForms, spellExceptionForms } from '../scripts/build-dict';

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

describe('aspect (A1-A4)', () => {
  const impf: Lemma = { ...govorit, aspect: 'impf', glossJa: '話す', partnerIds: ['v-сделать'] };
  const pf: Lemma = { ...govorit, id: 'v-сделать', bare: 'сделать', accented: 'сде́лать', aspect: 'pf', glossJa: '話す', forms: { 'past.m': form('сде́лал') } };
  it('shows a badge per aspect', () => {
    expect(aspectBadge({ aspect: 'impf' })).toBe('〔不完〕');
    expect(aspectBadge({ aspect: 'pf' })).toBe('〔完〕');
    expect(aspectBadge({ aspect: 'both' })).toBe('〔両体〕');
    expect(aspectBadge({})).toBe('');
  });
  it('adds the aspect nuance only when the partner has the same display gloss', () => {
    expect(aspectNote(impf, [pf])).toBe('（過程・反復）');
    expect(aspectNote(pf, [impf])).toBe('（1回・完了）');
    expect(aspectNote(impf, [{ ...pf, glossJa: '作る' }])).toBeNull();
    expect(aspectNote({ ...impf, aspect: 'both' }, [pf])).toBeNull();
    expect(aspectNote(impf, [])).toBeNull();
  });
  it('classifies the partner verb as wrong_aspect', () => {
    const t2 = classify({ given: 'сделать', expected: form('говори́ть'), lemma: impf, partners: [pf] });
    expect(t2).toEqual({ class: 'wrong_aspect', confusion: { expected: 'impf', given: 'pf' }, tag: 'verb.aspect.pair' });
    const t3 = classify({ given: 'сделал', expected: form('говори́л'), lemma: { ...impf, forms: { 'past.m': form('говори́л') } }, feat: 'past.m', partners: [pf] });
    expect(t3.class).toBe('wrong_aspect');
    expect(ratingFor({ class: 'wrong_aspect', type: 'T3', hintUsed: false, latencyMs: 1000 })).toBe(1);
    expect(CLASS_JA.wrong_aspect).toBe('体の取り違え');
  });
});

describe('consonant alternation (B1)', () => {
  const sprosit: Lemma = {
    ...govorit, id: 'v-спросить', bare: 'спросить', alt: { from: 'с', to: 'ш', scope: '1sg' },
    forms: { 'pres.1sg': form('спрошу́'), 'pres.2sg': form('спроси́шь'), 'pres.3sg': form('спроси́т') },
  };
  const pisat: Lemma = {
    ...govorit, id: 'v-писать', bare: 'писать', alt: { from: 'с', to: 'ш', scope: 'all' },
    forms: { 'pres.1sg': form('пишу́'), 'pres.2sg': form('пи́шешь') },
  };
  const pokazat: Lemma = {
    ...govorit, id: 'v-показать', bare: 'показать', alt: { from: 'з', to: 'ж', scope: 'all' },
    forms: { 'pres.1sg': form('покажу́') },
  };
  it('detects the missing alternation at pres.1sg (with the у/ю swap)', () => {
    const expected = sprosit.forms['pres.1sg']!;
    expect(classify({ given: 'спросу', expected, lemma: sprosit, feat: 'pres.1sg' })).toEqual({ class: 'no_alternation', tag: 'verb.pres.alt' });
    expect(classify({ given: 'спросю', expected, lemma: sprosit, feat: 'pres.1sg' })).toEqual({ class: 'no_alternation', tag: 'verb.pres.alt' });
    expect(classify({ given: 'спрошу', expected, lemma: sprosit, feat: 'pres.1sg' }).class).toBe('correct');
  });
  it('detects the missing alternation on other persons / infinitive-stem answers', () => {
    expect(classify({ given: 'писешь', expected: pisat.forms['pres.2sg']!, lemma: pisat, feat: 'pres.2sg' }).class).toBe('no_alternation');
    expect(classify({ given: 'показаю', expected: pokazat.forms['pres.1sg']!, lemma: pokazat, feat: 'pres.1sg' }).class).toBe('no_alternation');
    expect(classify({ given: 'пишешь', expected: pisat.forms['pres.2sg']!, lemma: pisat, feat: 'pres.2sg' }).class).toBe('correct');
  });
  it('tags only the persons where the alternation applies', () => {
    expect(tagsForFeat(sprosit, 'pres.1sg')).toContain('verb.pres.alt');
    expect(tagsForFeat(sprosit, 'pres.2sg')).not.toContain('verb.pres.alt');
    expect(tagsForFeat(pisat, 'pres.2sg')).toContain('verb.pres.alt');
  });
});

describe('reflexive verbs (B2)', () => {
  const uchitsya: Lemma = {
    ...govorit, id: 'v-учиться', bare: 'учиться', accented: 'учи́ться', forms: { 'pres.1sg': form('учу́сь'), 'pres.2sg': form('у́чишься') },
  };
  it('classifies the missing -ся/-сь as reflexive_drop', () => {
    expect(classify({ given: 'учу', expected: uchitsya.forms['pres.1sg']!, lemma: uchitsya, feat: 'pres.1sg' })).toEqual({ class: 'reflexive_drop', tag: 'verb.reflexive' });
    expect(classify({ given: 'учишь', expected: uchitsya.forms['pres.2sg']!, lemma: uchitsya, feat: 'pres.2sg' }).class).toBe('reflexive_drop');
    expect(classify({ given: 'учусь', expected: uchitsya.forms['pres.1sg']!, lemma: uchitsya, feat: 'pres.1sg' }).class).toBe('correct');
    expect(ratingFor({ class: 'reflexive_drop', type: 'T3', hintUsed: false, latencyMs: 1000 })).toBe(1);
    expect(CLASS_JA.reflexive_drop).toBe('再帰接尾辞の脱落');
  });
  it('tags every T3 of a reflexive verb and warns before submitting when liveWarnings is on', () => {
    expect(tagsForFeat(uchitsya, 'pres.1sg')).toContain('verb.reflexive');
    expect(tagsForFeat(uchitsya, 'pres.2sg')).toContain('verb.reflexive');
    expect(reflexiveWarning(uchitsya, 'учу', true)).toBe(true);
    expect(reflexiveWarning(uchitsya, 'учусь', true)).toBe(false);
    expect(reflexiveWarning(uchitsya, 'учу', false)).toBe(false);
    expect(reflexiveWarning(govorit, 'говорю', true)).toBe(false);
  });
});

describe('aspect tag split (A5)', () => {
  it('tags the pseudo aspect form as verb.aspect.pair', () => {
    expect(tagsForFeat(govorit, ASPECT_FEAT)).toEqual(['verb.aspect.pair']);
  });
  it('U14 uses pair and choice; legacy attempts map to pair', () => {
    const u14 = UNITS.find((u) => u.id === 'U14')!;
    expect([...u14.tags].sort()).toEqual(['verb.aspect.choice', 'verb.aspect.pair']);
    const now = Date.UTC(2026, 5, 30);
    const stats = tagStats([{ ts: now, class: 'correct', tags: ['verb.aspect'] }], now);
    expect(stats.has('verb.aspect')).toBe(false);
    expect(stats.get('verb.aspect.pair')).toMatchObject({ n: 1, k: 1 });
  });
});

describe('adjective agreement item (B4)', () => {
  it('encodes T9 item ids and uses an 8s speed threshold', () => {
    expect(itemIdT9('a-новый', 'n-книга', 'adj.nom.pl')).toBe('T9:a-новый:n-книга:adj.nom.pl');
    expect(parseItemId('T9:a-новый:n-книга:adj.nom.pl')).toEqual({
      type: 'T9', ref: 'a-новый', nounId: 'n-книга', feat: 'adj.nom.pl',
    });
    expect(ratingFor({ class: 'correct', type: 'T9', hintUsed: false, latencyMs: 8000 })).toBe(3);
    expect(ratingFor({ class: 'correct', type: 'T9', hintUsed: false, latencyMs: 8001 })).toBe(2);
  });
});

describe('typed accents (B5)', () => {
  it('turns "=" after a vowel into U+0301 and removes the "="', () => {
    expect(applyAccentKey('книга=')).toBe('книга́');
    expect(applyAccentKey('сло=во')).toBe('сло́во');
    expect(applyAccentKey('стол=')).toBe('стол='); // no vowel right before
    expect(applyAccentKey('a=')).toBe('a='); // Latin is transliterated first
  });
  it('compares typed stress positions with the expected ones', () => {
    expect(typedStressOk('кни́га', 'кни́га')).toBe(true);
    expect(typedStressOk('книга́', 'кни́га')).toBe(false);
    expect(typedStressOk('книга', 'кни́га')).toBeUndefined();
    expect(typedStressOk('кни́га', 'кни́га')).toBe(true);
  });
  it('counts typed-accent answers in phon.stress', () => {
    const now = Date.UTC(2026, 5, 30);
    const s = tagStats([
      { ts: now, class: 'correct', tags: ['vocab'], stressOk: true },
      { ts: now, class: 'wrong', tags: ['vocab'], stressOk: false },
    ], now);
    expect(s.get('phon.stress')).toMatchObject({ n: 2, k: 1 });
  });
});

describe('spelling violations (B3)', () => {
  it('marks the two offending letters for both rules', () => {
    expect(spellingViolations('жызнь')).toEqual([{ start: 0, end: 2, tag: 'spell.y_i' }]);
    expect(spellingViolations('чяй')).toEqual([{ start: 0, end: 2, tag: 'spell.a_ya' }]);
    expect(spellingViolations('щюка')).toEqual([{ start: 0, end: 2, tag: 'spell.a_ya' }]);
    expect(spellingViolations('ЖЫ')).toEqual([{ start: 0, end: 2, tag: 'spell.y_i' }]);
  });
  it('does not flag correct spellings and skips dictionary exceptions', () => {
    expect(spellingViolations('жить')).toEqual([]);
    expect(spellingViolations('чаща')).toEqual([]);
    expect(spellingViolations('жюри')).toEqual([{ start: 0, end: 2, tag: 'spell.a_ya' }]);
    expect(spellingViolations('жюри', ['жюри'])).toEqual([]);
    expect(spellingViolations('парашю́т', ['парашют'])).toEqual([]);
  });
  it('reports every offending range in order', () => {
    expect(spellingViolations('жы и чяй')).toEqual([
      { start: 0, end: 2, tag: 'spell.y_i' },
      { start: 5, end: 7, tag: 'spell.a_ya' },
    ]);
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
    // F2: numbered / "／" lists are split and deduped before merging.
    expect(mergeGloss('何が', '何が')).toBe('何が');
    expect(mergeGloss('何が', '何が／何を')).toBe('何が／何を');
    expect(mergeGloss('1. 何が 2. 何を', '何が')).toBe('1. 何が 2. 何を');
    expect(mergeGloss('何が', '何が、何を')).toBe('1. 何が 2. 何を');
    expect(dedupeGloss('何が／何が')).toBe('何が');
    expect(dedupeGloss('1. 何が 2. 何を／何が')).toBe('何が／何を'); // style follows the source
    expect(dedupeGloss('ランプ、電灯、ランプ')).toBe('1. ランプ 2. 電灯');
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
    // The annotation is recognised without a space too (Cyrillic / ")" / "]" right before "+").
    expect(parseWordlistText('сесть на+対\t乗る')).toEqual([{ word: 'сесть на', hint: '+対', glossJa: '乗る' }]);
    expect(parseWordlistText('просить+対,頼む')).toEqual([{ word: 'просить', hint: '+対', glossJa: '頼む' }]);
    expect(parseWordlistText('держать)+対')).toEqual([{ word: 'держать)', hint: '+対' }]);
    expect(parseWordlistText('x]+複')).toEqual([{ word: 'x]', hint: '+複' }]);
    expect(parseWordlistText('играть +対+前')).toEqual([{ word: 'играть', hint: '+対+前' }]);
    expect(parseWordlistText('c++')).toEqual([{ word: 'c++' }]); // not a Japanese case annotation
    expect(parseWordlistText('играть')).toEqual([{ word: 'играть' }]);
    expect(parseWordlistText('+対\tonly')).toEqual([]); // an annotation alone is not a word
  });
});

describe('build-dict derivation', () => {
  it('infers gender from the nominative ending (ь gives no answer)', () => {
    expect(inferGender('стол')).toBe('m');
    expect(inferGender('музей')).toBe('m');
    expect(inferGender('книга')).toBe('f');
    expect(inferGender('семья')).toBe('f');
    expect(inferGender('окно')).toBe('n');
    expect(inferGender('море')).toBe('n');
    expect(inferGender('время')).toBe('n'); // -мя
    expect(inferGender('дядя')).toBe('m'); // MASC_A_YA exception
    expect(inferGender('дедушка')).toBe('m');
    expect(inferGender('папа')).toBe('m');
    expect(inferGender('мама')).toBe('f');
    expect(inferGender('тетрадь')).toBeUndefined();
    expect(inferGender('день')).toBeUndefined();
  });
  it('computes the infinitive / pres.1sg consonant alternation', () => {
    const vf = (p1: string, p2: string): Record<string, Form> => ({ 'pres.1sg': form(p1), 'pres.2sg': form(p2) });
    expect(alternationFor('писать', vf('пишу', 'пишешь'))).toEqual({ from: 'с', to: 'ш', scope: 'all' });
    expect(alternationFor('спросить', vf('спрошу', 'спросишь'))).toEqual({ from: 'с', to: 'ш', scope: '1sg' });
    expect(alternationFor('видеть', vf('вижу', 'видишь'))).toEqual({ from: 'д', to: 'ж', scope: '1sg' });
    expect(alternationFor('показать', vf('покажу', 'покажешь'))).toEqual({ from: 'з', to: 'ж', scope: 'all' });
    expect(alternationFor('любить', vf('люблю', 'любишь'))).toEqual({ from: 'б', to: 'бл', scope: '1sg' });
    expect(alternationFor('читать', vf('читаю', 'читаешь'))).toBeUndefined();
    expect(alternationFor('писать', {})).toBeUndefined();
  });
  it('collects forms that violate the spelling rules (exceptions)', () => {
    const mk = (bare: string, forms: Record<string, Form> = {}): Lemma => ({
      id: bare, bare, accented: bare, pos: 'other', rank: 1, level: 'A1', glossEn: [], forms,
    });
    const out = spellExceptionForms([mk('жюри'), mk('парашют'), mk('книга', { 'case.gen.pl': form('книгы') }), mk('стол')]);
    expect(out).toEqual(['жюри', 'книгы', 'парашют']);
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
