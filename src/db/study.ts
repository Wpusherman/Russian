import { computeUnlocked, currentUnit, unlockedTags, UNITS, type Unit } from '../content/units';
import { isCorrectClass } from '../core/classify';
import { aspectNote, fillBlank, glossOf, stressInfo, type Graded, type Question } from '../core/grade';
import { isNumeralEligible, numeralExpected, T11_NUMBERS } from '../core/numeral';
import { newFsrs, retrievability, review, STATE_REVIEW } from '../core/scheduler';
import {
  buildGenerator, itemIdT1, itemIdT2, itemIdT11, itemIdT9, parseItemId, planSession, stressable, vocabTags,
  type ExtraItem, type PlannedItem, type SessionCard,
} from '../core/session';
import { startOfDay, tagStats, type TagStat } from '../core/stats';
import { aspectBadge, expectedForm, prepTag, tagsForFeat } from '../core/tags';
import type { Attempt, RatingNum } from '../core/types';
import { normalize } from '../core/normalize';
import { db, type CardRow, type ItemRow, type LemmaRow, type T10Payload, type T4Payload, type UnitStateRow } from './db';
import { loadSettings, type Settings } from './settings';

export type StudyContext = {
  now: number;
  settings: Settings;
  attempts: Attempt[];
  cards: CardRow[];
  stats: Map<string, TagStat>;
  unitStates: Map<string, UnitStateRow>;
  unlocked: string[];
  current: Unit;
  weights: Record<string, number>;
  dueCount: number;
  newIntroducedToday: number;
  newRemainingToday: number;
};

/** Tag weights of the latest analysis, unless expired (14 days). A newer analysis replaces them. */
export async function activeWeights(now: number): Promise<Record<string, number>> {
  const last = await db.plans.orderBy('id').last();
  if (!last || last.expiresAt <= now) return {};
  return Object.fromEntries(last.weights.map((w) => [w.tag, w.w]));
}

export async function loadContext(now = Date.now()): Promise<StudyContext> {
  const [settings, attempts, cards, unitRows, weights] = await Promise.all([
    loadSettings(), db.attempts.toArray(), db.cards.toArray(), db.unitState.toArray(), activeWeights(now),
  ]);
  const stats = tagStats(attempts, now);
  const unitStates = new Map(unitRows.map((r) => [r.unitId, r]));
  const persisted = new Set(unitRows.filter((r) => r.unlocked).map((r) => r.unitId));
  const unlocked = computeUnlocked(stats, persisted);
  // Persist automatic unlocks so they are never lost when the 30-day window moves on.
  const fresh = unlocked.filter((id) => !persisted.has(id));
  if (fresh.length > 0) {
    await db.unitState.bulkPut(fresh.map((id) => ({ ...(unitStates.get(id) ?? { unitId: id }), unlocked: true })));
    for (const id of fresh) unitStates.set(id, { ...(unitStates.get(id) ?? { unitId: id }), unlocked: true });
  }
  const today = startOfDay(now);
  const newIntroducedToday = cards.filter((c) => c.type === 'T1' && c.createdAt >= today).length;
  return {
    now, settings, attempts, cards, stats, unitStates, unlocked, current: currentUnit(unlocked), weights,
    dueCount: cards.filter((c) => c.due <= now).length,
    newIntroducedToday,
    newRemainingToday: Math.max(0, settings.dailyNewLimit - newIntroducedToday),
  };
}

const LEVEL_ORDER = ['A1', 'A2', 'B1'];

/**
 * Unlearned lemma ids in priority order: active word lists first, then A1 -> A2 -> B1 by rank.
 * With `includeUnglossed`, words that cannot be asked yet (no Japanese / English gloss) are kept
 * as well, so the AI gloss task can fill them in.
 */
export async function newLemmaQueue(cards: CardRow[], limit = 200, opts: { includeUnglossed?: boolean } = {}): Promise<string[]> {
  const learned = new Set(cards.filter((c) => c.type === 'T1').map((c) => c.lemmaId));
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (!learned.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  // Words without any gloss cannot be asked as T1 (nothing to choose from), so they are skipped
  // unless the caller explicitly wants them (AI gloss generation).
  const usable = (r: LemmaRow) => opts.includeUnglossed || !!r.glossJa || r.glossEn.length > 0;
  const lists = (await db.wordlists.toArray()).filter((l) => l.active).sort((a, b) => a.priority - b.priority);
  const listIds = lists.flatMap((l) => l.entries.map((e) => e.lemmaId));
  const listRows = await db.lemmas.bulkGet(listIds);
  listRows.forEach((r) => { if (r && usable(r)) push(r.id); });
  if (out.length >= limit) return out.slice(0, limit);
  for (const level of LEVEL_ORDER) {
    const rows = await db.lemmas.where('level').equals(level).toArray();
    rows.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.id.localeCompare(b.id));
    for (const r of rows) if (!r.user && usable(r)) push(r.id);
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

/**
 * Up to `limit` words that lack a Japanese gloss (spec 12.3): user words / phrases from the active
 * word lists first, then the upcoming new words. English glosses are optional.
 */
export async function glossCandidates(cards: CardRow[], limit = 100): Promise<LemmaRow[]> {
  const out: LemmaRow[] = [];
  const seen = new Set<string>();
  const push = (r: LemmaRow | undefined) => {
    if (!r || r.glossJa || seen.has(r.id) || out.length >= limit) return;
    seen.add(r.id);
    out.push(r);
  };
  const lists = (await db.wordlists.toArray()).filter((l) => l.active).sort((a, b) => a.priority - b.priority);
  const userIds = [...new Set(lists.flatMap((l) => l.entries.map((e) => e.lemmaId)))];
  const userRows = await db.lemmas.bulkGet(userIds);
  userRows.filter((r): r is LemmaRow => !!r && !!r.user).forEach(push);
  if (out.length >= limit) return out;
  const ids = await newLemmaQueue(cards, limit, { includeUnglossed: true });
  const rows = await db.lemmas.bulkGet(ids);
  rows.forEach(push);
  return out;
}

const NUMERALS = new Set([
  'два', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'много', 'мало', 'несколько', 'сколько',
]);

/** Tags of a T4 item: feat tags + preposition / numeral right before the blank. */
export function t4Tags(lemma: LemmaRow, feat: string, sentence: string): string[] {
  const tags = new Set(tagsForFeat(lemma, feat));
  const before = sentence.split('___')[0] ?? '';
  const prev = before.trim().split(/\s+/).pop() ?? '';
  const p = prepTag(prev);
  if (p) tags.add(p);
  if (NUMERALS.has(normalize(prev))) tags.add('num.gov');
  return [...tags];
}

export function t6IdFor(t4ItemId: string): string {
  return `T6:${t4ItemId.replace(/^T4:/, '')}`;
}

function shuffle<T>(a: T[], rng: () => number): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function distractors(lemma: LemmaRow, rng: () => number): Promise<string[]> {
  const own = glossOf(lemma);
  const partnerIds = new Set(lemma.partnerIds ?? []);
  const pick = async (lo: number, hi: number) => {
    const rows = await db.lemmas.where('[pos+rank]').between([lemma.pos, lo], [lemma.pos, hi], true, true).toArray();
    const glosses = new Set<string>();
    for (const r of shuffle(rows, rng)) {
      const g = glossOf(r);
      // A2: never offer the aspect partner or a word with the same display gloss.
      if (r.id === lemma.id || partnerIds.has(r.id) || !g || g === own) continue;
      glosses.add(g + aspectBadge(r));
      if (glosses.size >= 3) break;
    }
    return [...glosses];
  };
  const rank = lemma.rank ?? 150;
  let out = await pick(Math.max(1, rank - 40), rank + 40);
  if (out.length < 3) out = await pick(1, Math.max(400, rank + 400));
  return out.slice(0, 3);
}

/** Other user words / phrases from the same word list(s): preferred T1 distractors for a phrase. */
async function phraseDistractors(lemma: LemmaRow, rng: () => number): Promise<string[]> {
  if (!lemma.user && !/\s/.test(lemma.bare)) return [];
  const lists = await db.wordlists.toArray();
  const ids = [...new Set(lists.filter((l) => l.entries.some((e) => e.lemmaId === lemma.id)).flatMap((l) => l.entries.map((e) => e.lemmaId)))];
  if (ids.length === 0) return [];
  const rows = await db.lemmas.bulkGet(ids);
  const own = glossOf(lemma);
  const out: string[] = [];
  for (const r of shuffle(rows.filter((x): x is LemmaRow => !!x), rng)) {
    if (r.id === lemma.id || (!r.user && !/\s/.test(r.bare))) continue;
    const g = glossOf(r);
    if (g && g !== own && !out.includes(g + aspectBadge(r))) out.push(g + aspectBadge(r));
    if (out.length >= 3) break;
  }
  return out;
}

async function partnersOf(lemma: LemmaRow): Promise<LemmaRow[]> {
  if (!lemma.partnerIds || lemma.partnerIds.length === 0) return [];
  return (await db.lemmas.bulkGet(lemma.partnerIds)).filter((x): x is LemmaRow => !!x);
}

/** Turn a planned item into a displayable question. Returns null when its data no longer exists. */
export async function buildQuestion(p: PlannedItem, rng: () => number = Math.random): Promise<Question | null> {
  const parsed = parseItemId(p.itemId);
  const { type, ref, feat } = parsed;
  if (type === 'T4' || type === 'T6' || type === 'T10') {
    const item = await db.items.get(type === 'T6' ? `T4:${ref}` : p.itemId);
    if (!item) return null;
    const lemma = await db.lemmas.get(item.payload.lemmaId);
    if (!lemma) return null;
    const pl = item.payload;
    const expected = lemma.forms[pl.feat] ?? { primary: pl.answer, variants: [] };
    if (type === 'T4') {
      return {
        type: 'T4', itemId: p.itemId, lemmaId: lemma.id, tags: item.tags, lemma, feat: pl.feat,
        sentence: pl.sentence_ru, translation: pl.translation_ja, explain: pl.explain_ja, expected,
        partners: await partnersOf(lemma),
      };
    }
    if (type === 'T10') {
      const t10 = pl as T10Payload;
      return {
        type: 'T10', itemId: p.itemId, lemmaId: lemma.id, tags: item.tags, lemma, feat: t10.feat,
        sentence: t10.sentence_ru, translation: t10.translation_ja, cue: t10.cue_ja, impf: t10.impf, pf: t10.pf,
        expected, partners: await partnersOf(lemma),
      };
    }
    return {
      type: 'T6', itemId: p.itemId, lemmaId: lemma.id, tags: ['vocab'],
      sentence: fillBlank(pl.sentence_ru, pl.answer), translation: pl.translation_ja,
    };
  }
  const lemma = await db.lemmas.get(ref);
  if (!lemma) return null;
  const base = { itemId: p.itemId, lemmaId: lemma.id };
  const gloss = glossOf(lemma);
  switch (type) {
    case 'T1': {
      if (!gloss) return null;
      const correctOption = gloss + aspectBadge(lemma);
      const phrase = await phraseDistractors(lemma, rng);
      const filler = phrase.length >= 3 ? [] : await distractors(lemma, rng);
      const wrong = [...new Set([...phrase, ...filler])].filter((g) => g !== correctOption).slice(0, 3);
      const options = shuffle([correctOption, ...wrong], rng);
      return { ...base, type: 'T1', tags: vocabTags(lemma), lemma, hint: lemma.hint, options, correct: options.indexOf(correctOption) };
    }
    case 'T2': {
      const partners = await partnersOf(lemma);
      const note = aspectNote(lemma, partners) ?? undefined;
      return {
        ...base, type: 'T2', tags: vocabTags(lemma), lemma, gloss, hint: lemma.hint,
        expected: { primary: lemma.accented, variants: [] }, partners, ...(note ? { note } : {}),
      };
    }
    case 'T3': {
      const expected = feat ? expectedForm(lemma, feat) : null;
      if (!feat || !expected) return null;
      const card = await db.cards.get(p.itemId);
      return {
        ...base, type: 'T3', tags: tagsForFeat(lemma, feat), lemma, feat, gloss, expected,
        partners: await partnersOf(lemma), first: (card?.reps ?? 0) === 0,
      };
    }
    case 'T5': {
      if (!stressable(lemma)) return null;
      return { ...base, type: 'T5', tags: ['phon.stress'], lemma, gloss, ...stressInfo(lemma.accented) };
    }
    case 'T9': {
      const noun = parsed.nounId ? await db.lemmas.get(parsed.nounId) : null;
      const expected = feat ? expectedForm(lemma, feat) : null;
      if (!noun || !feat || !expected) return null;
      const [, c, g] = feat.split('.');
      const nounForm = noun.forms[g === 'pl' ? `case.${c}.pl` : `case.${c}.sg`];
      if (!nounForm) return null;
      return {
        type: 'T9', itemId: p.itemId, lemmaId: lemma.id, tags: tagsForFeat(lemma, feat),
        adjective: lemma, noun, nounForm, feat, expected,
      };
    }
    case 'T11': {
      const n = Number(feat);
      const expected = Number.isFinite(n) ? numeralExpected(lemma, n) : null;
      if (!expected) return null;
      return { ...base, type: 'T11', tags: ['num.gov'], lemma, num: n, expected };
    }
  }
}

/** U4 new words: plain verbs first until both conjugation tags have n >= 10 (B1). */
export function orderNewForU4(ids: readonly string[], byId: ReadonlyMap<string, LemmaRow>, stats: ReadonlyMap<string, TagStat>): string[] {
  const need = (stats.get('verb.pres.conj1')?.n ?? 0) < 10 || (stats.get('verb.pres.conj2')?.n ?? 0) < 10;
  if (!need) return [...ids];
  const simple = (id: string) => {
    const l = byId.get(id);
    return !!l && l.pos === 'verb' && !l.alt && !/(ся|сь)$/.test(l.bare);
  };
  return [...ids.filter(simple), ...ids.filter((id) => !simple(id))];
}

/** Plan a session (spec section 10) and materialise its questions. */
export async function buildSession(ctx: StudyContext, opts: { ttsAvailable: boolean; rng?: () => number; focusTag?: string }): Promise<Question[]> {
  const rng = opts.rng ?? Math.random;
  const now = ctx.now;
  const usable = ctx.cards.filter((c) => opts.ttsAvailable || c.type !== 'T6');
  const cards: SessionCard[] = usable.map((c) => ({
    id: c.id, type: c.type, lemmaId: c.lemmaId, tags: c.tags, due: c.due, retrievability: retrievability(c, now),
  }));
  const today = startOfDay(now);
  const shownToday = new Set(ctx.attempts.filter((a) => a.ts >= today).map((a) => a.itemId));
  const t1Correct = new Set(ctx.cards.filter((c) => c.type === 'T2').map((c) => c.lemmaId));
  const reviewIds = ctx.cards.filter((c) => c.type === 'T1' && c.state === STATE_REVIEW).map((c) => c.lemmaId);
  const preferred = new Set(reviewIds);
  const [reviewLemmas, a1, a2, items, newQueue] = await Promise.all([
    db.lemmas.bulkGet(reviewIds), db.lemmas.where('level').equals('A1').toArray(),
    db.lemmas.where('level').equals('A2').toArray(), db.items.toArray(), newLemmaQueue(ctx.cards),
  ]);
  let newIds = newQueue;
  if (ctx.current.id === 'U4') {
    // B1: until both conjugation types have enough attempts, prefer verbs without an alternation / -ся.
    const rows = await db.lemmas.bulkGet(newIds);
    const byId = new Map(rows.filter((r): r is LemmaRow => !!r).map((r) => [r.id, r]));
    newIds = orderNewForU4(newIds, byId, ctx.stats);
  }
  const pool = new Map<string, LemmaRow>();
  for (const l of [...reviewLemmas, ...a1]) if (l) pool.set(l.id, l);

  const tagsUnlocked = unlockedTags(ctx.unlocked);
  const unlockedSet = new Set(tagsUnlocked);
  const hasCard = new Set(ctx.cards.map((c) => c.id));
  // T4 items that were never asked are offered through the weak slot once their grammar tags are unlocked.
  const extra: ExtraItem[] = items
    .filter((it) => !hasCard.has(it.id))
    .filter((it) => it.tags.filter((t) => !t.startsWith('spell.')).every((t) => unlockedSet.has(t)))
    .map((it) => ({ item: { itemId: it.id, type: it.type, lemmaId: it.payload.lemmaId, slot: 'weak' }, tags: it.tags }));
  const a12 = [...a1, ...a2];
  // T11 numeral items are generated locally (no AI): a few numbers for a sample of A1-A2 nouns.
  for (const lemma of shuffle(a12.filter(isNumeralEligible), rng).slice(0, 40)) {
    const nums = shuffle(T11_NUMBERS.filter((n) => numeralExpected(lemma, n)), rng).slice(0, 3);
    for (const n of nums) {
      extra.push({ item: { itemId: itemIdT11(lemma.id, n), type: 'T11', lemmaId: lemma.id, slot: 'weak' }, tags: ['num.gov'] });
    }
  }

  // B4: T9 adjective-agreement items for every unlocked adj.<case>.<gender> tag.
  const adjRows = a12.filter((l) => l.pos === 'adj');
  const nounRows = a12.filter((l) => l.pos === 'noun');
  let t9Count = 0;
  for (const tag of shuffle([...unlockedSet].filter((t) => /^adj\.(nom|gen|dat|acc|ins|prep)\.(m|f|n|pl)$/.test(t)), rng)) {
    if (t9Count >= 80) break;
    const [, c, g] = tag.split('.');
    const feat = `adj.${c}.${g}`;
    const nouns = nounRows.filter((n) => (g === 'pl' ? !!n.forms[`case.${c}.pl`] : n.gender === g && !!n.forms[`case.${c}.sg`]));
    if (nouns.length === 0) continue;
    for (const adj of shuffle(adjRows.filter((l) => !!l.forms[feat]), rng).slice(0, 4)) {
      if (t9Count >= 80) break;
      const noun = nouns[Math.floor(rng() * nouns.length)]!;
      extra.push({ item: { itemId: itemIdT9(adj.id, noun.id, feat), type: 'T9', lemmaId: adj.id, slot: 'weak' }, tags: tagsForFeat(adj, feat) });
      t9Count++;
    }
  }

  const generate = buildGenerator([...pool.values()], preferred, t1Correct, rng, extra, unlockedSet);
  let plan: PlannedItem[];
  if (opts.focusTag) {
    const tag = opts.focusTag;
    const focus: PlannedItem[] = [];
    const takenFocus = new Set<string>();
    if (tag.startsWith('adj.')) {
      // T9 is preferred for adjective tags (B4).
      for (const it of shuffle(extra.filter((e) => e.item.type === 'T9' && e.tags.includes(tag)).map((e) => e.item), rng)) {
        if (focus.length >= ctx.settings.sessionSize) break;
        focus.push(it);
        takenFocus.add(it.itemId);
      }
    }
    while (focus.length < ctx.settings.sessionSize) {
      const it = generate(tag, takenFocus);
      if (!it) break;
      takenFocus.add(it.itemId);
      focus.push(it);
    }
    plan = focus;
  } else {
    plan = planSession({
      now, sessionSize: ctx.settings.sessionSize, cards, shownToday, tagStats: ctx.stats,
      unlockedTags: tagsUnlocked, currentUnitTags: ctx.current.tags, tagWeights: ctx.weights,
      newLemmaIds: newIds, newRemainingToday: ctx.newRemainingToday,
      generate, rng,
    });
  }
  const questions: Question[] = [];
  for (const p of plan) {
    const q = await buildQuestion(p, rng);
    if (q) questions.push(q);
  }
  return questions;
}

export type RecordInput = { question: Question; graded: Graded; rating: RatingNum; latencyMs: number; hintCount: number; now?: number };

/** Store the attempt and update (or create) the FSRS card. */
export async function recordAttempt(input: RecordInput): Promise<Attempt> {
  const now = input.now ?? Date.now();
  const { question: q, graded } = input;
  const attempt: Attempt = {
    itemId: q.itemId, ts: now, type: q.type, given: graded.given, class: graded.class, rating: input.rating,
    latencyMs: Math.round(input.latencyMs), hintCount: input.hintCount, tags: graded.tags,
    prompt: graded.prompt, expected: graded.expected,
  };
  if (graded.confusion) attempt.confusion = graded.confusion;
  if (graded.stressOk !== undefined) attempt.stressOk = graded.stressOk;
  await db.transaction('rw', db.attempts, db.cards, async () => {
    attempt.id = await db.attempts.add(attempt);
    const existing = await db.cards.get(q.itemId);
    const base: CardRow = existing ?? { id: q.itemId, type: q.type, lemmaId: q.lemmaId, tags: q.tags, createdAt: now, ...newFsrs(now) };
    await db.cards.put({ ...base, tags: q.tags, ...review(base, input.rating, now) });
    if (!isCorrectClass(graded.class)) return;
    // Gates: T2 opens after the first correct T1, T6 (dictation) after the first correct T4.
    const follow = q.type === 'T1' ? { id: itemIdT2(q.lemmaId), type: 'T2' as const, tags: q.tags }
      : q.type === 'T4' ? { id: t6IdFor(q.itemId), type: 'T6' as const, tags: ['vocab'] }
      : null;
    if (follow && !(await db.cards.get(follow.id))) {
      await db.cards.put({ ...follow, lemmaId: q.lemmaId, createdAt: now, ...newFsrs(now) });
    }
  });
  return attempt;
}

/** Register a validated fill-in item (T4). */
export async function addT4Item(payload: T4Payload, lemma: LemmaRow, source: 'ai' | 'user', now = Date.now()): Promise<ItemRow> {
  const all = await db.items.toArray();
  const dup = all.find((i) => i.payload.sentence_ru === payload.sentence_ru && i.payload.lemmaId === payload.lemmaId && i.payload.feat === payload.feat);
  if (dup) return dup;
  const next = all.reduce((m, i) => Math.max(m, Number(i.id.slice(3)) || 0), 0) + 1;
  const row: ItemRow = {
    id: `T4:${next}`, type: 'T4', payload, tags: t4Tags(lemma, payload.feat, payload.sentence_ru), source, createdAt: now,
  };
  await db.items.add(row);
  return row;
}

/** Register a validated aspect-choice item (T10). */
export async function addT10Item(payload: T10Payload, now = Date.now()): Promise<ItemRow> {
  const all = await db.items.toArray();
  const dup = all.find((i) => i.type === 'T10' && i.payload.sentence_ru === payload.sentence_ru);
  if (dup) return dup;
  const next = all.filter((i) => i.type === 'T10').reduce((m, i) => Math.max(m, Number(i.id.slice(4)) || 0), 0) + 1;
  const row: ItemRow = { id: `T10:${next}`, type: 'T10', payload, tags: ['verb.aspect.choice'], source: 'ai', createdAt: now };
  await db.items.add(row);
  return row;
}

export async function setUnitState(unitId: string, patch: Partial<UnitStateRow>): Promise<void> {
  const cur = (await db.unitState.get(unitId)) ?? { unitId, unlocked: unitId === UNITS[0]!.id };
  await db.unitState.put({ ...cur, ...patch, unitId });
}

export { itemIdT1 };
