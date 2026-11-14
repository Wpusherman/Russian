import { describe, expect, it, vi } from 'vitest';
import { API_REVISION, GeminiProvider, extractText, ptDate } from '../src/ai/gemini';
import { ManualProvider, buildManualPrompt } from '../src/ai/manual';
import { buildAnalyzePacket, PACKET_MAX_CHARS } from '../src/ai/packet';
import { SYSTEM_PROMPTS } from '../src/ai/prompts';
import { AIError, parseTaskOutput, stripFence } from '../src/ai/provider';
import { analyzeJsonSchema, explainJsonSchema, type AnalyzeOutput, type NewItem } from '../src/ai/schemas';
import { validateNewItem } from '../src/ai/validate';
import { DAY_MS, tagStats } from '../src/core/stats';
import type { Attempt, Lemma } from '../src/core/types';
import { DEFAULT_MODELS } from '../src/db/settings';

const validAnalyze: AnalyzeOutput = {
  diagnosis: [{ tag: 'noun.prep.sg', hypothesis_ja: '前置格と対格の混同', evidence: 'acc=0.55, n=40' }],
  tag_weights: [{ tag: 'noun.prep.sg', w: 2 }],
  new_items: [{
    sentence_ru: 'Я живу в ___.', lemma: 'Москва', feat: 'case.prep.sg', answer: 'Москве',
    translation_ja: '私はモスクワに住んでいます。', explain_ja: 'в＋前置格',
  }],
  tips_ja: '前置格の語尾 -е を意識しましょう。',
  feature_requests: [],
};

const completed = (text: string) => ({
  status: 'completed',
  steps: [{ type: 'thought', signature: 'x' }, { type: 'model_output', content: [{ type: 'text', text }] }],
});
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function provider(fetchFn: typeof fetch, extra: { onCall?: () => void; sleep?: (ms: number) => Promise<void> } = {}) {
  return new GeminiProvider({ apiKey: 'test-key', models: DEFAULT_MODELS, fetchFn, sleep: extra.sleep ?? (async () => {}), onCall: extra.onCall });
}

describe('GeminiProvider', () => {
  it('sends the Interactions API request and parses the last model_output', async () => {
    const fetchFn = vi.fn(async () => jsonRes(completed(JSON.stringify(validAnalyze))));
    const onCall = vi.fn();
    const packet = { profile: { native: 'ja' } };
    const out = await provider(fetchFn as unknown as typeof fetch, { onCall }).run<AnalyzeOutput>('analyze', packet, analyzeJsonSchema);
    expect(out).toEqual(validAnalyze);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onCall).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'x-goog-api-key': 'test-key', 'Content-Type': 'application/json', 'Api-Revision': API_REVISION });
    expect(API_REVISION).toBe('2026-05-20');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      model: 'gemini-3.8-flash',
      system_instruction: SYSTEM_PROMPTS.analyze,
      input: JSON.stringify(packet),
      store: false,
      response_format: { type: 'text', mime_type: 'application/json', schema: analyzeJsonSchema },
      generation_config: { thinking_level: 'medium', max_output_tokens: 8192 },
    });
  });

  it('uses the lite model with low thinking for the other tasks, and the proxy path when enabled', async () => {
    const fetchFn = vi.fn(async () => jsonRes(completed('{"explain_ja":"理由"}')));
    const p = new GeminiProvider({ apiKey: 'k', models: DEFAULT_MODELS, fetchFn: fetchFn as unknown as typeof fetch, useProxy: true });
    expect(await p.run('explain', { given: 'x' }, explainJsonSchema)).toEqual({ explain_ja: '理由' });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/gemini/v1beta/interactions');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('gemini-3.5-flash-lite');
    expect(body.generation_config.thinking_level).toBe('low');
  });

  it('retries on 429 after 2s / 4s / 8s and then succeeds', async () => {
    const responses = [jsonRes({}, 429), jsonRes({}, 503), jsonRes({}, 429), jsonRes(completed('{"explain_ja":"ok"}'))];
    const fetchFn = vi.fn(async () => responses.shift()!);
    const sleeps: number[] = [];
    const out = await provider(fetchFn as unknown as typeof fetch, { sleep: async (ms) => { sleeps.push(ms); } }).run('explain', {}, explainJsonSchema);
    expect(out).toEqual({ explain_ja: 'ok' });
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([2000, 4000, 8000]);
  });

  it('gives up after 3 retries', async () => {
    const fetchFn = vi.fn(async () => jsonRes({}, 429));
    const err = await provider(fetchFn as unknown as typeof fetch).run('explain', {}, explainJsonSchema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AIError);
    expect((err as AIError).kind).toBe('http');
    expect((err as AIError).status).toBe(429);
    expect(fetchFn).toHaveBeenCalledTimes(4); // 1 + 3 retries
  });

  it('reports a network (CORS) failure without counting it as a call', async () => {
    const onCall = vi.fn();
    const fetchFn = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const err = await provider(fetchFn as unknown as typeof fetch, { onCall }).run('explain', {}, explainJsonSchema).catch((e: unknown) => e);
    expect((err as AIError).kind).toBe('network');
    expect(onCall).not.toHaveBeenCalled();
  });

  it('does not retry on other 4xx errors', async () => {
    const fetchFn = vi.fn(async () => jsonRes({ error: { message: 'API key not valid' } }, 400));
    const err = await provider(fetchFn as unknown as typeof fetch).run('explain', {}, explainJsonSchema).catch((e: unknown) => e);
    expect((err as AIError).kind).toBe('http');
    expect((err as AIError).message).toContain('API key not valid');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects output that violates the schema', async () => {
    const bad = { ...validAnalyze, tag_weights: [{ tag: 'noun.prep.sg', w: 9 }] };
    const fetchFn = vi.fn(async () => jsonRes(completed(JSON.stringify(bad))));
    const err = await provider(fetchFn as unknown as typeof fetch).run('analyze', {}, analyzeJsonSchema).catch((e: unknown) => e);
    expect((err as AIError).kind).toBe('schema');
    const missing = vi.fn(async () => jsonRes(completed('{"diagnosis":[]}')));
    const err2 = await provider(missing as unknown as typeof fetch).run('analyze', {}, analyzeJsonSchema).catch((e: unknown) => e);
    expect((err2 as AIError).kind).toBe('schema');
  });

  it('fails when status is not "completed", on broken JSON and without a key', async () => {
    const f1 = vi.fn(async () => jsonRes({ status: 'failed', steps: [] }));
    expect(((await provider(f1 as unknown as typeof fetch).run('explain', {}, explainJsonSchema).catch((e: unknown) => e)) as AIError).kind).toBe('status');
    const f2 = vi.fn(async () => jsonRes(completed('not json')));
    expect(((await provider(f2 as unknown as typeof fetch).run('explain', {}, explainJsonSchema).catch((e: unknown) => e)) as AIError).kind).toBe('parse');
    const noKey = new GeminiProvider({ apiKey: '', models: DEFAULT_MODELS, fetchFn: f1 as unknown as typeof fetch });
    expect(((await noKey.run('explain', {}, explainJsonSchema).catch((e: unknown) => e)) as AIError).kind).toBe('nokey');
  });

  it('extractText joins the text parts of the last model_output step', () => {
    expect(extractText({ steps: [
      { type: 'model_output', content: [{ type: 'text', text: 'old' }] },
      { type: 'thought' },
      { type: 'model_output', content: [{ type: 'text', text: '{"a":' }, { type: 'image' }, { type: 'text', text: '1}' }] },
    ] })).toBe('{"a":1}');
  });

  it('ptDate uses America/Los_Angeles', () => {
    expect(ptDate(Date.UTC(2026, 10, 14, 7, 30))).toBe('2026-11-13'); // 23:30 PST the day before
    expect(ptDate(Date.UTC(2026, 10, 14, 8, 30))).toBe('2026-11-14');
  });
});

describe('ManualProvider', () => {
  it('round trip: prompt holds system prompt + schema + input, pasted fenced JSON is validated', async () => {
    const packet = { profile: { unit: 'U5' } };
    let seenPrompt = '';
    const p = new ManualProvider(async (req, validate) => {
      seenPrompt = req.prompt;
      expect(validate('oops')).toMatch(/JSON/);
      expect(validate('{"diagnosis":[]}')).toMatch(/スキーマ/);
      const reply = '解析結果です。\n```json\n' + JSON.stringify(validAnalyze, null, 2) + '\n```\n';
      expect(validate(reply)).toBeNull();
      return reply;
    });
    const out = await p.run<AnalyzeOutput>('analyze', packet, analyzeJsonSchema);
    expect(out).toEqual(validAnalyze);
    expect(seenPrompt).toBe(buildManualPrompt('analyze', packet, analyzeJsonSchema));
    expect(seenPrompt).toContain(SYSTEM_PROMPTS.analyze);
    expect(seenPrompt).toContain(JSON.stringify(analyzeJsonSchema));
    expect(seenPrompt).toContain(JSON.stringify(packet));
  });
  it('cancel rejects with kind "cancelled"', async () => {
    const p = new ManualProvider(async () => null);
    expect(((await p.run('explain', {}, explainJsonSchema).catch((e: unknown) => e)) as AIError).kind).toBe('cancelled');
  });
  it('stripFence / parseTaskOutput', () => {
    expect(stripFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFence('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFence(' {"a":1} ')).toBe('{"a":1}');
    expect(parseTaskOutput('explain', '```json\n{"explain_ja":"x"}\n```')).toEqual({ explain_ja: 'x' });
    expect(() => parseTaskOutput('gloss', '{"items":[{"id":1,"ja":"x"}]}')).toThrow(AIError);
  });
});

describe('validateNewItem', () => {
  const moskva: Lemma = {
    id: 'n-москва', bare: 'Москва', accented: 'Москва\u0301', pos: 'noun', rank: 100, level: 'A1', glossEn: ['Moscow'],
    forms: {
      'case.nom.sg': { primary: 'Москва\u0301', variants: [] }, 'case.prep.sg': { primary: 'Москве\u0301', variants: [] },
      'case.ins.sg': { primary: 'Москво\u0301й', variants: ['Москво\u0301ю'] },
    },
  };
  const item = validAnalyze.new_items[0]!;
  const v = (patch: Partial<NewItem>, cands: Lemma[] = [moskva]) => validateNewItem({ ...item, ...patch }, cands);
  it('accepts a valid item (also via variants)', () => {
    expect(v({})).toMatchObject({ ok: true, feat: 'case.prep.sg' });
    expect(v({ feat: 'case.ins.sg', answer: 'москвою' }).ok).toBe(true);
  });
  it('rejects 0 or 2 blanks', () => {
    expect(v({ sentence_ru: 'Я живу в Москве.' }).ok).toBe(false);
    expect(v({ sentence_ru: '___ живу в ___.' }).ok).toBe(false);
  });
  it('rejects an unknown lemma, an unknown feat and a wrong answer', () => {
    expect(v({}, [])).toMatchObject({ ok: false });
    expect(v({ feat: 'case.loc.sg' }).ok).toBe(false);
    expect(v({ feat: 'gender' }).ok).toBe(false);
    const r = v({ answer: 'Москву' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('Москве');
  });
});

describe('buildAnalyzePacket', () => {
  const now = Date.UTC(2026, 5, 30);
  const mk = (i: number, cls: Attempt['class'], tag: string): Attempt => ({
    id: i, itemId: `T3:w${i}:case.prep.sg`, ts: now - (i % 20) * DAY_MS - 1000, type: 'T3', given: 'книгу'.repeat(1 + (i % 3)), class: cls,
    rating: 1, latencyMs: 1000, hintCount: 0, tags: [tag], prompt: 'книга / prep.sg', expected: 'кни\u0301ге',
    ...(cls === 'wrong_form' ? { confusion: { expected: 'case.prep.sg', given: 'case.acc.sg' } } : {}),
  });
  const attempts: Attempt[] = [];
  for (let i = 0; i < 400; i++) attempts.push(mk(i, i % 3 === 0 ? 'correct' : i % 3 === 1 ? 'wrong_form' : 'wrong', `noun.${['gen', 'dat', 'acc', 'ins', 'prep'][i % 5]}.${i % 2 ? 'sg' : 'pl'}`));
  attempts.push(mk(999, 'wrong', 'vocab')); // n < 5 -> not in tag_stats
  const packet = buildAnalyzePacket({ now, unitId: 'U5', attempts, stats: tagStats(attempts, now), weights: { 'noun.prep.sg': 1.5 } });

  it('has the documented shape and limits', () => {
    expect(packet.profile).toMatchObject({ native: 'ja', goal: 'writing→ТРКИ', unit: 'U5' });
    expect(packet.profile.days).toBeGreaterThanOrEqual(19);
    expect(packet.tag_stats.length).toBeLessThanOrEqual(15);
    expect(packet.tag_stats.every((t) => t.n >= 5)).toBe(true);
    expect(packet.tag_stats.some((t) => t.tag === 'vocab')).toBe(false);
    const lbs = packet.tag_stats.map((t) => t.lb);
    expect([...lbs].sort((a, b) => a - b)).toEqual(lbs); // weakest (lowest LB) first
    expect(packet.confusions[0]).toMatchObject({ expected: 'case.prep.sg', given: 'case.acc.sg' });
    expect(packet.confusions.length).toBeLessThanOrEqual(10);
    expect(packet.samples.length).toBeLessThanOrEqual(10);
    expect(packet.samples[0]!.class).toBe('wrong'); // wrong first
    expect(packet.samples.every((s) => s.class !== 'correct')).toBe(true);
    expect(packet.samples[0]!.expected).toBe('книге'); // no stress marks
    expect(packet.current_weights).toEqual([{ tag: 'noun.prep.sg', w: 1.5 }]);
    expect(JSON.stringify(packet).length).toBeLessThanOrEqual(PACKET_MAX_CHARS);
  });
  it('drops samples until it fits', () => {
    const long = attempts.map((a) => ({ ...a, prompt: 'п'.repeat(80), expected: 'о'.repeat(80), given: 'д'.repeat(80) }));
    const stats = tagStats(long, now);
    const weights = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`noun.gen.sg.${i}`, 1.5]));
    const p = buildAnalyzePacket({ now, unitId: 'U5', attempts: long, stats, weights });
    expect(p.samples.length).toBeLessThan(10);
  });
});
