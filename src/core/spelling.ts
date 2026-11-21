import { normalize } from './normalize';

export type SpellingMark = { start: number; end: number; tag: 'spell.y_i' | 'spell.a_ya' };

const RULES: { tag: SpellingMark['tag']; re: RegExp }[] = [
  { tag: 'spell.y_i', re: /[гкхжшщч]ы/g },
  { tag: 'spell.a_ya', re: /[гкхжшщчц][яю]/g },
];

/**
 * Spelling-rule violations in a typed answer (B3). Positions refer to the original string.
 * The whole answer is skipped when it is one of the dictionary's exceptions (жюри, парашют...).
 */
export function spellingViolations(text: string, exceptions: readonly string[] | ReadonlySet<string> = []): SpellingMark[] {
  const set = exceptions instanceof Set ? exceptions : new Set(exceptions);
  if (set.has(normalize(text))) return [];
  const lower = text.toLowerCase();
  const out: SpellingMark[] = [];
  for (const { tag, re } of RULES) {
    for (const m of lower.matchAll(re)) {
      const start = m.index ?? 0;
      out.push({ start, end: start + m[0].length, tag });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}
