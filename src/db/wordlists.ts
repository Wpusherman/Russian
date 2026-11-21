import { convertAccent } from '../core/accent';
import { translit } from '../core/translit';
import { mergeGloss, mergeHints, parseWordlistText } from '../core/wordlist';
import { db, type LemmaRow, type WordlistEntry, type WordlistRow } from './db';
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
export async function saveGlosses(glosses: Record<string, string>): Promise<number> {
  const ids = Object.keys(glosses);
  if (ids.length === 0) return 0;
  const s = await loadSettings();
  const merged = { ...s.glossJa };
  const rows = await db.lemmas.bulkGet(ids);
  const found = rows.filter((r): r is LemmaRow => !!r);
  await db.lemmas.bulkPut(
    found.map((r) => {
      const next = mergeGloss(r.glossJa ?? merged[r.id] ?? '', glosses[r.id]!);
      merged[r.id] = next;
      return { ...r, glossJa: next };
    }),
  );
  await setSetting('glossJa', merged);
  return found.length;
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

export type ImportSummary = { matched: number; created: number; total: number };

/** Create a word list from pasted text (spec section 11). */
export async function createWordlist(name: string, text: string): Promise<ImportSummary> {
  const lines = parseWordlistText(text);
  const entries: WordlistEntry[] = [];
  const glosses: Record<string, string> = {};
  const hints: Record<string, string> = {};
  const newUser: LemmaRow[] = [];
  let matched = 0;
  for (const line of lines) {
    const word = normalizeHeadword(line.word);
    const hits = await findLemmas(word);
    let lemma = hits[0]; // lowest rank
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
  const all = await db.wordlists.toArray();
  const priority = all.reduce((m, l) => Math.max(m, l.priority), 0) + 1;
  await db.wordlists.add({ name: name.trim() || '無題のリスト', priority, active: true, entries });
  return { matched, created: newUser.length, total: entries.length };
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
