import { parseWordlistText } from '../core/wordlist';
import { db, type LemmaRow, type WordlistEntry, type WordlistRow } from './db';
import { findLemmas, lemmaKey } from './dict';
import { loadSettings, setSetting } from './settings';

/** Store a Japanese gloss on the lemma and in settings (so it survives dictionary rebuilds). */
export async function saveGlosses(glosses: Record<string, string>): Promise<number> {
  const ids = Object.keys(glosses);
  if (ids.length === 0) return 0;
  const rows = await db.lemmas.bulkGet(ids);
  const found = rows.filter((r): r is LemmaRow => !!r);
  await db.lemmas.bulkPut(found.map((r) => ({ ...r, glossJa: glosses[r.id]! })));
  const s = await loadSettings();
  const merged = { ...s.glossJa };
  for (const r of found) merged[r.id] = glosses[r.id]!;
  await setSetting('glossJa', merged);
  return found.length;
}

export type ImportSummary = { matched: number; created: number; total: number };

/** Create a word list from pasted text (spec section 11). */
export async function createWordlist(name: string, text: string): Promise<ImportSummary> {
  const lines = parseWordlistText(text);
  const entries: WordlistEntry[] = [];
  const glosses: Record<string, string> = {};
  const newUser: LemmaRow[] = [];
  let matched = 0;
  for (const line of lines) {
    const hits = await findLemmas(line.word);
    let lemma = hits[0]; // lowest rank
    if (lemma && !lemma.user) matched++;
    if (!lemma) {
      const bare = line.word.replace(/\u0301/g, '').trim();
      lemma = {
        id: `u-${bare.replace(/[:\s]/g, '_')}`, bare, accented: line.word.trim(), pos: 'other', rank: null, level: null,
        glossEn: [], forms: {}, key: lemmaKey(bare), user: true,
      };
      if (line.glossJa) lemma.glossJa = line.glossJa;
      newUser.push(lemma);
    }
    if (line.glossJa) glosses[lemma.id] = line.glossJa;
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
