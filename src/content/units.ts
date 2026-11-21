import { expandTagPattern } from '../core/tags';
import { wilsonLB, type TagStat } from '../core/stats';

export type Unit = { id: string; title: string; /** Tag patterns as written in the spec. */ patterns: string[]; tags: string[] };

/** Dictionary-form tags that can never be drilled (the form equals the headword). */
const UNDRILLABLE = new Set(['noun.nom.sg', 'adj.nom.m']);
/** Tags added to a unit for practice but never required to master it. */
export const GATE_EXEMPT = new Set(['verb.pres.alt', 'verb.reflexive']);

function unit(id: string, title: string, patterns: string[]): Unit {
  const tags = [...new Set(patterns.flatMap(expandTagPattern))].filter((t) => !UNDRILLABLE.has(t));
  return { id, title, patterns, tags };
}

/** Fixed order (spec 8.2). */
export const UNITS: Unit[] = [
  unit('U1', '綴りの規則とアクセント', ['spell.*', 'phon.stress']),
  unit('U2', '名詞の性・複数主格', ['noun.gender', 'noun.nom.*']),
  unit('U3', '人称代名詞・これは', ['pron.personal']),
  unit('U4', '動詞の現在形', ['verb.pres.*', 'verb.pres.alt']),
  unit('U5', '前置格', ['noun.prep.sg', 'prep.в', 'prep.на', 'prep.о']),
  unit('U6', '対格', ['noun.acc.sg']),
  unit('U7', '形容詞・所有代名詞の主格での一致', ['adj.nom.*', 'pron.possessive']),
  unit('U8', '過去形', ['verb.past']),
  unit('U9', '生格単数', ['noun.gen.sg', 'prep.у', 'prep.из', 'prep.без']),
  unit('U10', '数詞と格', ['num.gov', 'noun.gen.pl']),
  unit('U11', '与格', ['noun.dat.sg']),
  unit('U12', '造格', ['noun.ins.sg', 'prep.с']),
  unit('U13', '複数の斜格', ['noun.*.pl', 'adj.*.pl']),
  unit('U14', '体', ['verb.aspect.pair', 'verb.aspect.choice']),
  unit('U15', '運動の動詞', ['verb.motion']),
];

export const UNLOCK_MIN_N = 10;
export const UNLOCK_MIN_LB = 0.75;

/** Tags that only get attempts through AI-made T4 items; they gate unlocking only once n >= 10. */
export function isContextOnlyTag(tag: string): boolean {
  // num.gov is now drilled locally by T11, so it gates U10 like any other tag.
  return tag.startsWith('prep.');
}

export type TagProgress = { tag: string; n: number; lb: number; ok: boolean };

export function unitProgress(u: Unit, stats: Map<string, TagStat>): TagProgress[] {
  return u.tags.filter((tag) => !GATE_EXEMPT.has(tag)).map((tag) => {
    const s = stats.get(tag);
    const n = s?.n ?? 0;
    const lb = s ? wilsonLB(s.k, s.n) : 0;
    const ok = isContextOnlyTag(tag) && n < UNLOCK_MIN_N ? true : n >= UNLOCK_MIN_N && lb >= UNLOCK_MIN_LB;
    return { tag, n, lb, ok };
  });
}

export function unitMastered(u: Unit, stats: Map<string, TagStat>): boolean {
  return unitProgress(u, stats).every((p) => p.ok);
}

/**
 * Ids of unlocked units. U1 is always unlocked; unit i unlocks when unit i-1 is unlocked and
 * mastered, or when it was unlocked before / manually (`persisted`).
 */
export function computeUnlocked(stats: Map<string, TagStat>, persisted: ReadonlySet<string>): string[] {
  const out: string[] = [];
  UNITS.forEach((u, i) => {
    const prev = UNITS[i - 1];
    if (i === 0 || persisted.has(u.id) || (prev && out.includes(prev.id) && unitMastered(prev, stats))) out.push(u.id);
  });
  return out;
}

/** The current unit is the last unlocked one in the fixed order. */
export function currentUnit(unlocked: readonly string[]): Unit {
  let cur = UNITS[0]!;
  for (const u of UNITS) if (unlocked.includes(u.id)) cur = u;
  return cur;
}

export function unlockedTags(unlocked: readonly string[]): string[] {
  return [...new Set(UNITS.filter((u) => unlocked.includes(u.id)).flatMap((u) => u.tags))];
}
