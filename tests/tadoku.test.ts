import { describe, expect, it } from 'vitest';
import { tokenizeRussian } from '../src/core/tadoku';

describe('tadoku tokenizer', () => {
  it('marks Cyrillic words and preserves every other character', () => {
    const text = 'Привет, мир!\nКто-то живёт здесь.';
    const pieces = tokenizeRussian(text);
    expect(pieces.filter((p) => p.word).map((p) => p.text)).toEqual(['Привет', 'мир', 'Кто-то', 'живёт', 'здесь']);
    expect(pieces.map((p) => p.text).join('')).toBe(text);
  });

  it('keeps stress marks inside words and ignores Latin / digits', () => {
    const pieces = tokenizeRussian('Кни\u0301га и 2 дома, hello.');
    expect(pieces.filter((p) => p.word).map((p) => p.text)).toEqual(['Кни\u0301га', 'и', 'дома']);
  });
});
