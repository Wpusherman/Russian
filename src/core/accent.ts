const VOWELS = 'аеиоуыэюяАЕИОУЫЭЮЯ';

/** Apostrophe accent notation ("челове'к") -> combining acute (U+0301). No accent on ё; stray apostrophes are dropped. */
export function convertAccent(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFC')) {
    if (ch === "'" || ch === '\u0301') {
      const prev = out[out.length - 1];
      if (prev && VOWELS.includes(prev)) out += '\u0301';
    } else out += ch;
  }
  return out;
}
