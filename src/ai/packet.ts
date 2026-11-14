import { confusionCounts, DAY_MS, type TagStat } from '../core/stats';
import type { Attempt } from '../core/types';

export type AnalyzePacket = {
  profile: { native: 'ja'; goal: string; unit: string; days: number };
  tag_stats: { tag: string; n: number; acc: number; lb: number; trend: number }[];
  confusions: { expected: string; given: string; n: number }[];
  samples: { type: string; prompt: string; expected: string; given: string; class: string }[];
  current_weights: { tag: string; w: number }[];
};

export const PACKET_MAX_CHARS = 6000;
const r2 = (x: number) => Math.round(x * 100) / 100;

export type PacketInput = {
  now: number;
  unitId: string;
  attempts: Attempt[];
  stats: ReadonlyMap<string, TagStat>;
  weights: Readonly<Record<string, number>>;
};

/** Spec 12.2: aggregated stats only; shrinks `samples` until the JSON fits in ~1500 tokens (6000 chars). */
export function buildAnalyzePacket(input: PacketInput): AnalyzePacket {
  const { now, attempts } = input;
  const first = attempts.reduce((m, a) => Math.min(m, a.ts), now);
  const days = Math.max(1, Math.ceil((now - first) / DAY_MS));

  const tag_stats = [...input.stats.values()]
    .filter((s) => s.n >= 5)
    .sort((a, b) => b.weakness - a.weakness)
    .slice(0, 15)
    .map((s) => ({ tag: s.tag, n: s.n, acc: r2(s.acc), lb: r2(s.lb), trend: r2(s.trend) }));

  const confusions = confusionCounts(attempts, now).slice(0, 10);

  const from = now - 30 * DAY_MS;
  const wrong = attempts.filter((a) => a.ts >= from && a.class !== 'correct' && a.class !== 'orthographic');
  // "wrong" first, then newest first.
  wrong.sort((a, b) => Number(b.class === 'wrong') - Number(a.class === 'wrong') || b.ts - a.ts);
  const samples = wrong.slice(0, 10).map((a) => ({
    type: a.type, prompt: (a.prompt ?? a.itemId).slice(0, 80), expected: (a.expected ?? '').replace(/\u0301/g, '').slice(0, 80),
    given: a.given.slice(0, 80), class: a.class,
  }));

  const packet: AnalyzePacket = {
    profile: { native: 'ja', goal: 'writing→ТРКИ', unit: input.unitId, days },
    tag_stats, confusions, samples,
    current_weights: Object.entries(input.weights).map(([tag, w]) => ({ tag, w })),
  };
  while (JSON.stringify(packet).length > PACKET_MAX_CHARS && packet.samples.length > 0) packet.samples.pop();
  return packet;
}
