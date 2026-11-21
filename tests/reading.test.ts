import { describe, expect, it } from 'vitest';
import { bestReadingMatch, matchReading, readingWords } from '../src/core/reading';
import { transcriptsOf } from '../src/ui/speechRecognition';

describe('word reading match (T8)', () => {
  it('normalizes case, ё, stress marks and punctuation', () => {
    expect(readingWords('Я живу́ в Москве́!')).toEqual(['я', 'живу', 'в', 'москве']);
    expect(matchReading('Я живу в Москве.', 'я живу в москве').rate).toBe(1);
    expect(matchReading('Всё хорошо.', 'все хорошо').hits).toBe(2);
  });

  it('scores missing words but not extra recognised words', () => {
    const missing = matchReading('я живу в москве', 'я живу в');
    expect(missing.rate).toBe(0.75);
    expect(missing.matched).toEqual([true, true, true, false]);
    expect(matchReading('я живу в москве', 'я живу в москве сейчас').rate).toBe(1);
  });

  it('penalises word order through the longest common subsequence', () => {
    const m = matchReading('я живу в москве', 'я в живу москве');
    expect(m.hits).toBe(3);
    expect(m.rate).toBe(0.75);
  });

  it('collects every transcript alternative from a recognition event', () => {
    expect(transcriptsOf({ results: [[{ transcript: 'я живу' }, { transcript: 'я живу в москве' }]] })).toEqual(['я живу', 'я живу в москве']);
  });

  it('picks the best recognition alternative and handles silence', () => {
    expect(bestReadingMatch('я живу в москве', ['я живу', 'я живу в москве']).rate).toBe(1);
    expect(matchReading('я живу', '').rate).toBe(0);
    expect(matchReading('', 'я живу').rate).toBe(0);
  });
});
