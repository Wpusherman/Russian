export type TextPiece = { text: string; word: boolean };

const WORD_RE = /[А-Яа-яЁё\u0301]+(?:-[А-Яа-яЁё\u0301]+)*/g;

/** Split pasted text into clickable Russian words and the untouched separators around them. */
export function tokenizeRussian(text: string): TextPiece[] {
  const out: TextPiece[] = [];
  let last = 0;
  for (const m of text.matchAll(WORD_RE)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ text: text.slice(last, start), word: false });
    out.push({ text: m[0], word: true });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), word: false });
  return out;
}
