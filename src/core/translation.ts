import { stripAccent } from './normalize';

export type TranslationSource = { itemId: string; ja: string; ru: string; lemma: string };

/** Structural subset of T4/T10 item rows (keeps this module independent of the database). */
type ItemLike = {
  id: string;
  source?: 'ai' | 'user';
  payload: { sentence_ru?: string; answer?: string; translation_ja?: string; lemma?: string };
};

const JAPANESE = /[ぁ-んァ-ヶ一-龠]/;

/**
 * A T4/T10 sentence with its blank filled in. The answer has no stress marks in the payload,
 * so the completed sentence is safe to show / read aloud.
 */
export function completedRussian(sentence: string, answer: string): string | null {
  if (!sentence.includes('___') || !answer) return null;
  return sentence.replace('___', stripAccent(answer));
}

/**
 * 和文露訳 / 音読の材料: completed example sentences with a natural Japanese translation.
 * Word-list templates such as "сесть на（+対）＋生格" are not sentences and are skipped.
 */
export function buildTranslationSources(items: readonly ItemLike[], limit = 5, rng: () => number = Math.random): TranslationSource[] {
  const order = items.map((item, i) => ({ item, i, key: rng() })).sort((a, b) => a.key - b.key).map((x) => x.item);
  // AI-made items come first so their natural translations are preferred over user templates.
  order.sort((a, b) => Number(b.source === 'ai') - Number(a.source === 'ai'));
  const out: TranslationSource[] = [];
  const seen = new Set<string>();
  for (const item of order) {
    const p = item.payload;
    const ja = (p.translation_ja ?? '').trim();
    if (!JAPANESE.test(ja) || ja.includes('＋')) continue;
    const ru = completedRussian(p.sentence_ru ?? '', p.answer ?? '');
    if (!ru) continue;
    const key = ja.replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ itemId: item.id, ja, ru, lemma: p.lemma ?? '' });
    if (out.length >= limit) break;
  }
  return out;
}
