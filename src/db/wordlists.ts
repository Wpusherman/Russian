import { convertAccent } from '../core/accent';
import { featLabelJa } from '../core/tags';
import { translit } from '../core/translit';
import { dedupeGloss, mergeGloss, mergeHints, parseWordlistText } from '../core/wordlist';
import { db, type LemmaRow, type T4Payload, type WordlistEntry, type WordlistRow } from './db';
import { addT4Item } from './study';
import { findLemmas, lemmaKey } from './dict';
import { loadSettings, setSetting } from './settings';

const CYRILLIC = /[а-яёА-ЯЁ]/;

/** Latin-only headwords are transliterated with the same table as the dictionary search. */
export function normalizeHeadword(word: string): string {
  return CYRILLIC.test(word) ? word : translit(word);
}

/**
 * Store Japanese glosses on the lemmas and in settings (so they survive dictionary rebuilds).
 * A meaning that is already there stays first; new meanings are appended, numbered from two on.
 */
export async function saveGlosses(glosses: Record<string, string>, opts: { onlyIfMissing?: boolean } = {}): Promise<number> {
  const ids = Object.keys(glosses);
  if (ids.length === 0) return 0;
  const s = await loadSettings();
  const merged = { ...s.glossJa };
  const rows = await db.lemmas.bulkGet(ids);
  const found = rows.filter((r): r is LemmaRow => !!r);
  // AI glosses must never touch a word that already has a Japanese translation (F2).
  const targets = opts.onlyIfMissing ? found.filter((r) => !(r.glossJa ?? merged[r.id])) : found;
  if (targets.length === 0) return 0;
  await db.lemmas.bulkPut(
    targets.map((r) => {
      const next = mergeGloss(r.glossJa ?? merged[r.id] ?? '', glosses[r.id]!);
      merged[r.id] = next;
      return { ...r, glossJa: next };
    }),
  );
  await setSetting('glossJa', merged);
  return targets.length;
}

/** F2: one-shot startup migration that removes duplicate meanings from every stored gloss. */
export async function dedupeStoredGlosses(): Promise<number> {
  const s = await loadSettings();
  if (s.glossDedupDone) return 0;
  const next = { ...s.glossJa };
  let changed = 0;
  for (const [id, g] of Object.entries(next)) {
    const d = dedupeGloss(g);
    if (d !== g) { next[id] = d; changed++; }
  }
  await setSetting('glossJa', next);
  const ids = Object.keys(next);
  if (ids.length > 0) {
    const rows = await db.lemmas.bulkGet(ids);
    const upd = rows.filter((r): r is LemmaRow => !!r).map((r) => ({ ...r, glossJa: next[r.id] }));
    await db.lemmas.bulkPut(upd);
  }
  await setSetting('glossDedupDone', true);
  return changed;
}

/** Grammar annotations (e.g. "+対") shown next to the word; kept in settings like glossJa. */
export async function saveHints(hints: Record<string, string>): Promise<number> {
  const ids = Object.keys(hints);
  if (ids.length === 0) return 0;
  const s = await loadSettings();
  const merged = { ...s.hints };
  const rows = await db.lemmas.bulkGet(ids);
  const updates: LemmaRow[] = [];
  for (const r of rows) {
    if (!r) continue;
    const next = mergeHints(merged[r.id] ?? r.hint ?? '', hints[r.id]!);
    merged[r.id] = next;
    updates.push({ ...r, hint: next });
  }
  await setSetting('hints', merged);
  if (updates.length > 0) await db.lemmas.bulkPut(updates);
  return updates.length;
}

export type Ambiguity = { word: string; candidates: LemmaRow[] };

/** Headwords that match more than one dictionary entry (same spelling, different lemmas). */
export async function findAmbiguities(text: string): Promise<Ambiguity[]> {
  const out: Ambiguity[] = [];
  const seen = new Set<string>();
  for (const line of parseWordlistText(text)) {
    const word = normalizeHeadword(line.word);
    if (seen.has(word)) continue;
    seen.add(word);
    const hits = (await findLemmas(word)).filter((h) => !h.user);
    if (hits.length > 1) out.push({ word, candidates: hits });
  }
  return out;
}

export type ImportSummary = { matched: number; created: number; total: number; /** Registered words with neither a Japanese nor an English gloss (never asked). */ unglossed: string[] };

/** Create a word list from pasted text (spec section 11). */
export async function createWordlist(name: string, text: string, choices: Readonly<Record<string, string>> = {}): Promise<ImportSummary> {
  const lines = parseWordlistText(text);
  const entries: WordlistEntry[] = [];
  const glosses: Record<string, string> = {};
  const hints: Record<string, string> = {};
  const newUser: LemmaRow[] = [];
  let matched = 0;
  for (const line of lines) {
    const word = normalizeHeadword(line.word);
    const hits = await findLemmas(word);
    let lemma = (choices[word] ? hits.find((h) => h.id === choices[word]) : undefined) ?? hits[0]; // chosen, else lowest rank
    if (lemma && !lemma.user) matched++;
    if (!lemma) {
      // Words missing from the dictionary (incl. whole phrases / idioms) become user lemmas: T1/T2 only.
      const accented = convertAccent(word.trim());
      const bare = accented.replace(/\u0301/g, '').trim();
      lemma = {
        id: `u-${bare.replace(/[:\s]/g, '_')}`, bare, accented, pos: 'other', rank: null, level: null,
        glossEn: [], forms: {}, key: lemmaKey(bare), user: true,
      };
      if (line.glossJa) lemma.glossJa = line.glossJa;
      if (line.hint) lemma.hint = line.hint;
      newUser.push(lemma);
    }
    if (line.glossJa) glosses[lemma.id] = glosses[lemma.id] ? mergeGloss(glosses[lemma.id], line.glossJa) : line.glossJa;
    if (line.hint) hints[lemma.id] = line.hint;
    if (!entries.some((e) => e.lemmaId === lemma.id)) {
      entries.push(line.glossJa ? { lemmaId: lemma.id, glossJa: line.glossJa } : { lemmaId: lemma.id });
    }
  }
  if (newUser.length > 0) {
    await db.lemmas.bulkPut(newUser);
    const s = await loadSettings();
    const byId = new Map(s.userLemmas.map((l) => [l.id, l]));
    for (const l of newUser) byId.set(l.id, l);
    await setSetting('userLemmas', [...byId.values()]);
  }
  await saveGlosses(glosses);
  await saveHints(hints);
  await generateHintItems(entries, hints);
  const all = await db.wordlists.toArray();
  const priority = all.reduce((m, l) => Math.max(m, l.priority), 0) + 1;
  await db.wordlists.add({ name: name.trim() || '無題のリスト', priority, active: true, entries });
  const saved = await db.lemmas.bulkGet(entries.map((e) => e.lemmaId));
  const unglossed = [...new Set(saved.filter((r): r is LemmaRow => !!r && !r.glossJa && r.glossEn.length === 0).map((r) => r.bare))];
  return { matched, created: newUser.length, total: entries.length, unglossed };
}

const HINT_CASE: Record<string, string> = { 主: 'nom', 生: 'gen', 属: 'gen', 与: 'dat', 対: 'acc', 造: 'ins', 具: 'ins', 前: 'prep' };

/** "сесть на" -> "Я сяду на ___" when the first word is a known verb (W9). */
async function hintSentence(lemma: LemmaRow): Promise<string> {
  const [first, ...rest] = lemma.bare.split(/\s+/);
  const verb = first ? (await findLemmas(first)).find((h) => h.pos === 'verb') : undefined;
  const p1 = verb?.forms['pres.1sg'];
  if (verb && p1) return `Я ${p1.primary.replace(/́/g, '')}${rest.length > 0 ? ` ${rest.join(' ')}` : ''} ___`;
  return `${lemma.bare} ___`;
}

/**
 * W9: turn a word-list annotation into T4 fill-in items. The case letters decide the noun form;
 * +複 switches to plural. The noun is taken from the same list when possible, otherwise from A1-A2.
 */
export async function generateHintItems(entries: WordlistEntry[], hints: Readonly<Record<string, string>>, now = Date.now()): Promise<number> {
  const rows = (await db.lemmas.bulkGet(entries.map((e) => e.lemmaId))).filter((r): r is LemmaRow => !!r);
  // Only verbs and phrases can govern a case; a bare adverb such as "только +複" has no blank to fill.
  const targets = rows.filter((r) => hints[r.id] && (r.pos === 'verb' || /\s/.test(r.bare)));
  if (targets.length === 0) return 0;
  let nouns = rows.filter((r) => r.pos === 'noun');
  if (nouns.length === 0) {
    const levels = await db.lemmas.where('level').anyOf('A1', 'A2').toArray();
    nouns = levels.filter((r) => r.pos === 'noun' && !!r.forms['case.gen.pl']);
  }
  let added = 0;
  for (const target of targets.slice(0, 20)) {
    const hint = hints[target.id]!;
    const letters = [...new Set((hint.match(/\+([主生属与対造具前複])/g) ?? []).map((s) => s.slice(1)))];
    const num = letters.includes('複') ? 'pl' : 'sg';
    const cases = [...new Set(letters.filter((c) => c !== '複').map((c) => HINT_CASE[c]).filter((c): c is string => !!c))];
    const feats = (cases.length > 0 ? cases : ['nom']).map((c) => `case.${c}.${num}`);
    const sentence = await hintSentence(target);
    const picks = nouns.filter((n) => feats.some((f) => !!n.forms[f])).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9)).slice(0, 2);
    for (const noun of picks) {
      for (const feat of feats) {
        const form = noun.forms[feat];
        if (!form) continue;
        const payload: T4Payload = {
          sentence_ru: sentence, lemma: noun.bare, lemmaId: noun.id, feat, answer: form.primary.replace(/́/g, ''),
          translation_ja: `${target.bare}（${hint}）＋${featLabelJa(feat)}`,
          explain_ja: `注記 ${hint} に従って${featLabelJa(feat)}の形を入れる。`,
        };
        await addT4Item(payload, noun, 'user', now);
        added++;
      }
    }
  }
  return added;
}

export async function listWordlists(): Promise<WordlistRow[]> {
  return (await db.wordlists.toArray()).sort((a, b) => a.priority - b.priority);
}

/** Move a list up (-1) or down (+1) in priority order. */
export async function moveWordlist(id: number, dir: -1 | 1): Promise<void> {
  const lists = await listWordlists();
  const i = lists.findIndex((l) => l.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= lists.length) return;
  [lists[i], lists[j]] = [lists[j]!, lists[i]!];
  await db.wordlists.bulkPut(lists.map((l, k) => ({ ...l, priority: k + 1 })));
}
