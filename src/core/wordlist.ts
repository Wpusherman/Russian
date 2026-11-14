export type WordlistLine = { word: string; glossJa?: string };

/** One word per line: `headword` or `headword<TAB or ,>Japanese gloss`. Blank lines are ignored. */
export function parseWordlistText(text: string): WordlistLine[] {
  const out: WordlistLine[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([^\t,、]+)(?:[\t,、]\s*(.*))?$/.exec(line);
    if (!m) continue;
    const word = m[1]!.trim();
    const glossJa = m[2]?.trim();
    if (!word || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    out.push(glossJa ? { word, glossJa } : { word });
  }
  return out;
}
