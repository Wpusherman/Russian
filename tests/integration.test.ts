import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AIProvider } from '../src/ai/provider';
import type { AnalyzeOutput } from '../src/ai/schemas';
import { backlogMarkdown, importAnalysis, restoreLineBreaks, runAnalyze, runAspectItems, runExplain, runGloss, runNote } from '../src/ai/tasks';
import { UNITS } from '../src/content/units';
import { ratingFor } from '../src/core/classify';
import { grade, isUncertainGloss, type Answer, type Question } from '../src/core/grade';
import { DAY_MS } from '../src/core/stats';
import type { Form, Lemma } from '../src/core/types';
import { exportAll, importAll, parseBackup } from '../src/db/backup';
import { SCHEMA_VERSION, db, RusloDB, setDb } from '../src/db/db';
import { reapplyUserData, setGenderOverride } from '../src/db/dict';
import { toRow } from '../src/db/dict';
import { loadSettings, setSetting } from '../src/db/settings';
import { activeWeights, buildQuestion, buildSession, glossCandidates, loadContext, newLemmaQueue, orderNewForU4, recordAttempt, recordT7Attempt } from '../src/db/study';
import { newFsrs } from '../src/core/scheduler';
import { createWordlist, dedupeStoredGlosses, findAmbiguities, saveGlosses } from '../src/db/wordlists';
import { markAllBacklogExported, syncAppVersion } from '../src/db/backlog';
import { addToReadingList, lookupWord, READING_LIST_NAME } from '../src/db/tadoku';

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
    expect(r).toEqual({ matched: 2, created: 1, total: 3, unglossed: [] });
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

    // A second annotation for the same lemma is appended, not overwritten.
    await createWordlist('フレーズ2', 'держать +前\nсесть на +前');
    expect((await db.lemmas.get('v-держать'))?.hint).toBe('+対+前');
    expect((await db.lemmas.get('u-сесть_на'))?.hint).toBe('+対+前');
    expect((await loadSettings()).hints['v-держать']).toBe('+対+前');
  });
  it('transliterates Latin headwords and converts accents in user words (W1/W2)', async () => {
    const r = await createWordlist('ローマ字', "kniga\t本\nprivet\nya/hochu\nсказа'ть\t言う");
    expect(r.matched).toBe(1); // kniga -> книга
    expect((await db.lemmas.get('n-книга'))?.glossJa).toBe('本');
    expect(await db.lemmas.get('u-привет')).toMatchObject({ bare: 'привет', accented: 'привет', user: true });
    expect(await db.lemmas.get('u-яхочу')).toMatchObject({ bare: 'яхочу', user: true }); // "/" disappears
    const accented = await db.lemmas.get('u-сказать');
    expect(accented?.bare).toBe('сказать');
    expect(accented?.accented).toBe('сказа\u0301ть');
  });
  it('lists homonyms and stores the explicitly chosen lemma (W3)', async () => {
    await db.lemmas.put(toRow({ ...noun('ламп', 999), id: 'n-лампа~2', bare: 'лампа', accented: 'ла́мпа', glossEn: ['lamp (second)'] }));
    const amb = await findAmbiguities('лампа');
    expect(amb).toHaveLength(1);
    expect(amb[0]!.word).toBe('лампа');
    expect(amb[0]!.candidates.map((c) => c.id).sort()).toEqual(['n-лампа', 'n-лампа~2']);
    await createWordlist('homonym', 'лампа	ランプ2', { 'лампа': 'n-лампа~2' });
    const list = (await db.wordlists.toArray())[0]!;
    expect(list.entries[0]!.lemmaId).toBe('n-лампа~2');
  });
  it('creates T4 fill-in items from +case annotations (W9)', async () => {
    await db.lemmas.put(toRow({ id: 'v-сесть', bare: 'сесть', accented: 'се́сть', pos: 'verb', rank: 50, level: 'A1', aspect: 'pf', glossEn: ['sit'], forms: { 'pres.1sg': f('ся́ду') } }));
    await createWordlist('hint', 'сесть на +対\t乗る\nкнига\t本\nстол\t机\nтолько +複\tだけ');
    const items = await db.items.toArray();
    expect(items.length).toBeGreaterThan(0);
    const sest = items.find((i) => i.payload.sentence_ru === 'Я сяду на ___');
    expect(sest).toBeDefined();
    expect(sest!.payload.feat).toBe('case.acc.sg');
    expect(sest!.tags).toEqual(expect.arrayContaining(['noun.acc.sg', 'prep.на']));
    const noun = await db.lemmas.get(sest!.payload.lemmaId);
    expect(noun!.forms['case.acc.sg']!.primary.replace(/́/g, '')).toBe(sest!.payload.answer);
    expect(items.some((i) => i.payload.sentence_ru.startsWith('только'))).toBe(false); // no blank for a bare adverb
  });

  it('uses the plural for +複 hints', async () => {
    await db.lemmas.put(toRow({ id: 'v-играть', bare: 'играть', accented: 'игра́ть', pos: 'verb', rank: 51, level: 'A1', aspect: 'impf', glossEn: ['play'], forms: { 'pres.1sg': f('игра́ю') } }));
    await createWordlist('hint-pl', 'играть в +前 +複\t遊ぶ\nкнига\t本');
    const item = (await db.items.toArray()).find((i) => i.payload.feat === 'case.prep.pl');
    expect(item).toBeDefined();
    expect(item!.payload.sentence_ru).toBe('Я играю в ___');
    expect(item!.tags).toEqual(expect.arrayContaining(['noun.prep.pl', 'prep.в']));
  });

  it('uses the other phrases of the list as T1 distractors (W4)', async () => {
    await createWordlist('phrases', 'сесть на +対\t乗る\nвстать с +生\t起きる\nидти в +対\t行く\nприйти из +生\t来る');
    const q = await buildQuestion({ itemId: 'T1:u-сесть_на', type: 'T1', lemmaId: 'u-сесть_на', slot: 'new' }, rngFrom(1));
    if (q?.type !== 'T1') throw new Error('expected T1');
    expect(q.options[q.correct]).toBe('乗る');
    expect(q.options.filter((o) => o !== '乗る').sort()).toEqual(['来る', '行く', '起きる'].sort());
  });
  it('reports words that have no translation and therefore are never asked (W5)', async () => {
    const r = await createWordlist('mixed', 'привет\nкнига\t本\nпока');
    expect(r.created).toBe(2);
    expect(r.unglossed.sort()).toEqual(['пока', 'привет']);
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


describe('analyze packet backlog titles (P3)', () => {
  it("sends every backlog title, including already exported rows", async () => {
    await db.backlog.bulkAdd([
      { ts: 1, status: 'new', title: '新規提案', rationale: 'r', spec: 's' },
      { ts: 2, status: 'exported', title: '書き出し済み', rationale: 'r', spec: 's' },
    ]);
    let packet: { backlog_titles: string[] } | null = null;
    const provider: AIProvider = {
      run: async <T>(_task: string, input: unknown) => {
        packet = input as { backlog_titles: string[] };
        return { diagnosis: [], tag_weights: [], new_items: [], tips_ja: '', feature_requests: [] } as T;
      },
    };
    await runAnalyze(provider, await loadContext(Date.now()));
    expect(packet!.backlog_titles.sort()).toEqual(['新規提案', '書き出し済み']);
  });
});

describe('T11 numeral drill (N1)', () => {
  it('offers T11 through the weak slot once U10 is unlocked and grades the noun form', async () => {
    const now = new Date(2026, 5, 1, 9, 0, 0).getTime();
    await db.unitState.put({ unitId: 'U10', unlocked: true });
    let q: Question | undefined;
    for (let seed = 1; seed <= 30 && !q; seed++) {
      q = (await buildSession(await loadContext(now), { ttsAvailable: false, rng: rngFrom(seed) })).find((x) => x.type === 'T11');
    }
    if (q?.type !== 'T11') throw new Error('expected a T11 item');
    expect(q.tags).toEqual(['num.gov']);
    expect(q.itemId).toBe(`T11:${q.lemmaId}:${q.num}`);
    expect(q.lemma.level === 'A1' || q.lemma.level === 'A2').toBe(true);
    expect(q.lemma.forms['case.gen.pl']).toBeDefined();
    expect(grade(q, { kind: 'text', text: q.expected.primary }, { yoLenient: true }).class).toBe('correct');
    expect(grade(q, { kind: 'text', text: 'ъъъ' }, { yoLenient: true }).class).toBe('wrong');
  });
});

describe('aspect questions (A1-A4)', () => {
  const impf = (): Lemma => ({
    id: 'v-делать', bare: 'делать', accented: 'де\u0301лать', pos: 'verb', rank: 20, level: 'A1', aspect: 'impf',
    partnerIds: ['v-сделать'], glossJa: 'する', glossEn: ['do'], forms: { 'past.m': f('де\u0301лал') },
  });
  const pf = (): Lemma => ({
    id: 'v-сделать', bare: 'сделать', accented: 'сде\u0301лать', pos: 'verb', rank: 21, level: 'A1', aspect: 'pf',
    partnerIds: ['v-делать'], glossJa: '作る', glossEn: ['make'], forms: { 'past.m': f('сде\u0301лал') },
  });
  const filler = (i: number): Lemma => ({
    id: `v-filler${i}`, bare: `filler${i}`, accented: `filler${i}`, pos: 'verb', rank: 22 + i, level: 'A1',
    glossJa: `別${i}`, glossEn: [`other ${i}`], forms: { 'past.m': f(`filler${i}л`) },
  });

  it('attaches the aspect partner, shows the nuance, and grades the partner form as wrong_aspect', async () => {
    await db.lemmas.bulkPut([toRow(impf()), toRow(pf())]);
    const q = await buildQuestion({ itemId: 'T2:v-делать', type: 'T2', lemmaId: 'v-делать', slot: 'weak' });
    if (q?.type !== 'T2') throw new Error('expected T2');
    expect(q.partners?.map((p) => p.id)).toEqual(['v-сделать']);
    expect(q.note).toBeUndefined(); // different glosses here
    const g = grade(q, { kind: 'text', text: 'Сделать' }, { yoLenient: true });
    expect(g).toMatchObject({ class: 'wrong_aspect', confusion: { expected: 'impf', given: 'pf' } });
    expect(g.tags).toContain('verb.aspect.pair');
  });

  it('adds the nuance note when the registered translations are identical', async () => {
    const a = { ...impf(), glossJa: 'する' };
    const b = { ...pf(), glossJa: 'する' };
    await db.lemmas.bulkPut([toRow(a), toRow(b)]);
    const q = await buildQuestion({ itemId: 'T2:v-делать', type: 'T2', lemmaId: 'v-делать', slot: 'weak' });
    if (q?.type !== 'T2') throw new Error('expected T2');
    expect(q.note).toBe('（過程・反復）');
  });

  it('never offers the aspect partner as a T1 distractor', async () => {
    await db.lemmas.bulkPut([toRow(impf()), toRow(pf()), ...Array.from({ length: 4 }, (_, i) => toRow(filler(i)))]);
    for (let seed = 1; seed <= 5; seed++) {
      const q = await buildQuestion({ itemId: 'T1:v-делать', type: 'T1', lemmaId: 'v-делать', slot: 'weak' }, rngFrom(seed));
      if (q?.type !== 'T1') throw new Error('expected T1');
      expect(q.options.join('|')).not.toContain('作る');
      expect(q.options[q.correct]).toBe('する〔不完〕');
    }
  });
});


describe('T10 aspect drill (A5)', () => {
  const chitat = (): Lemma => ({
    id: 'v-читать', bare: 'читать', accented: 'чита́ть', pos: 'verb', rank: 30, level: 'A1', aspect: 'impf',
    partnerIds: ['v-прочитать'], glossEn: ['read'], forms: { 'past.m': f('чита́л'), 'pres.1sg': f('чита́ю') },
  });
  const prochitat = (): Lemma => ({
    id: 'v-прочитать', bare: 'прочитать', accented: 'прочита́ть', pos: 'verb', rank: 31, level: 'A1', aspect: 'pf',
    partnerIds: ['v-читать'], glossEn: ['read'], forms: { 'past.m': f('прочита́л'), 'pres.1sg': f('прочита́ю') },
  });

  async function seedLearnedPair(): Promise<number> {
    const now = Date.now();
    await db.lemmas.bulkPut([toRow(chitat()), toRow(prochitat())]);
    await db.cards.bulkAdd([
      { id: 'T1:v-читать', type: 'T1', lemmaId: 'v-читать', tags: ['vocab'], createdAt: now, ...newFsrs(now) },
      { id: 'T1:v-прочитать', type: 'T1', lemmaId: 'v-прочитать', tags: ['vocab'], createdAt: now, ...newFsrs(now) },
    ]);
    return now;
  }

  it('generates T10 items from learned pairs, quarantines invalid ones with kind t10', async () => {
    await seedLearnedPair();
    const provider: AIProvider = {
      run: async <T>() => ({
        items: [
          { sentence_ru: 'Вчера я ___ всю книгу.', impf: 'читать', pf: 'прочитать', correct: 'pf', feat: 'past.m', answer: 'прочитал', translation_ja: '昨日私は本を全部読んだ。', cue_ja: 'вчера＋結果' },
          { sentence_ru: 'Я ___ книгу.', impf: 'читать', pf: 'прочитать', correct: 'impf', feat: 'past.m', answer: 'прочитал', translation_ja: 'x', cue_ja: 'y' },
          { sentence_ru: 'Я ___ книгу.', impf: 'спать', pf: 'прочитать', correct: 'impf', feat: 'past.m', answer: 'спал', translation_ja: 'x', cue_ja: 'y' },
        ],
      }) as T,
    };
    const r = await runAspectItems(provider, await loadContext(Date.now()));
    expect(r).toEqual({ added: 1, quarantined: 2, pairs: 1 });
    const items = await db.items.toArray();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'T10:1', type: 'T10', tags: ['verb.aspect.choice'] });
    const payload = items[0]!.payload as { sentence_ru: string; impf: string; pf: string; cue_ja: string };
    expect(payload).toMatchObject({ sentence_ru: 'Вчера я ___ всю книгу.', impf: 'читать', pf: 'прочитать', cue_ja: 'вчера＋結果' });
    expect((await db.quarantine.toArray()).map((q) => q.kind)).toEqual(['t10', 't10']);
  });

  it('schedules T10 in the weak slot once U14 is unlocked and grades aspect confusion', async () => {
    const now = await seedLearnedPair();
    const provider: AIProvider = {
      run: async <T>() => ({
        items: [{ sentence_ru: 'Вчера я ___ всю книгу.', impf: 'читать', pf: 'прочитать', correct: 'pf', feat: 'past.m', answer: 'прочитал', translation_ja: '昨日私は本を全部読んだ。', cue_ja: 'вчера＋結果' }],
      }) as T,
    };
    await runAspectItems(provider, await loadContext(now));
    await db.unitState.put({ unitId: 'U14', unlocked: true });

    let q: Question | undefined;
    for (let seed = 1; seed <= 40 && !q; seed++) {
      q = (await buildSession(await loadContext(now), { ttsAvailable: false, rng: rngFrom(seed) })).find((x) => x.type === 'T10');
    }
    if (q?.type !== 'T10') throw new Error('expected T10');
    expect(q).toMatchObject({ impf: 'читать', pf: 'прочитать', cue: 'вчера＋結果' });
    expect(q.partners?.map((p) => p.id)).toEqual(['v-читать']);
    expect(grade(q, { kind: 'text', text: 'прочитал' }, { yoLenient: true }).class).toBe('correct');
    const g = grade(q, { kind: 'text', text: 'читал' }, { yoLenient: true });
    expect(g).toMatchObject({ class: 'wrong_aspect', confusion: { expected: 'pf', given: 'impf' } });
    expect(g.tags).toEqual(expect.arrayContaining(['verb.aspect.choice', 'verb.aspect.pair']));
  });
});


describe('alternation card state (B1)', () => {
  const pisat: Lemma = {
    id: 'v-писать', bare: 'писать', accented: 'писа́ть', pos: 'verb', rank: 40, level: 'A1', aspect: 'impf',
    alt: { from: 'с', to: 'ш', scope: 'all' }, glossEn: ['write'],
    forms: { 'pres.1sg': f('пишу́'), 'pres.2sg': f('пи́шешь'), 'pres.3sg': f('пи́шет') },
  };

  it('shows the alternation card on the first attempt and not on later ones', async () => {
    await db.lemmas.put(toRow(pisat));
    const plan = { itemId: 'T3:v-писать:pres.1sg', type: 'T3' as const, lemmaId: 'v-писать', slot: 'weak' as const };
    const q1 = await buildQuestion(plan);
    if (q1?.type !== 'T3') throw new Error('expected T3');
    expect(q1.first).toBe(true);
    expect(q1.tags).toContain('verb.pres.alt');
    const g = grade(q1, { kind: 'text', text: q1.expected.primary }, { yoLenient: true });
    await recordAttempt({ question: q1, graded: g, rating: 3, latencyMs: 1000, hintCount: 0, now: Date.now() });
    const q2 = await buildQuestion(plan);
    if (q2?.type !== 'T3') throw new Error('expected T3');
    expect(q2.first).toBe(false);
  });

  it('puts plain verbs first in the U4 new slot until both conjugation tags have n >= 10', () => {
    const alt: Lemma = { ...pisat, id: 'v-alt' };
    const reflexive: Lemma = { ...pisat, id: 'v-ся', bare: 'учиться', alt: undefined };
    const plain: Lemma = { ...pisat, id: 'v-plain', bare: 'делать', alt: undefined };
    const nounL: Lemma = { ...noun('книг', 1), id: 'n-book' };
    const byId = new Map([alt, reflexive, plain, nounL].map((l) => [l.id, toRow(l)]));
    const st = (tag: string, n: number) => ({ tag, n, k: 0, acc: 0, lb: 0, weakness: 0, trend: 0 });
    const early = new Map([['verb.pres.conj1', st('verb.pres.conj1', 3)], ['verb.pres.conj2', st('verb.pres.conj2', 3)]]);
    expect(orderNewForU4(['v-alt', 'v-ся', 'v-plain', 'n-book'], byId, early)).toEqual(['v-plain', 'v-alt', 'v-ся', 'n-book']);
    const done = new Map([['verb.pres.conj1', st('verb.pres.conj1', 10)], ['verb.pres.conj2', st('verb.pres.conj2', 10)]]);
    expect(orderNewForU4(['v-alt', 'v-ся', 'v-plain'], byId, done)).toEqual(['v-alt', 'v-ся', 'v-plain']);
  });
});


describe('settings (B2)', () => {
  it('liveWarnings defaults to off', async () => {
    expect((await loadSettings()).liveWarnings).toBe(false);
    expect((await loadSettings()).spellExceptions).toEqual([]);
  });
});


describe('T9 adjective agreement (B4)', () => {
  const novyy: Lemma = {
    id: 'a-новый', bare: 'новый', accented: 'но́вый', pos: 'adj', rank: 10, level: 'A1', glossEn: ['new'],
    forms: { 'adj.nom.m': f('но́вый'), 'adj.nom.pl': f('но́вые'), 'adj.gen.pl': f('но́вых') },
  };

  it('builds a T9 question from the adjective and the matching noun form', async () => {
    await db.lemmas.put(toRow(novyy));
    const q = await buildQuestion({ itemId: 'T9:a-новый:n-книга:adj.nom.pl', type: 'T9', lemmaId: 'a-новый', slot: 'weak' });
    if (q?.type !== 'T9') throw new Error('expected T9');
    expect(q.expected.primary).toBe('но́вые');
    expect(q.noun.bare).toBe('книга');
    expect(q.nounForm.primary).toBe((await db.lemmas.get('n-книга'))!.forms['case.nom.pl']!.primary);
    expect(q.tags).toEqual(['adj.nom.pl']);
    expect(grade(q, { kind: 'text', text: 'новые' }, { yoLenient: true }).class).toBe('correct');
    expect(grade(q, { kind: 'text', text: 'новый' }, { yoLenient: true })).toMatchObject({
      class: 'wrong_form', confusion: { expected: 'adj.nom.pl', given: 'adj.nom.m' },
    });
  });

  it('starts a focused session with T9 items for an adjective tag', async () => {
    await db.lemmas.put(toRow(novyy));
    await db.unitState.put({ unitId: 'U7', unlocked: true });
    const qs = await buildSession(await loadContext(Date.now()), { ttsAvailable: false, rng: rngFrom(2), focusTag: 'adj.nom.pl' });
    expect(qs.length).toBeGreaterThanOrEqual(2);
    expect(qs[0]!.type).toBe('T9');
    expect(qs.every((q) => q.tags.includes('adj.nom.pl'))).toBe(true);
    expect(qs.length).toBeLessThanOrEqual(20);
  });
});


describe('typed accent recording (B5)', () => {
  it('stores stressOk on the attempt without changing the evaluation', async () => {
    const q = await buildQuestion({ itemId: 'T2:n-книга', type: 'T2', lemmaId: 'n-книга', slot: 'weak' });
    if (q?.type !== 'T2') throw new Error('expected T2');
    const g = grade(q, { kind: 'text', text: 'кни́га' }, { yoLenient: true });
    expect(g.class).toBe('correct');
    expect(g.stressOk).toBe(false);
    await recordAttempt({ question: q, graded: g, rating: 3, latencyMs: 1000, hintCount: 0, now: Date.now() });
    expect((await db.attempts.toArray()).at(-1)?.stressOk).toBe(false);
    const plain = grade(q, { kind: 'text', text: 'книга' }, { yoLenient: true });
    expect(plain.stressOk).toBeUndefined();
  });
});


describe('gender override (F1)', () => {
  it('stores the correction and re-applies it after a dictionary rebuild', async () => {
    await db.lemmas.put(toRow({ ...noun('дяд', 1), id: 'n-дядя', bare: 'дядя', accented: 'дя́дя', gender: 'f', genderInferred: true }));
    await setGenderOverride('n-дядя', 'm');
    expect(await db.lemmas.get('n-дядя')).toMatchObject({ gender: 'm' });
    expect((await db.lemmas.get('n-дядя'))?.genderInferred).toBeUndefined();
    expect((await loadSettings()).genderOverrides).toEqual({ 'n-дядя': 'm' });

    // A dictionary rebuild resets the row from dict.json; reapplyUserData restores the override.
    await db.lemmas.update('n-дядя', { gender: 'f', genderInferred: true });
    await reapplyUserData();
    expect(await db.lemmas.get('n-дядя')).toMatchObject({ gender: 'm' });
    expect((await db.lemmas.get('n-дядя'))?.genderInferred).toBeUndefined();
  });
});

describe('gloss dedupe and AI skip (F2)', () => {
  it('never appends AI glosses to user translations and dedupes stored glosses once', async () => {
    await createWordlist('f2', 'лампа	1. ランプ 2. 電灯／ランプ');
    expect((await db.lemmas.get('n-лампа'))?.glossJa).toBe('1. ランプ 2. 電灯／ランプ');

    expect(await saveGlosses({ 'n-лампа': '照明' }, { onlyIfMissing: true })).toBe(0);
    expect((await db.lemmas.get('n-лампа'))?.glossJa).not.toContain('照明');

    expect(await dedupeStoredGlosses()).toBe(1);
    expect((await db.lemmas.get('n-лампа'))?.glossJa).toBe('ランプ／電灯');
    expect((await loadSettings()).glossDedupDone).toBe(true);
    expect(await dedupeStoredGlosses()).toBe(0); // once only
  });
});


describe('T7 translation attempts', () => {
  it('stores the AI score with type T7 and no tags (never gates a unit)', async () => {
    const a = await recordT7Attempt({ itemId: 'T4:1', ja: '私はモスクワに住んでいます。', given: 'Я живу в Москве.', score: 0.5, corrected: 'Я живу в Москве.', now: 123 });
    expect(a).toMatchObject({ itemId: 'T7:T4:1', type: 'T7', score: 0.5, class: 'wrong', tags: [], prompt: '私はモスクワに住んでいます。' });
    expect(await db.attempts.get(a.id!)).toEqual(a);
  });
});


describe('tadoku lookup (M7)', () => {
  it('resolves headwords, inflected forms and unknown words', async () => {
    const exact = await lookupWord('книга');
    expect(exact.hits[0]).toMatchObject({ via: 'headword' });
    expect(exact.hits[0]!.lemma.id).toBe('n-книга');

    const inflected = await lookupWord('книге');
    expect(inflected.hits[0]).toMatchObject({ via: 'form' });
    expect(inflected.hits[0]!.lemma.id).toBe('n-книга');

    expect((await lookupWord('ъъъ')).hits).toEqual([]);
  });

  it('creates the 多読 list on first add and does not duplicate the same lemma', async () => {
    expect(await addToReadingList('n-книга')).toBe('added');
    expect(await addToReadingList('n-книга')).toBe('exists');
    const lists = await db.wordlists.toArray();
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ name: READING_LIST_NAME, active: true, entries: [{ lemmaId: 'n-книга' }] });
  });
});
