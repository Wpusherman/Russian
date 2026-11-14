export type WordlistLine = { word: string; glossJa?: string; hint?: string };

/** Grammar-case annotations accepted in the headword, e.g. "сесть on +対".
 *  属 / 具 are aliases and are normalised to the internal case names 生 / 造 (1-to-1 mapping). */
const HINT_RE = /(?:^|\s)\+([主生属与対造具前複])(?=\s|$)/g;
const HINT_ALIASES: Record<string, string> = { 属: '生', 具: '造' };

function splitHint(word: string): { word: string; hint?: string } {
  const tokens = new Set<string>();
  const stripped = word
    .replace(HINT_RE, (_m, g: string) => {
      tokens.add('+' + (HINT_ALIASES[g] ?? g));
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { word: stripped, hint: tokens.size > 0 ? [...tokens].join('') : undefined };
}

/** Meanings separated by "、" / "，" or numbered like "1. ... 2. ...". */
function parseParts(s: string): string[] {
  return s
    .split(/(?:、|，)|(?<=^|\s)\d{1,2}\.\s+/u)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Append meanings that are not present yet, numbered from two meanings on:
 * "" + "ランプ" -> "ランプ", "ランプ" + "電灯" -> "1. ランプ 2. 電灯".
 * A meaning that is already there is ignored.
 */
export function mergeGloss(existing: string, next: string): string {
  const a = existing.trim();
  const b = next.trim();
  if (!a) return b;
  if (!b) return a;
  const parts = parseParts(a);
  for (const p of parseParts(b)) if (!parts.includes(p)) parts.push(p);
  if (parts.length === 1) return parts[0]!;
  return parts.map((p, i) => `${i + 1}. ${p}`).join(' ');
}

/** One word (or phrase) per line: `見出し語[+注記…]` or `見出し語[+注記…]<TAB or ,>日本語訳`.
 *  Phrases keep their spaces; duplicates append their glosses to the first entry. */
export function parseWordlistText(text: string): WordlistLine[] {
  const out = new Map<string, WordlistLine>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([^\t,、]+)(?:[\t,、]\s*(.*))?$/.exec(line);
    if (!m) continue;
    const { word, hint } = splitHint(m[1]!.trim());
    const glossJa = m[2]?.trim();
    if (!word) continue;
    const prev = out.get(word.toLowerCase());
    if (!prev) out.set(word.toLowerCase(), { word, glossJa, hint });
    else {
      if (glossJa) prev.glossJa = mergeGloss(prev.glossJa ?? '', glossJa);
      if (hint && !prev.hint) prev.hint = hint;
    }
  }
  return [...out.values()];
}
