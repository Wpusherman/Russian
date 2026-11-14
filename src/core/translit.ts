/** Latin -> Cyrillic transliteration (spec 5.2). Longest match, left to right, "/" is a separator. */

const MULTI: Record<string, string> = {
  shch: 'щ',
  yo: 'ё', yu: 'ю', ya: 'я', ye: 'е', zh: 'ж', kh: 'х', ts: 'ц', ch: 'ч', sh: 'ш', eh: 'э',
};
const SINGLE: Record<string, string> = {
  a: 'а', b: 'б', v: 'в', g: 'г', d: 'д', e: 'е', z: 'з', i: 'и', j: 'й', k: 'к', l: 'л', m: 'м',
  n: 'н', o: 'о', p: 'п', r: 'р', s: 'с', t: 'т', u: 'у', f: 'ф', h: 'х', x: 'х', c: 'ц', w: 'щ',
  y: 'ы', q: 'я', "'": 'ь', '#': 'ъ',
};
export const TRANSLIT_TABLE: Record<string, string> = { ...MULTI, ...SINGLE };
const MULTI_KEYS = Object.keys(MULTI);
const MAX_LEN = 4;

function isUpper(ch: string): boolean {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

function isProperPrefixOfMulti(rest: string): boolean {
  const r = rest.toLowerCase();
  return MULTI_KEYS.some((k) => k.length > r.length && k.startsWith(r));
}

export type LiveResult = {
  /** Converted text (already Cyrillic). */
  done: string;
  /** Trailing Latin letters still waiting for more input (shown underlined). */
  pending: string;
};

/**
 * Live conversion: a trailing token that could still grow into a longer match
 * (e.g. "s" -> "sh" -> "shch") is left unconverted in `pending`.
 */
export function translitLive(input: string): LiveResult {
  return convert(input, true);
}

/** Final conversion: everything is converted, nothing stays pending. */
export function translit(input: string): string {
  return convert(input, false).done;
}

function convert(input: string, live: boolean): LiveResult {
  let out = '';
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i]!;
    if (ch === '/') {
      i++;
      continue;
    }
    const rest = input.slice(i);
    if (live && rest.length < MAX_LEN && !rest.includes('/') && isProperPrefixOfMulti(rest)) {
      return { done: out, pending: rest };
    }
    let matched = false;
    for (let len = Math.min(MAX_LEN, n - i); len >= 1; len--) {
      const chunk = input.slice(i, i + len);
      const cyr = TRANSLIT_TABLE[chunk.toLowerCase()];
      if (cyr !== undefined) {
        out += isUpper(ch) ? cyr.toUpperCase() : cyr;
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += ch;
      i++;
    }
  }
  return { done: out, pending: '' };
}
