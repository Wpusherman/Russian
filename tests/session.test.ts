import { describe, expect, it } from 'vitest';
import { computeUnlocked, currentUnit, UNITS, unitMastered } from '../src/content/units';
import { newFsrs, retrievability, review } from '../src/core/scheduler';
import {
  allocateSlots, interleave, parseItemId, planSession, separateLemmas,
  type Generator, type PlanInput, type PlannedItem, type SessionCard,
} from '../src/core/session';
import type { TagStat } from '../src/core/stats';

function rngFrom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const NOW = Date.UTC(2026, 5, 30);
const card = (i: number, over: Partial<SessionCard> = {}): SessionCard => ({
  id: `T1:w${i}`, type: 'T1', lemmaId: `w${i}`, tags: ['vocab'], due: NOW - 1000, retrievability: 0.5 + i / 1000, ...over,
});
const stat = (tag: string, n: number, k: number): TagStat => ({ tag, n, k, acc: k / n, lb: 0, weakness: 1 - k / n, trend: 0 });

const genT3: Generator = (tag, exclude) => {
  for (let i = 0; i < 500; i++) {
    const itemId = `T3:g${i}:${tag}`;
    if (!exclude.has(itemId)) return { itemId, type: 'T3', lemmaId: `g${i}`, slot: 'weak' };
  }
  return null;
};

const baseInput = (over: Partial<PlanInput> = {}): PlanInput => ({
  now: NOW, sessionSize: 20, cards: [], shownToday: new Set(), tagStats: new Map(),
  unlockedTags: ['noun.gen.sg', 'noun.acc.sg'], currentUnitTags: ['noun.gen.sg'], tagWeights: {},
  newLemmaIds: Array.from({ length: 50 }, (_, i) => `new${i}`), newRemainingToday: 15,
  generate: genT3, rng: rngFrom(1), ...over,
});
const count = (items: PlannedItem[]) => ({
  review: items.filter((i) => i.slot === 'review').length,
  weak: items.filter((i) => i.slot === 'weak').length,
  new: items.filter((i) => i.slot === 'new').length,
});

describe('allocateSlots', () => {
  it('60/30/10 with floor, remainder to review', () => {
    expect(allocateSlots(20)).toEqual({ review: 12, weak: 6, new: 2 });
    expect(allocateSlots(10)).toEqual({ review: 6, weak: 3, new: 1 });
    expect(allocateSlots(15)).toEqual({ review: 10, weak: 4, new: 1 });
    expect(allocateSlots(25)).toEqual({ review: 16, weak: 7, new: 2 });
    expect(allocateSlots(50)).toEqual({ review: 30, weak: 15, new: 5 });
    for (let n = 10; n <= 50; n++) {
      const a = allocateSlots(n);
      expect(a.review + a.weak + a.new).toBe(n);
    }
  });
});

describe('planSession', () => {
  it('fills 12 / 6 / 2 when everything is available', () => {
    const cards = Array.from({ length: 40 }, (_, i) => card(i));
    const plan = planSession(baseInput({ cards, tagStats: new Map([['noun.gen.sg', stat('noun.gen.sg', 10, 4)]]) }));
    expect(plan).toHaveLength(20);
    expect(count(plan)).toEqual({ review: 12, weak: 6, new: 2 });
    expect(new Set(plan.map((p) => p.itemId)).size).toBe(20);
  });

  it('takes due reviews in ascending retrievability', () => {
    const cards = Array.from({ length: 40 }, (_, i) => card(i, { retrievability: 1 - i / 100 }));
    const plan = planSession(baseInput({ cards }));
    const ids = plan.filter((p) => p.slot === 'review').map((p) => p.itemId).sort();
    expect(ids).toEqual(Array.from({ length: 12 }, (_, i) => `T1:w${39 - i}`).sort());
  });

  it('first day: no cards -> weak from the current unit, then new', () => {
    const plan = planSession(baseInput());
    expect(plan).toHaveLength(20);
    expect(count(plan)).toEqual({ review: 0, weak: 18, new: 2 });
    expect(plan.filter((p) => p.slot === 'weak').every((p) => p.itemId.endsWith(':noun.gen.sg'))).toBe(true);
  });

  it('shortfall order: weak -> new -> early reviews', () => {
    const notDue = Array.from({ length: 30 }, (_, i) => card(i, { due: NOW + 86_400_000, retrievability: 0.9 + i / 1000 }));
    const plan = planSession(baseInput({ cards: notDue, generate: () => null, newRemainingToday: 5 }));
    expect(plan).toHaveLength(20);
    // no due cards, no weak items -> 5 new (daily limit), rest are early reviews (lowest retrievability first)
    expect(count(plan)).toEqual({ review: 15, weak: 0, new: 5 });
    const early = plan.filter((p) => p.slot === 'review').map((p) => p.itemId).sort();
    expect(early).toEqual(Array.from({ length: 15 }, (_, i) => `T1:w${i}`).sort());
  });

  it('respects the daily new limit', () => {
    const plan = planSession(baseInput({ newRemainingToday: 0, generate: () => null }));
    expect(plan).toHaveLength(0);
    const plan2 = planSession(baseInput({ newRemainingToday: 1, cards: Array.from({ length: 40 }, (_, i) => card(i)) }));
    expect(count(plan2).new).toBe(1);
  });

  it('weak slot only uses unlocked tags with n >= 3, weighted by weakness x tagWeight', () => {
    const tagStats = new Map([
      ['noun.gen.sg', stat('noun.gen.sg', 10, 5)],
      ['noun.acc.sg', stat('noun.acc.sg', 10, 5)],
      ['noun.dat.sg', stat('noun.dat.sg', 10, 0)], // locked
      ['noun.prep.sg', stat('noun.prep.sg', 2, 0)], // n < 3
    ]);
    let gen = 0;
    let acc = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const plan = planSession(baseInput({ tagStats, tagWeights: { 'noun.gen.sg': 3 }, rng: rngFrom(seed) }));
      for (const p of plan.filter((x) => x.slot === 'weak')) {
        const feat = parseItemId(p.itemId).feat;
        expect(['noun.gen.sg', 'noun.acc.sg']).toContain(feat);
        if (feat === 'noun.gen.sg') gen++;
        else acc++;
      }
    }
    expect(gen / acc).toBeGreaterThan(2);
    expect(gen / acc).toBeLessThan(4.5);
  });

  it('weak slot prefers existing cards of the tag not shown today', () => {
    const tagStats = new Map([['noun.gen.sg', stat('noun.gen.sg', 10, 5)]]);
    const cards = [
      card(1, { id: 'T3:a:case.gen.sg', type: 'T3', lemmaId: 'a', tags: ['noun.gen.sg'], due: NOW + 1e9 }),
      card(2, { id: 'T3:b:case.gen.sg', type: 'T3', lemmaId: 'b', tags: ['noun.gen.sg'], due: NOW + 1e9 }),
    ];
    const plan = planSession(baseInput({ cards, tagStats, shownToday: new Set(['T3:b:case.gen.sg']), sessionSize: 10 }));
    const weak = plan.filter((p) => p.slot === 'weak').map((p) => p.itemId);
    expect(weak).toContain('T3:a:case.gen.sg');
    expect(weak).not.toContain('T3:b:case.gen.sg');
  });

  it('never puts the same lemma twice in a row and never repeats an item', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const cards = Array.from({ length: 30 }, (_, i) => card(i, { lemmaId: `w${i % 8}` }));
      const gen: Generator = (tag, ex) => {
        for (let i = 0; i < 100; i++) {
          const itemId = `T3:w${i % 8}:${tag}${i}`;
          if (!ex.has(itemId)) return { itemId, type: 'T3', lemmaId: `w${i % 8}`, slot: 'weak' };
        }
        return null;
      };
      const plan = planSession(baseInput({ cards, generate: gen, rng: rngFrom(seed) }));
      expect(plan).toHaveLength(20);
      expect(new Set(plan.map((p) => p.itemId)).size).toBe(20);
      for (let i = 1; i < plan.length; i++) expect(plan[i]!.lemmaId, `seed ${seed} pos ${i}`).not.toBe(plan[i - 1]!.lemmaId);
    }
  });
});

describe('interleave', () => {
  const mk = (slot: PlannedItem['slot'], n: number): PlannedItem[] =>
    Array.from({ length: n }, (_, i) => ({ itemId: `${slot}${i}`, type: 'T1', lemmaId: `${slot}${i}`, slot }));
  it('mixes the three slots instead of concatenating them', () => {
    const out = interleave([mk('review', 12), mk('weak', 6), mk('new', 2)]);
    expect(out).toHaveLength(20);
    expect(count(out.slice(0, 10))).toEqual({ review: 6, weak: 3, new: 1 });
  });
  it('separateLemmas fixes adjacent duplicates when possible', () => {
    const items: PlannedItem[] = ['a', 'a', 'b', 'c', 'c', 'd'].map((l, i) => ({ itemId: `i${i}`, type: 'T1', lemmaId: l, slot: 'review' }));
    const out = separateLemmas(items);
    for (let i = 1; i < out.length; i++) expect(out[i]!.lemmaId).not.toBe(out[i - 1]!.lemmaId);
  });
});

describe('scheduler (FSRS)', () => {
  it('schedules and reports retrievability', () => {
    let f = newFsrs(NOW);
    expect(f.state).toBe(0);
    expect(retrievability(f, NOW)).toBe(0);
    f = review(f, 3, NOW);
    expect(f.reps).toBe(1);
    expect(f.due).toBeGreaterThan(NOW);
    f = review(f, 3, f.due);
    f = review(f, 3, f.due);
    expect(f.state).toBe(2);
    const r0 = retrievability(f, f.last_review!);
    const rDue = retrievability(f, f.due);
    expect(r0).toBeCloseTo(1, 5);
    expect(rDue).toBeGreaterThan(0.8);
    expect(rDue).toBeLessThan(0.97);
    const again = review(f, 1, f.due);
    expect(again.lapses).toBe(1);
  });
});

describe('units', () => {
  const ok = (tag: string): [string, TagStat] => [tag, stat(tag, 20, 20)];
  it('has 15 units in order with U1 always unlocked', () => {
    expect(UNITS.map((u) => u.id)).toEqual(Array.from({ length: 15 }, (_, i) => `U${i + 1}`));
    expect(computeUnlocked(new Map(), new Set())).toEqual(['U1']);
  });
  it('unlocks the next unit when every tag has n >= 10 and LB >= 0.75', () => {
    const u1 = UNITS[0]!;
    const full = new Map(u1.tags.map(ok));
    expect(unitMastered(u1, full)).toBe(true);
    expect(computeUnlocked(full, new Set())).toEqual(['U1', 'U2']);
    const partial = new Map(u1.tags.slice(1).map(ok));
    expect(computeUnlocked(partial, new Set())).toEqual(['U1']);
    const low = new Map(full);
    low.set(u1.tags[0]!, stat(u1.tags[0]!, 10, 8)); // LB 0.49
    expect(computeUnlocked(low, new Set())).toEqual(['U1']);
    const few = new Map(full);
    few.set(u1.tags[0]!, stat(u1.tags[0]!, 9, 9)); // n < 10
    expect(computeUnlocked(few, new Set())).toEqual(['U1']);
  });
  it('keeps manual unlocks and picks the last unlocked unit as current', () => {
    const unlocked = computeUnlocked(new Map(), new Set(['U5']));
    expect(unlocked).toEqual(['U1', 'U5']);
    expect(currentUnit(unlocked).id).toBe('U5');
  });
});
