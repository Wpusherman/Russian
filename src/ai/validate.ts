import { normalize } from '../core/normalize';
import { PSEUDO_FEATS } from '../core/tags';
import type { Lemma } from '../core/types';
import type { NewItem } from './schemas';

export type ValidationResult<L extends Lemma = Lemma> =
  | { ok: true; lemma: L; feat: string }
  | { ok: false; reason: string };

/**
 * Checks for an AI-made fill-in item (spec 12.2):
 * exactly one "___" / lemma exists in the dictionary / feat is one of its FeatKeys /
 * normalize(answer) equals a form in forms[feat].
 * `candidates` are the dictionary entries whose headword matches item.lemma (lowest rank first).
 */
export function validateNewItem<L extends Lemma>(item: NewItem, candidates: L[], opts: { yoLenient?: boolean } = {}): ValidationResult<L> {
  const blanks = item.sentence_ru.split('___').length - 1;
  if (blanks !== 1) return { ok: false, reason: `空欄 "___" が${blanks}個あります（ちょうど1個必要）` };
  if (candidates.length === 0) return { ok: false, reason: `lemma「${item.lemma}」が辞書にありません` };
  if (PSEUDO_FEATS.includes(item.feat)) return { ok: false, reason: `feat「${item.feat}」は使えません` };
  const withFeat = candidates.filter((l) => l.forms[item.feat]);
  if (withFeat.length === 0) return { ok: false, reason: `feat「${item.feat}」は「${item.lemma}」の語形にありません` };
  const answer = normalize(item.answer, opts);
  for (const lemma of withFeat) {
    const f = lemma.forms[item.feat]!;
    if ([f.primary, ...f.variants].some((x) => normalize(x, opts) === answer)) return { ok: true, lemma, feat: item.feat };
  }
  const want = withFeat[0]!.forms[item.feat]!.primary.replace(/\u0301/g, '');
  return { ok: false, reason: `answer「${item.answer}」が辞書の形「${want}」(${item.feat}) と一致しません` };
}
