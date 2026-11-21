import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AIProvider } from '../src/ai/provider';
import type { AnalyzeOutput } from '../src/ai/schemas';
import { backlogMarkdown, importAnalysis, restoreLineBreaks, runExplain, runGloss, runNote } from '../src/ai/tasks';
import { UNITS } from '../src/content/units';
import { ratingFor } from '../src/core/classify';
import { grade, isUncertainGloss, type Answer, type Question } from '../src/core/grade';
import { DAY_MS } from '../src/core/stats';
import type { Form, Lemma } from '../src/core/types';
import { exportAll, importAll, parseBackup } from '../src/db/backup';
import { SCHEMA_VERSION, db, RusloDB, setDb } from '../src/db/db';
import { toRow } from '../src/db/dict';
import { loadSettings, setSetting } from '../src/db/settings';
import { activeWeights, buildQuestion, buildSession, glossCandidates, loadContext, newLemmaQueue, recordAttempt } from '../src/db/study';
import { createWordlist } from '../src/db/wordlists';
import { markAllBacklogExported, syncAppVersion } from '../src/db/backlog';

const f = (primary: string): Form => ({ primary, variants: [] });
const STEMS = ['крыш', 'душ', 'туч', 'книг', 'ламп', 'карт', 'школ', 'комнат', 'машин', 'газет', 'рыб', 'групп', 'стран', 'минут', 'цен', 'побед', 'планет', 'систем'];

function noun(stem: string, rank: number): Lemma {
  const y = /[гкхжшщч]$/.test(stem) ? 'и' : 'ы';
  return {
    id: `n-${stem}а`, bare: `${stem}а`, accented: `${stem}а\u0301`, pos: 'noun', rank, level: 'A1', gender: 'f', animate: false,
    glossEn: [`gloss-${stem}`],
    forms: {
      'case.nom.sg': f(`${stem}а\u0301`), 'case.gen.sg': f(`${stem}${y}`), 'case.dat.sg': f(`${stem}е`), 'case.acc.sg': f(`${stem}у`),
      'case.ins.sg': f(/[жшщчц]$/.test(stem) ? `${stem}ей` : `${stem}ой`), 'case.prep.sg': f(`${stem}е`), 'case.nom.pl': f(`${stem}${y}`), 'case.gen.pl': f(stem),
      'case.dat.pl': f(`${stem}ам`), 'case.acc.pl': f(`${stem}${y}`), 'case.ins.pl': f(`${stem}ами`), 'case.prep.pl': f(`${stem}ах`),
    },
  };
}
function verb(stem: string, rank: number): Lemma {
  return {
    id: `v-${stem}ать`, bare: `${stem}ать`, accented: `${stem}а́ть`, pos: 'verb', rank, level: 'A1', aspect: 'impf', glossEn: [`verb-${stem}`],
    forms: {
      'pres.1sg': f(`${stem}у`), 'pres.2sg': f(`${stem}ишь`), 'pres.3sg': f(`${stem}ит`),
      'pres.1pl': f(`${stem}им`), 'pres.2pl': f(`${stem}ите`), 'pres.3pl': f(`${stem}ат`), 'past.m': f(`${stem}ал`),
    },
  };
}
function other(i: number): Lemma {
  return { id: `o-w${i}`, bare: `слово${i}`, accented: `сло\u0301во${i}`, pos: 'other', rank: i, level: i <= 40 ? 'A1' : 'A2', glossEn: [`meaning ${i}`], forms: {} };
}

let dbCount = 0;
beforeEach(async () => {
  setDb(new RusloDB(`ruslo-test-${++dbCount}`));
  const lemmas = [...STEMS.map((s, i) => noun(s, i + 1)), ...['слыш', 'держ', 'леж', 'крич'].map((s, i) => verb(s, i + 1)), ...Array.from({ length: 80 }, (_, i) => other(i + 1))];
  await db.lemmas.bulkPut(lemmas.map((l) => toRow(l)));
});

function rngFrom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** Answer correctly, except every `wrongEvery`-th question. */
function answerFor(q: Question, correct: boolean): Answer {
  switch (q.type) {
    case 'T1': return { kind: 'choice', index: correct ? q.correct : (q.correct + 1) % q.options.length };
    case 'T5': return { kind: 'stress', index: correct ? q.stressed[0]! : -1 };
    case 'T6': return { kind: 'text', text: correct ? q.sentence : 'нет' };
    default: return { kind: 'text', text: correct ? q.expected.primary : 'ъъъ' };
  }
}

async function playSession(now: number, seed: number, wrongEvery = 0): Promise<Question[]> {
  const ctx = await loadContext(now);
  const questions = await buildSession(ctx, { ttsAvailable: false, rng: rngFrom(seed) });
  let i = 0;
  for (const q of questions) {
    const ok = wrongEvery === 0 || ++i % wrongEvery !== 0;
    const graded = grade(q, answerFor(q, ok), { yoLenient: true });
    const rating = ratingFor({ class: graded.class, type: q.type, hintUsed: false, latencyMs: 2000 });
    await recordAttempt({ question: q, graded, rating, latencyMs: 2000, hintCount: 0, now: now + i });
  }
  return questions;
}

describe('session end to end (M3)', () => {
  const day0 = new Date(2026, 5, 1, 9, 0, 0).getTime();

  it('completes a 20-question session and updates attempts and cards', async () => {
    const qs = await playSession(day0, 1, 5);
    expect(qs).toHaveLength(20);
    expect(new Set(qs.map((q) => q.itemId)).size).toBe(20);
    for (let i = 1; i < qs.length; i++) expect(qs[i]!.lemmaId).not.toBe(qs[i - 1]!.lemmaId);
    // Day 1: no cards yet -> U1 weak items (spelling rules / stress) plus the new-word allowance.
    expect(qs.filter((q) => q.type === 'T1').length).toBeGreaterThanOrEqual(2);
    expect(qs.filter((q) => q.type === 'T1').length).toBeLessThanOrEqual(15);
    expect(qs.some((q) => q.type === 'T3' || q.type === 'T5')).toBe(true);

    const attempts = await db.attempts.toArray();
    expect(attempts).toHaveLength(20);
    expect(attempts.filter((a) => a.class === 'wrong')).toHaveLength(4);
    expect(attempts.every((a) => a.tags.length > 0 && a.latencyMs === 2000)).toBe(true);

    const cards = await db.cards.toArray();
    const asked = cards.filter((c) => c.reps > 0);
    expect(asked).toHaveLength(20);
    expect(asked.every((c) => c.due > day0)).toBe(true);
    // T2 cards are created only for words whose T1 was answered correctly.
    const t1ok = attempts.filter((a) => a.type === 'T1' && a.class === 'correct').map((a) => a.itemId.slice(3)).sort();
    const t2 = cards.filter((c) => c.type === 'T2').map((c) => c.lemmaId).sort();
    expect(t2).toEqual(t1ok);
    expect(cards.filter((c) => c.type === 'T2').every((c) => c.reps === 0)).toBe(true);
  });

  it('keeps going over several days: reviews come back, the daily new limit holds, U2 unlocks', async () => {
    await setSetting('dailyNewLimit', 5);
    let total = 0;
    for (let d = 0; d < 6; d++) {
      for (let s = 0; s < 3; s++) total += (await playSession(day0 + d * DAY_MS + s * 3_600_000, d * 10 + s + 1)).length;
      const today = (await db.cards.toArray()).filter((c) => c.type === 'T1' && c.createdAt >= day0 + d * DAY_MS && c.createdAt < day0 + (d + 1) * DAY_MS);
      expect(today.length, `new words on day ${d}`).toBeLessThanOrEqual(5);
    }
    expect(total).toBeGreaterThanOrEqual(300);
    expect(await db.attempts.count()).toBe(total);
    const types = new Set((await db.attempts.toArray()).map((a) => a.type));
    expect(types.has('T1') && types.has('T2') && types.has('T3')).toBe(true);
    const ctx = await loadContext(day0 + 6 * DAY_MS);
    expect(ctx.unlocked).toContain('U2'); // every U1 tag reached n >= 10 with LB >= 0.75
    expect((await db.unitState.get('U2'))?.unlocked).toBe(true);
    expect(ctx.dueCount).toBeGreaterThan(0);
  });
});

describe('word lists (M4)', () => {
  it('matches dictionary words, overrides glossJa, registers unknown words, and prioritises them as new words', async () => {
    const r = await createWordlist('教科書', 'лампа\tランプ\nКНИ\u0301ГА\nпривет,やあ\n\nлампа\n');
    expect(r).toEqual({ matched: 2, created: 1, total: 3 });
    expect((await db.lemmas.get('n-лампа'))?.glossJa).toBe('ランプ');
    const user = await db.lemmas.get('u-привет');
    expect(user).toMatchObject({ pos: 'other', forms: {}, glossJa: 'やあ', user: true });
    const s = await loadSettings();
    expect(s.glossJa['n-лампа']).toBe('ランプ');
    expect(s.userLemmas.map((l) => l.id)).toEqual(['u-привет']);

    const ctx = await loadContext(Date.now());
    const qs = await buildSession(ctx, { ttsAvailable: false, rng: rngFrom(3) });
    const fresh = qs.filter((q) => q.type === 'T1').map((q) => q.lemmaId);
    expect(fresh).toEqual(['n-лампа', 'n-книга']); // new slot = 2, word-list order first
    expect((await newLemmaQueue(ctx.cards)).slice(0, 4)).toEqual(['n-лампа', 'n-книга', 'u-привет', 'n-крыша']);
    const lamp = qs.find((q) => q.itemId === 'T1:n-лампа');
    expect(lamp?.type === 'T1' && lamp.options[lamp.correct]).toBe('ランプ');

    // A different meaning from another list is appended (numbered), not overwritten.
    await createWordlist('教科書2', 'лампа\t電灯');
    expect((await db.lemmas.get('n-лампа'))?.glossJa).toBe('1. ランプ 2. 電灯');
    expect((await loadSettings()).glossJa['n-лампа']).toBe('1. ランプ 2. 電灯');
    await createWordlist('教科書3', 'лампа\tランプ');
    expect((await db.lemmas.get('n-лампа'))?.glossJa).toBe('1. ランプ 2. 電灯'); // same meaning: no duplicate

    // Phrases / idioms with a case hint become whole-phrase user words (T1/T2 only); the hint
    // is display-only (never typed) and is kept for dictionary words too.
    await createWordlist('フレーズ', 'сесть на +対\t乗る\nдержать +対');
    const phrase = await db.lemmas.get('u-сесть_на');
    expect(phrase).toMatchObject({ pos: 'other', bare: 'сесть на', hint: '+対', glossJa: '乗る', forms: {}, user: true });
    expect((await db.lemmas.get('v-держать'))?.hint).toBe('+対');
    expect((await loadSettings()).hints).toEqual({ 'v-держать': '+対', 'u-сесть_на': '+対' });
    const phq = await buildQuestion({ itemId: 'T1:u-сесть_на', type: 'T1', lemmaId: 'u-сесть_на', slot: 'new' });
    expect(phq?.type === 'T1' && phq.hint).toBe('+対');
    expect(phq?.type === 'T1' && phq.options[phq.correct]).toBe('乗る');
  });
});

describe('AI import (M5)', () => {
  const out: AnalyzeOutput = {
    diagnosis: [{ tag: 'noun.prep.sg', hypothesis_ja: '仮説', evidence: 'n=40' }],
    tag_weights: [{ tag: 'noun.prep.sg', w: 2.5 }, { tag: 'no.such.tag', w: 3 }],
    new_items: [
      { sentence_ru: 'Я читаю о ___.', lemma: 'книга', feat: 'case.prep.sg', answer: 'книге', translation_ja: '本について読む', explain_ja: 'о＋前置格' },
      { sentence_ru: 'Я вижу ___.', lemma: 'книга', feat: 'case.acc.sg', answer: 'книга', translation_ja: '本が見える', explain_ja: '対格' },
      { sentence_ru: 'Это ___.', lemma: 'несуществующее', feat: 'case.nom.sg', answer: 'x', translation_ja: '', explain_ja: '' },
    ],
    tips_ja: 'がんばりましょう',
    feature_requests: [{ title: '格の一覧表', rationale: '混同が多い', spec: '結果画面に表を出す' }],
  };

  it('stores weights (known tags only), registers valid T4 items, quarantines the rest, appends the backlog', async () => {
    const now = Date.now();
    const ctx = await loadContext(now);
    const r = await importAnalysis(out, ctx, now);
    expect(r).toEqual({ added: 1, quarantined: 2, weights: 1, requests: 1 });

    expect(await activeWeights(now + DAY_MS)).toEqual({ 'noun.prep.sg': 2.5 });
    expect(await activeWeights(now + 15 * DAY_MS)).toEqual({}); // expires after 14 days

    const items = await db.items.toArray();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'T4:1', type: 'T4', source: 'ai' });
    expect(items[0]!.tags.sort()).toEqual(['noun.prep.sg', 'prep.о']);
    expect(items[0]!.payload.lemmaId).toBe('n-книга');

    const q = await db.quarantine.toArray();
    expect(q.map((x) => x.reason)).toEqual([expect.stringContaining('一致しません'), expect.stringContaining('辞書にありません')]);

    const backlog = await db.backlog.toArray();
    expect(backlog).toHaveLength(1);
    expect(backlogMarkdown(backlog)).toContain('## 格の一覧表');

    // A newer analysis replaces the previous weights.
    await importAnalysis({ ...out, tag_weights: [], new_items: [], feature_requests: [] }, ctx, now + 1000);
    expect(await activeWeights(now + 2000)).toEqual({});
    expect((await loadSettings()).lastAnalysisAt).toBe(now + 1000);
  });

  it('explain is cached by (itemId, normalize(given)); gloss ignores unknown ids', async () => {
    let calls = 0;
    const provider: AIProvider = {
      run: async <T>(task: string) => {
        calls++;
        return (task === 'explain'
          ? { explain_ja: '語尾は -е です。' }
          : { items: [{ id: 'n-книга', ja: '本' }, { id: 'zzz', ja: '?' }, { id: 'n-лампа', ja: 'ランプ、電灯' }] }) as T;
      },
    };
    const ctx = await loadContext(Date.now());
    const qs = await buildSession(ctx, { ttsAvailable: false, rng: rngFrom(5) });
    const q = qs.find((x) => x.type === 'T3')!;
    const g1 = grade(q, { kind: 'text', text: 'Ошибка' }, { yoLenient: true });
    expect(await runExplain(provider, q, g1)).toBe('語尾は -е です。');
    const g2 = grade(q, { kind: 'text', text: ' ошибка. ' }, { yoLenient: true });
    expect(await runExplain(provider, q, g2)).toBe('語尾は -е です。');
    expect(calls).toBe(1);

    expect(await runGloss(provider, ctx)).toBe(2);
    expect((await db.lemmas.get('n-книга'))?.glossJa).toBe('本');
    expect((await loadSettings()).glossJa).toEqual({ 'n-книга': '本', 'n-лампа': 'ランプ、電灯' });
  });
});

describe('grammar note (12.4)', () => {
  const flat = '## 要点 綴りの規則。 ### 表 | 文字 | 例 ||---|---|| ж | жи́ть |';
  const good = ['## 要点', '', '綴りの規則。', '', '| 文字 | 例 |', '|---|---|', '| ж | жи́ть |'].join('\n');
  const fake = (bodies: string[]): AIProvider & { calls: number } => {
    const p = { calls: 0, run: async <T>() => ({ title: 'ノート', body_md: bodies[Math.min(p.calls++, bodies.length - 1)] }) as T };
    return p;
  };
  it('stores a well-formed note with a single call', async () => {
    const p = fake([good]);
    await runNote(p, UNITS[0]!);
    expect(p.calls).toBe(1);
    expect(await db.unitState.get('U1')).toMatchObject({ noteTitle: 'ノート', noteMd: good });
  });
  it('asks once more when the body has no line breaks', async () => {
    const p = fake([flat, good]);
    await runNote(p, UNITS[0]!);
    expect(p.calls).toBe(2);
    expect((await db.unitState.get('U1'))?.noteMd).toBe(good);
  });
  it('repairs headings and table rows when the retry is also flat', async () => {
    const p = fake([flat, flat]);
    await runNote(p, UNITS[0]!);
    expect(p.calls).toBe(2);
    const md = (await db.unitState.get('U1'))!.noteMd!;
    expect(md.split('\n')).toEqual(['## 要点 綴りの規則。', '', '### 表', '', '| 文字 | 例 |', '|---|---|', '| ж | жи́ть |']);
    expect(restoreLineBreaks(good)).toBe(good);
  });
});

describe('T4 / T6 flow and export / import (M6)', () => {
  it('asks an unlocked T4 item, opens dictation after a correct answer, and round-trips a backup', async () => {
    const now = new Date(2026, 5, 1, 9, 0, 0).getTime();
    await db.unitState.put({ unitId: 'U5', unlocked: true, noteSeen: true });
    const ctx0 = await loadContext(now);
    await importAnalysis({
      diagnosis: [], tag_weights: [], tips_ja: '', feature_requests: [],
      new_items: [{ sentence_ru: 'Я живу в ___.', lemma: 'страна', feat: 'case.prep.sg', answer: 'стране', translation_ja: '国に住む', explain_ja: 'в＋前置格' }],
    }, ctx0, now);

    let t4: Question | undefined;
    for (let seed = 1; seed <= 40 && !t4; seed++) {
      t4 = (await buildSession(await loadContext(now), { ttsAvailable: true, rng: rngFrom(seed) })).find((q) => q.type === 'T4');
    }
    expect(t4, 'T4 item is scheduled through the weak slot').toBeDefined();
    if (t4?.type !== 'T4') throw new Error('unreachable');
    expect(t4.tags.sort()).toEqual(['noun.prep.sg', 'prep.в']);
    const wrong = grade(t4, { kind: 'text', text: 'страну' }, { yoLenient: true });
    expect(wrong).toMatchObject({ class: 'wrong_form', confusion: { expected: 'case.prep.sg', given: 'case.acc.sg' } });
    const ok = grade(t4, { kind: 'text', text: 'Стране' }, { yoLenient: true });
    expect(ok.class).toBe('correct');
    await recordAttempt({ question: t4, graded: ok, rating: 3, latencyMs: 3000, hintCount: 0, now });
    const t6card = await db.cards.get('T6:1');
    expect(t6card).toMatchObject({ type: 'T6', reps: 0 });

    // Dictation is only scheduled when a Russian voice exists.
    const later = now + 2 * DAY_MS;
    const noTts = await buildSession(await loadContext(later), { ttsAvailable: false, rng: rngFrom(2) });
    expect(noTts.some((q) => q.type === 'T6')).toBe(false);
    const withTts = await buildSession(await loadContext(later), { ttsAvailable: true, rng: rngFrom(2) });
    const t6 = withTts.find((q) => q.type === 'T6');
    expect(t6?.type === 'T6' && t6.sentence).toBe('Я живу в стране.');
    if (t6?.type !== 'T6') throw new Error('unreachable');
    expect(grade(t6, { kind: 'text', text: 'я живу в стране' }, { yoLenient: true }).class).toBe('correct');
    expect(grade(t6, { kind: 'text', text: 'я живу в стрне' }, { yoLenient: true }).class).toBe('typo');
    expect(grade(t6, { kind: 'text', text: 'я живу' }, { yoLenient: true }).class).toBe('wrong');

    // export -> wipe -> import restores everything except lemmas
    await createWordlist('list', 'рыба\tさかな');
    const backup = parseBackup(JSON.stringify(await exportAll()));
    expect(backup.schemaVersion).toBe(SCHEMA_VERSION);
    expect(backup.tables['lemmas']).toBeUndefined();
    const before = { attempts: await db.attempts.count(), cards: await db.cards.count(), items: await db.items.count() };
    await playSession(later, 9);
    await db.wordlists.clear();
    await db.lemmas.update('n-рыба', { glossJa: undefined });
    await importAll(backup);
    expect({ attempts: await db.attempts.count(), cards: await db.cards.count(), items: await db.items.count() }).toEqual(before);
    expect(await db.wordlists.count()).toBe(1);
    expect((await db.lemmas.get('n-рыба'))?.glossJa).toBe('さかな');
    expect(await db.lemmas.count()).toBe(102);
    expect(() => parseBackup('{"app":"other"}')).toThrow();
    expect(() => parseBackup('nope')).toThrow();
  });
});


describe('AI gloss (G1)', () => {
  const noGloss = (): Lemma => ({
    id: 'n-стекло', bare: 'стекло', accented: 'стекло́', pos: 'noun', rank: 900, level: 'A1', gender: 'n',
    glossEn: [], forms: { 'case.nom.sg': f('стекло́'), 'case.gen.pl': f('стёкол') },
  });

  it('offers user words / phrases first, includes words without an English gloss, and skips glossed words', async () => {
    await createWordlist('glossed', 'лампа	ランプ');
    await createWordlist('user', 'привет2');
    await db.lemmas.put(toRow(noGloss()));

    const ids = (await glossCandidates([], 200)).map((l) => l.id);
    expect(ids[0]).toBe('u-привет2'); // user word first
    expect(ids).toContain('n-стекло'); // no English gloss, still offered
    expect(ids).not.toContain('n-лампа'); // already has glossJa
    expect(ids).not.toContain('u-привет'); // only the registered user word

    const plain = await newLemmaQueue([], 200);
    expect(plain).not.toContain('n-стекло'); // cannot be scheduled before it has a gloss
    expect(await newLemmaQueue([], 200, { includeUnglossed: true })).toContain('n-стекло');
  });

  it('sends pos / aspect / partner, omits a missing en, and keeps an uncertain "?" gloss', async () => {
    await db.lemmas.bulkPut([
      toRow({ id: 'v-делать', bare: 'делать', accented: 'де́лать', pos: 'verb', rank: 20, level: 'A1', aspect: 'impf', partnerIds: ['v-сделать'], glossEn: ['do'], forms: { 'pres.1sg': f('де́лаю') } }),
      toRow({ id: 'v-сделать', bare: 'сделать', accented: 'сде́лать', pos: 'verb', rank: 21, level: 'A1', aspect: 'pf', partnerIds: ['v-делать'], glossEn: ['make'], forms: { 'past.m': f('сде́лал') } }),
      toRow(noGloss()),
    ]);
    let seen: { id: string; ru: string; pos: string; en?: string; aspect?: string; partner?: string }[] = [];
    const provider: AIProvider = {
      run: async <T>(_task: string, input: unknown) => {
        seen = input as typeof seen;
        return { items: seen.map((x) => ({ id: x.id, ja: x.id === 'n-книга' ? '本?' : '訳' })) } as T;
      },
    };
    expect(await runGloss(provider, { cards: [] })).toBeGreaterThan(0);

    const delat = seen.find((x) => x.id === 'v-делать')!;
    expect(delat).toMatchObject({ ru: 'делать', pos: 'verb', aspect: 'impf', partner: 'сделать' });
    expect(delat.en).toBe('do');
    expect('en' in seen.find((x) => x.id === 'n-стекло')!).toBe(false);
    expect(seen.find((x) => x.id === 'n-книга')!.pos).toBe('noun');

    expect((await db.lemmas.get('n-книга'))?.glossJa).toBe('本?');
    expect(isUncertainGloss((await db.lemmas.get('n-книга'))!.glossJa!)).toBe(true);
    expect((await loadSettings()).glossJa['n-книга']).toBe('本?');
  });
});


describe('backlog lifecycle (P1)', () => {
  const withRequests = (titles: string[]): AnalyzeOutput => ({
    diagnosis: [], tag_weights: [], tips_ja: '', new_items: [],
    feature_requests: titles.map((title) => ({ title, rationale: '根拠', spec: '仕様' })),
  });

  it('imports proposals as new, exports them, and deletes only exported rows on a version change', async () => {
    const now = Date.now();
    const ctx = await loadContext(now);
    await importAnalysis(withRequests(['A', 'B']), ctx, now);
    expect((await db.backlog.toArray()).map((r) => r.status)).toEqual(['new', 'new']);

    await markAllBacklogExported();
    expect((await db.backlog.toArray()).every((r) => r.status === 'exported')).toBe(true);
    await db.backlog.add({ ts: now + 1, status: 'new', title: 'keep', rationale: 'r', spec: 's' });
    await setSetting('appVersion', '1.0.1');

    expect(await syncAppVersion('1.0.2')).toBe(2);
    expect((await db.backlog.toArray()).map((r) => r.title)).toEqual(['keep']);
    expect((await loadSettings()).appVersion).toBe('1.0.2');

    expect(await syncAppVersion('1.0.2')).toBe(0); // same version: nothing happens
    expect(await db.backlog.count()).toBe(1);
  });
});
