import { normalize } from './normalize';

export type ReadingMatch = {
  expectedWords: string[];
  heardWords: string[];
  /** Same length as expectedWords: true when the word was recognised in order. */
  matched: boolean[];
  hits: number;
  /** hits / expected word count (extra recognised words do not lower it). */
  rate: number;
};

/** Lowercase, fold ё, and keep only Cyrillic words (punctuation / stress marks are dropped). */
export function readingWords(text: string): string[] {
  return normalize(text).match(/[а-я]+/g) ?? [];
}

/**
 * T8: word-level match rate. Words are compared after normalization and aligned with a longest
 * common subsequence, so order changes are penalised but extra / repeated recognised words are not.
 */
export function matchReading(expected: string, heard: string): ReadingMatch {
  const a = readingWords(expected);
  const b = readingWords(heard);
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]! + 1
        : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  const matched = new Array<boolean>(a.length).fill(false);
  for (let i = a.length, j = b.length; i > 0 && j > 0;) {
    if (a[i - 1] === b[j - 1]) {
      matched[i - 1] = true;
      i--; j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) i--;
    else j--;
  }
  const hits = matched.filter(Boolean).length;
  return { expectedWords: a, heardWords: b, matched, hits, rate: a.length === 0 ? 0 : hits / a.length };
}

/** Speech APIs can return several alternatives; keep the one with the best match rate. */
export function bestReadingMatch(expected: string, alternatives: readonly string[]): ReadingMatch {
  let best = matchReading(expected, alternatives[0] ?? '');
  for (const alt of alternatives.slice(1)) {
    const m = matchReading(expected, alt);
    if (m.rate > best.rate) best = m;
  }
  return best;
}
