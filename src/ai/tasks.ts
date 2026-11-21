import type { Unit } from '../content/units';
import type { Graded, Question } from '../core/grade';
import { normalize } from '../core/normalize';
import { DAY_MS } from '../core/stats';
import { isValidTag } from '../core/tags';
import { db, type BacklogRow, type LemmaRow, type PlanRow } from '../db/db';
import { findLemmas } from '../db/dict';
import { setSetting } from '../db/settings';
import { addT4Item, addT10Item, glossCandidates, setUnitState, type StudyContext } from '../db/study';
import { saveGlosses } from '../db/wordlists';
import { ptDate } from './gemini';
import { buildAnalyzePacket } from './packet';
import type { AIProvider } from './provider';
import {
  analyzeJsonSchema, aspectItemsJsonSchema, explainJsonSchema, glossJsonSchema, gradeT7JsonSchema, noteJsonSchema,
  type AnalyzeOutput, type AspectItem, type AspectItemsOutput, type ExplainOutput, type GlossOutput, type GradeT7Output, type NewItem, type NoteOutput,
} from './schemas';
import { validateAspectItem, validateNewItem } from './validate';

export const WEIGHT_TTL_MS = 14 * DAY_MS;
export const ANALYZE_INTERVAL_MS = 7 * DAY_MS;
export const ANALYZE_BACKLOG = 300;

// ---------- usage counter ----------

export async function countAiCall(now = Date.now()): Promise<void> {
  const key = ptDate(now);
  await db.transaction('rw', db.aiUsage, async () => {
    const row = await db.aiUsage.get(key);
    await db.aiUsage.put({ ptDate: key, count: (row?.count ?? 0) + 1 });
  });
}

export async function aiCallsToday(now = Date.now()): Promise<number> {
  return (await db.aiUsage.get(ptDate(now)))?.count ?? 0;
}

// ---------- analyze ----------

/** Whether the home screen should highlight the "analyze" button. */
export function analysisDue(ctx: StudyContext): { due: boolean; unanalyzed: number } {
  const { attempts, settings, now } = ctx;
  const unanalyzed = attempts.filter((a) => (a.id ?? 0) > settings.lastAnalyzedAttemptId).length;
  const since = settings.lastAnalysisAt || attempts.reduce((m, a) => Math.min(m, a.ts), now);
  const due = unanalyzed > 0 && (now - since >= ANALYZE_INTERVAL_MS || unanalyzed >= ANALYZE_BACKLOG);
  return { due, unanalyzed };
}

export type AnalysisImport = { added: number; quarantined: number; weights: number; requests: number };

/** Validate one fill-in item and register it as T4, or return the reason it failed. */
export async function registerNewItem(item: NewItem, yoLenient: boolean, now = Date.now()): Promise<string | null> {
  const candidates: LemmaRow[] = await findLemmas(item.lemma);
  const v = validateNewItem(item, candidates, { yoLenient });
  if (!v.ok) return v.reason;
  await addT4Item({ ...item, lemmaId: v.lemma.id }, v.lemma, 'ai', now);
  return null;
}

/** Apply an analyze result (spec 12.2 "取り込み時の処理"). */
export async function importAnalysis(out: AnalyzeOutput, ctx: Pick<StudyContext, 'settings' | 'attempts'>, now = Date.now()): Promise<AnalysisImport> {
  const weights = out.tag_weights.filter((w) => isValidTag(w.tag));
  const plan: PlanRow = { ts: now, raw: out, weights, expiresAt: now + WEIGHT_TTL_MS };
  await db.plans.add(plan);

  let added = 0;
  let quarantined = 0;
  for (const item of out.new_items) {
    const reason = await registerNewItem(item, ctx.settings.yoLenient, now);
    if (reason === null) added++;
    else {
      await db.quarantine.add({ ts: now, kind: 't4', payload: item, reason });
      quarantined++;
    }
  }
  if (out.feature_requests.length > 0) {
    await db.backlog.bulkAdd(out.feature_requests.map((f) => ({ ts: now, status: 'new' as const, title: f.title, rationale: f.rationale, spec: f.spec })));
  }
  await setSetting('lastAnalysisAt', now);
  await setSetting('lastAnalyzedAttemptId', ctx.attempts.reduce((m, a) => Math.max(m, a.id ?? 0), 0));
  return { added, quarantined, weights: weights.length, requests: out.feature_requests.length };
}

export async function runAnalyze(provider: AIProvider, ctx: StudyContext): Promise<AnalysisImport> {
  const backlog = await db.backlog.orderBy('id').reverse().toArray();
  const packet = buildAnalyzePacket({
    now: ctx.now, unitId: ctx.current.id, attempts: ctx.attempts, stats: ctx.stats, weights: ctx.weights,
    backlogTitles: backlog.map((r) => r.title),
  });
  const out = await provider.run<AnalyzeOutput>('analyze', packet, analyzeJsonSchema);
  return importAnalysis(out, ctx, Date.now());
}

/** FEATURE_BACKLOG.md format. */
export function backlogMarkdown(rows: BacklogRow[]): string {
  const fmt = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  return ['# FEATURE_BACKLOG', '', ...rows.map((r) => `## ${r.title}\n\n- 追加日: ${fmt(r.ts)}\n- 根拠: ${r.rationale}\n- 仕様: ${r.spec}\n`)].join('\n');
}

// ---------- gloss ----------

export async function runGloss(provider: AIProvider, ctx: Pick<StudyContext, 'cards'>): Promise<number> {
  const words = (await glossCandidates(ctx.cards)).slice(0, 100);
  if (words.length === 0) return 0;
  const partnerIds = [...new Set(words.flatMap((w) => w.partnerIds ?? []))];
  const partnerRows = await db.lemmas.bulkGet(partnerIds);
  const partnerBare = new Map(partnerRows.filter((r): r is LemmaRow => !!r).map((r) => [r.id, r.bare]));
  const input = words.map((w) => {
    const item: { id: string; ru: string; pos: string; en?: string; aspect?: string; partner?: string } = {
      id: w.id, ru: w.bare, pos: w.pos,
    };
    const en = w.glossEn.slice(0, 3).join(', ');
    if (en) item.en = en;
    if (w.aspect) item.aspect = w.aspect;
    const partner = w.partnerIds?.[0];
    if (partner && partnerBare.has(partner)) item.partner = partnerBare.get(partner);
    return item;
  });
  const out = await provider.run<GlossOutput>('gloss', input, glossJsonSchema);
  const valid = new Set(words.map((w) => w.id));
  const glosses: Record<string, string> = {};
  for (const it of out.items) {
    const ja = it.ja.trim();
    if (valid.has(it.id) && ja) glosses[it.id] = ja; // unknown ids are ignored
  }
  return saveGlosses(glosses, { onlyIfMissing: true });
}

// ---------- grade_t7 (T7 和文露訳) ----------

export type T7Input = { attemptId: number; ja: string; given: string };

/** Grade a batch of Japanese -> Russian translations, ignoring unknown / repeated attempt ids. */
export async function runGradeT7(provider: AIProvider, inputs: T7Input[]): Promise<GradeT7Output> {
  if (inputs.length === 0) return { results: [] };
  const out = await provider.run<GradeT7Output>('grade_t7', inputs, gradeT7JsonSchema);
  const wanted = new Set(inputs.map((i) => i.attemptId));
  const seen = new Set<number>();
  const results: GradeT7Output['results'] = [];
  for (const r of out.results) {
    if (!wanted.has(r.attemptId) || seen.has(r.attemptId)) continue;
    seen.add(r.attemptId);
    results.push(r);
  }
  return { results };
}

// ---------- aspect_items (A5 / T10) ----------

export type AspectImport = { added: number; quarantined: number; pairs: number };

/** Validate one AI aspect item and register it as T10, or return the reason it failed. */
export async function registerAspectItem(item: AspectItem, yoLenient: boolean, now = Date.now()): Promise<string | null> {
  const [impfCandidates, pfCandidates] = await Promise.all([findLemmas(item.impf), findLemmas(item.pf)]);
  const v = validateAspectItem(item, impfCandidates, pfCandidates, { yoLenient });
  if (!v.ok) return v.reason;
  await addT10Item({
    sentence_ru: item.sentence_ru, lemma: v.lemma.bare, lemmaId: v.lemma.id, feat: item.feat, answer: item.answer,
    translation_ja: item.translation_ja, explain_ja: item.cue_ja, impf: v.impf.bare, pf: v.pf.bare,
    correct: item.correct, cue_ja: item.cue_ja,
  }, now);
  return null;
}

/** Learned aspect pairs (T1 done) as [{impf, pf}], at most 10. */
export async function learnedAspectPairs(cards: StudyContext['cards']): Promise<{ impf: string; pf: string }[]> {
  const learned = new Set(cards.filter((c) => c.type === 'T1').map((c) => c.lemmaId));
  const verbs = await db.lemmas.where('pos').equals('verb').toArray();
  const byId = new Map(verbs.map((v) => [v.id, v]));
  const out: { impf: string; pf: string }[] = [];
  const seen = new Set<string>();
  for (const l of verbs) {
    if (out.length >= 10) break;
    if (!learned.has(l.id) || (l.aspect !== 'impf' && l.aspect !== 'pf')) continue;
    for (const pid of l.partnerIds ?? []) {
      const p = byId.get(pid);
      if (!p || (p.aspect !== 'impf' && p.aspect !== 'pf') || p.aspect === l.aspect) continue;
      const impf = l.aspect === 'impf' ? l : p;
      const pf = l.aspect === 'pf' ? l : p;
      const key = `${impf.id}|${pf.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ impf: impf.bare, pf: pf.bare });
      break;
    }
  }
  return out;
}

export async function runAspectItems(provider: AIProvider, ctx: Pick<StudyContext, 'cards' | 'settings'>): Promise<AspectImport> {
  const pairs = await learnedAspectPairs(ctx.cards);
  if (pairs.length === 0) return { added: 0, quarantined: 0, pairs: 0 };
  const out = await provider.run<AspectItemsOutput>('aspect_items', pairs, aspectItemsJsonSchema);
  let added = 0;
  let quarantined = 0;
  for (const item of out.items) {
    const reason = await registerAspectItem(item, ctx.settings.yoLenient);
    if (reason === null) added++;
    else {
      await db.quarantine.add({ ts: Date.now(), kind: 't10', payload: item, reason });
      quarantined++;
    }
  }
  return { added, quarantined, pairs: pairs.length };
}

// ---------- note ----------

/** True when a Markdown body came back as one long line although it contains block syntax. */
export function lacksLineBreaks(md: string): boolean {
  return !md.includes('\n') && (/#{2,4}\s/.test(md) || md.includes('|') || md.length > 200);
}

/**
 * Best-effort repair for a body without line breaks: put headings and table rows on their own lines.
 * (A heading and the sentence after it cannot be told apart, so this is only the fallback after a retry.)
 */
export function restoreLineBreaks(md: string): string {
  if (md.includes('\n')) return md;
  return md
    .replace(/\|\|/g, '|\n|') // "| a | b || c | d |" -> one table row per line
    .replace(/\s*(#{2,4}\s)/g, '\n\n$1')
    .replace(/([^|\n])\s*(\|[^|\n]*\|[^|\n]*\|\n)/, '$1\n\n$2') // blank line before the first table row
    .trim();
}

export async function runNote(provider: AIProvider, unit: Unit): Promise<void> {
  const input = { unit: unit.id, title: unit.title, tags: unit.tags };
  let out = await provider.run<NoteOutput>('note', input, noteJsonSchema);
  // The model occasionally returns the whole note on a single line: ask once more, then repair.
  if (lacksLineBreaks(out.body_md)) {
    try {
      const again = await provider.run<NoteOutput>('note', input, noteJsonSchema);
      if (!lacksLineBreaks(again.body_md)) out = again;
    } catch {
      // keep the first answer
    }
  }
  await setUnitState(unit.id, { noteTitle: out.title, noteMd: restoreLineBreaks(out.body_md) });
}

// ---------- explain ----------

export function explainKey(itemId: string, given: string): string {
  return `${itemId}|${normalize(given)}`;
}

export async function cachedExplain(itemId: string, given: string): Promise<string | null> {
  return (await db.explainCache.get(explainKey(itemId, given)))?.explain ?? null;
}

/** "Why?" explanation, cached by (itemId, normalize(given)); the provider is not called on a cache hit. */
export async function runExplain(provider: AIProvider, q: Question, g: Graded): Promise<string> {
  const hit = await cachedExplain(q.itemId, g.given);
  if (hit !== null) return hit;
  const input = { prompt: g.prompt, expected: g.expected.replace(/\u0301/g, ''), given: g.given, class: g.class, tags: g.tags };
  const out = await provider.run<ExplainOutput>('explain', input, explainJsonSchema);
  await db.explainCache.put({ key: explainKey(q.itemId, g.given), explain: out.explain_ja, ts: Date.now() });
  return out.explain_ja;
}
