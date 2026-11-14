import { isVowel, normalize, stripAccent } from './normalize';
import type { TagStat } from './stats';
import { ASPECT_FEAT, PERSONAL_PRONOUNS, POSSESSIVES, drillFeats, tagsForFeat } from './tags';
import { GENDER_FEAT, type FeatKey, type ItemType, type Lemma } from './types';

export type Slot = 'review' | 'weak' | 'new';
export type PlannedItem = { itemId: string; type: ItemType; lemmaId: string; slot: Slot };
export type SessionCard = {
  id: string;
  type: ItemType;
  lemmaId: string;
  tags: string[];
  due: number;
  retrievability: number;
};

export type Rng = () => number;

// ---------- item ids ----------

export function itemIdT1(lemmaId: string): string { return `T1:${lemmaId}`; }
export function itemIdT2(lemmaId: string): string { return `T2:${lemmaId}`; }
export function itemIdT3(lemmaId: string, feat: FeatKey): string { return `T3:${lemmaId}:${feat}`; }
export function itemIdT5(lemmaId: string): string { return `T5:${lemmaId}`; }

export function parseItemId(id: string): { type: ItemType; ref: string; feat?: FeatKey } {
  const i = id.indexOf(':');
  const type = id.slice(0, i) as ItemType;
  const rest = id.slice(i + 1);
  if (type === 'T3') {
    const j = rest.indexOf(':');
    return { type, ref: rest.slice(0, j), feat: rest.slice(j + 1) };
  }
  return { type, ref: rest };
}

// ---------- slot allocation ----------

/** review 60% / weak 30% / new 10%; fractions are floored and the remainder goes to review. */
export function allocateSlots(size: number): { review: number; weak: number; new: number } {
  const weak = Math.floor(size * 0.3);
  const nw = Math.floor(size * 0.1);
  return { review: size - weak - nw, weak, new: nw };
}

// ---------- weighted choice ----------

export function weightedPick<T>(items: T[], weight: (t: T) => number, rng: Rng): T | null {
  const ws = items.map((t) => Math.max(0, weight(t)));
  const total = ws.reduce((a, b) => a + b, 0);
  if (items.length === 0) return null;
  if (total <= 0) return items[Math.floor(rng() * items.length)] ?? null;
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= ws[i]!;
    if (r < 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

// ---------- tag-driven item generator ----------

export function vocabTags(lemma: Lemma): string[] {
  const bare = normalize(lemma.bare);
  const tags = ['vocab'];
  if (PERSONAL_PRONOUNS.includes(bare) && lemma.pos === 'other') tags.push('pron.personal');
  if (POSSESSIVES.includes(bare)) tags.push('pron.possessive');
  return tags;
}

/** A word can be used for the stress task when it is marked and has at least two vowels. */
export function stressable(lemma: Lemma): boolean {
  if (!lemma.accented.includes('\u0301')) return false;
  return [...stripAccent(lemma.accented)].filter(isVowel).length >= 2;
}

export type ExtraItem = { item: PlannedItem; tags: string[] };
export type Generator = (tag: string, exclude: ReadonlySet<string>) => PlannedItem | null;

/**
 * Builds the generator used by the weak slot: for a tag, produce an item that exercises it.
 * `pool` should hold the lemmas whose T1 is in Review state plus the level-A1 lemmas;
 * lemmas in `preferred` (T1 in Review) are tried first.
 */
export function buildGenerator(
  pool: Lemma[],
  preferred: ReadonlySet<string>,
  t1Correct: ReadonlySet<string>,
  rng: Rng,
  /** Ready-made items (unasked T4 sentences); tried before generated T3 every other time. */
  extra: ExtraItem[] = [],
  /** Unlocked tags: items whose grammar tags are all unlocked are tried first. */
  unlocked?: ReadonlySet<string>,
): Generator {
  // Lower score = tried earlier: grammar scope first, then "T1 in Review" before the other A1 words.
  const byTag = new Map<string, { item: PlannedItem; score: number }[]>();
  const scopeTier = (tags: string[], feat: string): number => {
    if (!unlocked || tags.filter((t) => !t.startsWith('spell.')).every((t) => unlocked.has(t))) return 0;
    return /^(case\.nom\.pl|adj\.nom\.|pres\.)/.test(feat) ? 1 : 2;
  };
  const extraByTag = new Map<string, PlannedItem[]>();
  for (const e of extra) for (const tag of e.tags) {
    const l = extraByTag.get(tag);
    if (l) l.push(e.item);
    else extraByTag.set(tag, [e.item]);
  }
  const add = (tag: string, item: PlannedItem, isPref: boolean, tier = 0) => {
    let e = byTag.get(tag);
    if (!e) byTag.set(tag, (e = []));
    e.push({ item, score: tier * 2 + (isPref ? 0 : 1) });
  };
  for (const lemma of pool) {
    const isPref = preferred.has(lemma.id);
    for (const feat of drillFeats(lemma)) {
      if (feat === GENDER_FEAT && lemma.gender === 'pl') continue;
      const item: PlannedItem = { itemId: itemIdT3(lemma.id, feat), type: 'T3', lemmaId: lemma.id, slot: 'weak' };
      const tags = tagsForFeat(lemma, feat);
      const tier = scopeTier(tags, feat);
      for (const tag of tags) add(tag, item, isPref, tier);
    }
    if (stressable(lemma)) {
      add('phon.stress', { itemId: itemIdT5(lemma.id), type: 'T5', lemmaId: lemma.id, slot: 'weak' }, isPref);
    }
    for (const tag of vocabTags(lemma)) {
      if (tag === 'vocab') continue;
      // Pronoun tags are practised as vocabulary cards (T1 first, T2 once T1 was answered correctly).
      const known = t1Correct.has(lemma.id);
      add(tag, {
        itemId: known ? itemIdT2(lemma.id) : itemIdT1(lemma.id), type: known ? 'T2' : 'T1', lemmaId: lemma.id, slot: 'weak',
      }, isPref);
    }
  }
  return (tag, exclude) => {
    const e = byTag.get(tag);
    const ready = (extraByTag.get(tag) ?? []).filter((it) => !exclude.has(it.itemId));
    if (ready.length > 0 && (!e || rng() < 0.5)) return ready[Math.floor(rng() * ready.length)]!;
    if (!e) return null;
    const free = e.filter((x) => !exclude.has(x.item.itemId));
    if (free.length === 0) return null;
    const best = free.reduce((m, x) => Math.min(m, x.score), Infinity);
    const top = free.filter((x) => x.score === best);
    return top[Math.floor(rng() * top.length)]!.item;
  };
}

export { ASPECT_FEAT };

// ---------- session planning ----------

export type PlanInput = {
  now: number;
  sessionSize: number;
  /** Every existing card (with retrievability computed for `now`). */
  cards: SessionCard[];
  /** Item ids already asked today. */
  shownToday: ReadonlySet<string>;
  tagStats: ReadonlyMap<string, TagStat>;
  /** Tags of all unlocked units. */
  unlockedTags: readonly string[];
  /** Tags of the current unit (fallback when no tag has n >= 3). */
  currentUnitTags: readonly string[];
  /** AI tag weights (default 1). */
  tagWeights: Readonly<Record<string, number>>;
  /** Unlearned lemma ids in priority order (word lists first, then A1 -> A2 -> B1 by rank). */
  newLemmaIds: readonly string[];
  /** dailyNewLimit minus the new words already introduced today. */
  newRemainingToday: number;
  generate: Generator;
  rng: Rng;
};

export const WEAK_MIN_N = 3;

function cardToItem(c: SessionCard, slot: Slot): PlannedItem {
  return { itemId: c.id, type: c.type, lemmaId: c.lemmaId, slot };
}

function pickWeak(input: PlanInput, target: number, taken: Set<string>): PlannedItem[] {
  const out: PlannedItem[] = [];
  if (target <= 0) return out;
  const unlocked = new Set(input.unlockedTags);
  let tags = [...input.tagStats.values()].filter((s) => unlocked.has(s.tag) && s.n >= WEAK_MIN_N).map((s) => s.tag);
  if (tags.length === 0) tags = [...input.currentUnitTags];
  const weightOf = (tag: string) => (input.tagStats.get(tag)?.weakness ?? 1) * (input.tagWeights[tag] ?? 1);
  const cardsByTag = new Map<string, SessionCard[]>();
  for (const c of input.cards) for (const t of c.tags) {
    const l = cardsByTag.get(t);
    if (l) l.push(c);
    else cardsByTag.set(t, [c]);
  }
  let pool = tags;
  while (out.length < target && pool.length > 0) {
    const tag = weightedPick(pool, weightOf, input.rng);
    if (tag === null) break;
    // Prefer an existing card with this tag that has not been asked today.
    const cands = (cardsByTag.get(tag) ?? []).filter((c) => !taken.has(c.id) && !input.shownToday.has(c.id));
    let item: PlannedItem | null = null;
    if (cands.length > 0) {
      cands.sort((a, b) => a.retrievability - b.retrievability);
      item = cardToItem(cands[0]!, 'weak');
    } else {
      item = input.generate(tag, taken);
    }
    if (!item) {
      pool = pool.filter((t) => t !== tag); // nothing left for this tag
      continue;
    }
    taken.add(item.itemId);
    out.push({ ...item, slot: 'weak' });
  }
  return out;
}

/** Interleave the three slots proportionally, then break up adjacent items of the same lemma. */
export function interleave(groups: PlannedItem[][]): PlannedItem[] {
  const queues = groups.map((g) => ({ items: g, taken: 0 }));
  const total = queues.reduce((a, q) => a + q.items.length, 0);
  const out: PlannedItem[] = [];
  while (out.length < total) {
    let best: (typeof queues)[number] | null = null;
    let bestScore = -1;
    for (const q of queues) {
      if (q.taken >= q.items.length) continue;
      const score = (q.items.length - q.taken) / q.items.length; // largest remaining fraction first
      if (score > bestScore) {
        best = q;
        bestScore = score;
      }
    }
    if (!best) break;
    out.push(best.items[best.taken++]!);
  }
  return separateLemmas(out);
}

export function separateLemmas(items: PlannedItem[]): PlannedItem[] {
  const a = [...items];
  const clash = (i: number) => i > 0 && a[i]!.lemmaId === a[i - 1]!.lemmaId;
  for (let i = 1; i < a.length; i++) {
    if (!clash(i)) continue;
    for (let j = 0; j < a.length; j++) {
      if (j === i || j === i - 1) continue;
      const fitsAtI = a[j]!.lemmaId !== a[i - 1]!.lemmaId && (i + 1 >= a.length || j === i + 1 || a[j]!.lemmaId !== a[i + 1]!.lemmaId);
      const lem = a[i]!.lemmaId;
      const fitsAtJ = (j === 0 || a[j - 1]!.lemmaId !== lem || j - 1 === i) && (j + 1 >= a.length || a[j + 1]!.lemmaId !== lem || j + 1 === i);
      if (fitsAtI && fitsAtJ) {
        [a[i], a[j]] = [a[j]!, a[i]!];
        if (!clash(i) && !clash(j) && !(j + 1 < a.length && clash(j + 1)) && !(i + 1 < a.length && clash(i + 1))) break;
        [a[i], a[j]] = [a[j]!, a[i]!]; // undo
      }
    }
  }
  return a;
}

/** Spec section 10. */
export function planSession(input: PlanInput): PlannedItem[] {
  const size = input.sessionSize;
  const alloc = allocateSlots(size);
  const taken = new Set<string>();
  const byR = (a: SessionCard, b: SessionCard) => a.retrievability - b.retrievability || a.due - b.due;

  // Review: due cards, lowest retrievability first.
  const due = input.cards.filter((c) => c.due <= input.now).sort(byR);
  const review = due.slice(0, alloc.review).map((c) => cardToItem(c, 'review'));
  review.forEach((r) => taken.add(r.itemId));

  // Weak (absorbs the review shortfall first).
  const weakTarget = alloc.weak + (alloc.review - review.length);
  const weak = pickWeak(input, weakTarget, taken);

  // New (absorbs the weak shortfall), bounded by the daily limit.
  const newTarget = Math.min(alloc.new + (weakTarget - weak.length), Math.max(0, input.newRemainingToday));
  const fresh: PlannedItem[] = [];
  for (const lemmaId of input.newLemmaIds) {
    if (fresh.length >= newTarget) break;
    const itemId = itemIdT1(lemmaId);
    if (taken.has(itemId)) continue;
    taken.add(itemId);
    fresh.push({ itemId, type: 'T1', lemmaId, slot: 'new' });
  }

  // Still short: reviews ahead of schedule (remaining due cards first, then not-yet-due), lowest retrievability first.
  let missing = size - review.length - weak.length - fresh.length;
  if (missing > 0) {
    const rest = [
      ...due.filter((c) => !taken.has(c.id)),
      ...input.cards.filter((c) => c.due > input.now && !taken.has(c.id)).sort(byR),
    ];
    for (const c of rest) {
      if (missing <= 0) break;
      taken.add(c.id);
      review.push(cardToItem(c, 'review'));
      missing--;
    }
  }
  return interleave([review, weak, fresh]);
}
