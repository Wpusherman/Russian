import { normalize } from '../core/normalize';
import { db, type LemmaRow } from './db';
import { findLemmas, searchLemmas } from './dict';

export const READING_LIST_NAME = '多読';

export type LookupVia = 'headword' | 'form' | 'prefix';
export type LookupHit = { lemma: LemmaRow; via: LookupVia };
export type WordLookup = { token: string; hits: LookupHit[] };

function hasForm(lemma: LemmaRow, norm: string): boolean {
  return Object.values(lemma.forms).some((f) => normalize(f.primary) === norm || f.variants.some((v) => normalize(v) === norm));
}

/** Rough infinitive guesses for a conjugated verb (the dictionary is keyed by infinitive). */
function stemGuesses(stem: string): string[] {
  return [stem, `${stem}ть`, `${stem}ти`, `${stem}чь`, `${stem}ться`, `${stem}тись`, `${stem}чься`];
}

/**
 * 多読: resolve a clicked word to dictionary lemmas.
 * 1) exact headword, 2) inflected form (shorten the word and verify against every stored form),
 * 3) headwords sharing the shortened prefix (shown as "suggested").
 */
export async function lookupWord(token: string): Promise<WordLookup> {
  const norm = normalize(token);
  const hits: LookupHit[] = [];
  const seen = new Set<string>();
  const push = (lemma: LemmaRow, via: LookupVia) => {
    if (seen.has(lemma.id)) return;
    seen.add(lemma.id);
    hits.push({ lemma, via });
  };

  for (const l of await findLemmas(token)) push(l, 'headword');
  if (hits.length > 0) return { token, hits };

  const lower = norm.replace(/\s+/g, '');
  let prefix: LemmaRow[] = [];
  for (let cut = 1; cut <= 4 && lower.length - cut >= 3; cut++) {
    const stem = lower.slice(0, lower.length - cut);
    const found: LemmaRow[] = [];
    for (const guess of stemGuesses(stem)) found.push(...(await findLemmas(guess)));
    found.push(...(await searchLemmas(stem, 12)));
    for (const l of found) if (hasForm(l, norm)) push(l, 'form');
    if (hits.length > 0) break;
    if (prefix.length === 0 && found.length > 0) prefix = found;
  }
  if (hits.length === 0) prefix.slice(0, 5).forEach((l) => push(l, 'prefix'));
  hits.sort((a, b) => (a.lemma.rank ?? 1e9) - (b.lemma.rank ?? 1e9));
  return { token, hits };
}

/** Add the headword to the dedicated "多読" list (created on first use and kept active). */
export async function addToReadingList(lemmaId: string): Promise<'added' | 'exists'> {
  const lists = await db.wordlists.toArray();
  const list = lists.find((l) => l.name === READING_LIST_NAME);
  if (!list) {
    const priority = lists.reduce((m, l) => Math.max(m, l.priority), 0) + 1;
    await db.wordlists.add({ name: READING_LIST_NAME, priority, active: true, entries: [{ lemmaId }] });
    return 'added';
  }
  if (list.entries.some((e) => e.lemmaId === lemmaId)) return 'exists';
  await db.wordlists.update(list.id!, { entries: [...list.entries, { lemmaId }], active: true });
  return 'added';
}
