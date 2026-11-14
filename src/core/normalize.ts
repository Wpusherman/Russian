export type NormalizeOpts = { yoLenient?: boolean };

const ACUTE = /\u0301/g;

/** Remove stress marks only (keeps case and spacing). */
export function stripAccent(s: string): string {
  return s.normalize('NFC').replace(ACUTE, '');
}

/**
 * NFC -> strip U+0301 -> lowercase -> trim / collapse spaces -> strip trailing ".!?…,"
 * With yoLenient (default true) ё is folded to е for comparison.
 */
export function normalize(s: string, opts: NormalizeOpts = {}): string {
  const yoLenient = opts.yoLenient ?? true;
  let t = s.replace(ACUTE, '').normalize('NFC').replace(ACUTE, '').toLowerCase();
  t = t.trim().replace(/\s+/g, ' ');
  t = t.replace(/[.!?…,\s]+$/u, '');
  if (yoLenient) t = t.replace(/ё/g, 'е');
  return t;
}

/** Sentence comparison (T6): normalize + drop all punctuation so only words are compared. */
export function normalizeSentence(s: string, opts: NormalizeOpts = {}): string {
  const t = normalize(s, opts).replace(/[.,!?…;:"«»()—–]/gu, ' ').replace(/\s+-\s+/g, ' ');
  return t.trim().replace(/\s+/g, ' ');
}

/**
 * Normalized text plus the set of stressed character indexes (ё counts as stressed).
 * Used by the spelling-rule check, which needs to know whether a vowel is unstressed.
 */
export function analyzeStress(raw: string, opts: NormalizeOpts = {}): { norm: string; stressed: Set<number> } {
  const yoLenient = opts.yoLenient ?? true;
  const norm = normalize(raw, opts);
  const stressed = new Set<number>();
  let out = '';
  for (const ch of raw.normalize('NFC').toLowerCase().trim()) {
    if (ch === '\u0301') {
      if (out.length > 0) stressed.add(out.length - 1);
      continue;
    }
    if (ch === 'ё') {
      stressed.add(out.length);
      out += yoLenient ? 'е' : 'ё';
    } else out += ch;
  }
  // Multi-word / punctuated strings may not line up; then report no stress info.
  return out === norm ? { norm, stressed } : { norm, stressed: new Set() };
}

export const RU_VOWELS = 'аеёиоуыэюя';

export function isVowel(ch: string): boolean {
  return RU_VOWELS.includes(ch.toLowerCase());
}
