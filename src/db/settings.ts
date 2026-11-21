import type { LemmaRow } from './db';
import { db } from './db';

export type AITask = 'analyze' | 'gloss' | 'explain' | 'note' | 'grade_t7' | 'aspect_items';
export const AI_TASKS: AITask[] = ['analyze', 'gloss', 'explain', 'note', 'grade_t7', 'aspect_items'];

export type Settings = {
  dictVersion: string;
  /** App version recorded at the last startup; a change triggers the backlog cleanup. */
  appVersion: string;
  sessionSize: number;
  dailyNewLimit: number;
  yoLenient: boolean;
  /** Show answer hints before submitting (reflexive / spelling warnings). Any warning makes the answer a hint. */
  liveWarnings: boolean;
  inputMode: 'translit' | 'os';
  showKeyboard: boolean;
  voiceURI: string;
  speechRate: number;
  aiProvider: 'gemini' | 'manual';
  models: Record<AITask, string>;
  useProxy: boolean;
  lastAnalysisAt: number;
  lastAnalyzedAttemptId: number;
  /** Japanese glosses (AI / word lists). Kept here so they survive dictionary rebuilds and export/import. */
  glossJa: Record<string, string>;
  /** Grammar annotations (e.g. "+対") per lemma id, kept like glossJa. */
  hints: Record<string, string>;
  /** Dictionary forms that legitimately contain a spelling-rule pattern (from dict.meta.json). */
  spellExceptions: string[];
  /** Word-list words that are not in the dictionary. */
  userLemmas: LemmaRow[];
  seedVersion: number;
};

export const DEFAULT_MODELS: Record<AITask, string> = {
  analyze: 'gemini-3.8-flash',
  gloss: 'gemini-3.5-flash-lite',
  explain: 'gemini-3.5-flash-lite',
  note: 'gemini-3.5-flash-lite',
  grade_t7: 'gemini-3.5-flash-lite',
  aspect_items: 'gemini-3.5-flash-lite',
};

export const DEFAULTS: Settings = {
  dictVersion: '',
  appVersion: '',
  sessionSize: 20,
  dailyNewLimit: 15,
  yoLenient: true,
  liveWarnings: false,
  inputMode: 'translit',
  showKeyboard: false,
  voiceURI: '',
  speechRate: 0.9,
  aiProvider: 'gemini',
  models: DEFAULT_MODELS,
  useProxy: false,
  lastAnalysisAt: 0,
  lastAnalyzedAttemptId: 0,
  glossJa: {},
  hints: {},
  spellExceptions: [],
  userLemmas: [],
  seedVersion: 0,
};

export async function loadSettings(): Promise<Settings> {
  const rows = await db.settings.toArray();
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const r of rows) if (r.key in DEFAULTS && r.value !== undefined) out[r.key] = r.value;
  const s = out as Settings;
  s.models = { ...DEFAULT_MODELS, ...s.models };
  s.sessionSize = Math.min(50, Math.max(10, Math.round(Number(s.sessionSize) || DEFAULTS.sessionSize)));
  s.dailyNewLimit = Math.max(0, Math.round(Number(s.dailyNewLimit) || 0));
  return s;
}

export async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  await db.settings.put({ key, value });
}

// ---------- API key (localStorage, never stored in IndexedDB / exports) ----------

const KEY_NAME = 'ruslo.geminiApiKey';

export function getApiKey(): string {
  if (typeof localStorage === 'undefined') return '';
  const stored = localStorage.getItem(KEY_NAME);
  if (stored !== null) return stored;
  // Dev convenience: seed from .env.development.local on first run.
  const seed = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_GEMINI_API_KEY ?? '';
  if (seed) localStorage.setItem(KEY_NAME, seed);
  return seed;
}

export function setApiKey(key: string): void {
  localStorage.setItem(KEY_NAME, key.trim());
}
