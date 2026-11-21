import { isCorrectClass } from './classify';
import type { Attempt } from './types';

export const DAY_MS = 86_400_000;
export const WINDOW_DAYS = 30;
const Z = 1.96;

/** Wilson score interval lower bound (z = 1.96). Returns 0 for n = 0. */
export function wilsonLB(k: number, n: number): number {
  if (n <= 0) return 0;
  const p = k / n;
  const z2 = Z * Z;
  return (p + z2 / (2 * n) - Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

export type TagStat = { tag: string; n: number; k: number; acc: number; lb: number; weakness: number; trend: number };

type StatAttempt = Pick<Attempt, 'ts' | 'class' | 'tags'> & { stressOk?: boolean };

/** Per-tag stats over the last 30 days. */
export function tagStats(attempts: StatAttempt[], now: number): Map<string, TagStat> {
  const acc = new Map<string, { n: number; k: number; rn: number; rk: number; on: number; ok: number }>();
  const from = now - WINDOW_DAYS * DAY_MS;
  const recentFrom = now - 7 * DAY_MS;
  for (const a of attempts) {
    if (a.ts < from || a.ts > now) continue;
    const ok = isCorrectClass(a.class) ? 1 : 0;
    const bump = (tag: string, good: number) => {
      let s = acc.get(tag);
      if (!s) acc.set(tag, (s = { n: 0, k: 0, rn: 0, rk: 0, on: 0, ok: 0 }));
      s.n++;
      s.k += good;
      if (a.ts >= recentFrom) {
        s.rn++;
        s.rk += good;
      } else {
        s.on++;
        s.ok += good;
      }
    };
    // A5: legacy attempts tagged "verb.aspect" are read as the aspect-pair tag.
    const tags = new Set(a.tags.map((t) => (t === 'verb.aspect' ? 'verb.aspect.pair' : t)));
    for (const tag of tags) bump(tag, ok);
    // B5: typed-accent answers also count for phon.stress (accent position decides the score there).
    if (a.stressOk !== undefined) bump('phon.stress', a.stressOk ? 1 : 0);
  }
  const out = new Map<string, TagStat>();
  for (const [tag, s] of acc) {
    const lb = wilsonLB(s.k, s.n);
    const trend = s.rn < 5 || s.on < 5 ? 0 : s.rk / s.rn - s.ok / s.on;
    out.set(tag, { tag, n: s.n, k: s.k, acc: s.k / s.n, lb, weakness: 1 - lb, trend });
  }
  return out;
}

export type ConfusionCount = { expected: string; given: string; n: number };

/** wrong_form confusions over the last 30 days, most frequent first. */
export function confusionCounts(attempts: Pick<Attempt, 'ts' | 'class' | 'confusion'>[], now: number): ConfusionCount[] {
  const from = now - WINDOW_DAYS * DAY_MS;
  const m = new Map<string, ConfusionCount>();
  for (const a of attempts) {
    if (a.ts < from || a.class !== 'wrong_form' || !a.confusion) continue;
    const key = `${a.confusion.expected}|${a.confusion.given}`;
    const c = m.get(key);
    if (c) c.n++;
    else m.set(key, { expected: a.confusion.expected, given: a.confusion.given, n: 1 });
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

/** Local-date key "YYYY-MM-DD". */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Attempts per day for the last `days` days (oldest first, includes today). */
export function dailyCounts(attempts: Pick<Attempt, 'ts'>[], now: number, days = 30): { day: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const a of attempts) counts.set(dayKey(a.ts), (counts.get(dayKey(a.ts)) ?? 0) + 1);
  const out: { day: string; count: number }[] = [];
  const d = new Date(startOfDay(now));
  d.setDate(d.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const key = dayKey(d.getTime());
    out.push({ day: key, count: counts.get(key) ?? 0 });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** Consecutive study days ending today (or yesterday when nothing was done yet today). */
export function streakDays(attempts: Pick<Attempt, 'ts'>[], now: number): number {
  const days = new Set(attempts.map((a) => dayKey(a.ts)));
  const d = new Date(startOfDay(now));
  if (!days.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1);
  let streak = 0;
  while (days.has(dayKey(d.getTime()))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}
