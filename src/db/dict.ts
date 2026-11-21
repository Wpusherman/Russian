import { normalize } from '../core/normalize';
import type { Lemma } from '../core/types';
import { db, type LemmaRow } from './db';
import { loadSettings, setSetting } from './settings';

export type DictProgress = { phase: 'check' | 'download' | 'parse' | 'import' | 'done'; ratio: number };

export function lemmaKey(bare: string): string {
  return normalize(bare, { yoLenient: true });
}

export function toRow(l: Lemma, glossJa?: string): LemmaRow {
  const row: LemmaRow = { ...l, key: lemmaKey(l.bare) };
  if (glossJa) row.glossJa = glossJa;
  return row;
}

/** Re-apply user data that lives outside the dictionary file (glosses, case hints, user words). */
export async function reapplyUserData(): Promise<void> {
  const s = await loadSettings();
  if (s.userLemmas.length > 0) await db.lemmas.bulkPut(s.userLemmas);
  const ids = Object.keys(s.glossJa);
  if (ids.length > 0) {
    const rows = await db.lemmas.bulkGet(ids);
    const upd = rows.filter((r): r is LemmaRow => !!r).map((r) => ({ ...r, glossJa: s.glossJa[r.id] }));
    await db.lemmas.bulkPut(upd);
  }
  const hintIds = Object.keys(s.hints);
  if (hintIds.length > 0) {
    const rows = await db.lemmas.bulkGet(hintIds);
    const upd = rows.filter((r): r is LemmaRow => !!r).map((r) => ({ ...r, hint: s.hints[r.id] }));
    await db.lemmas.bulkPut(upd);
  }
  // F1: a user correction wins over the ending-based inference and makes the gender authoritative.
  const genderIds = Object.keys(s.genderOverrides);
  if (genderIds.length > 0) {
    const rows = await db.lemmas.bulkGet(genderIds);
    const upd = rows.filter((r): r is LemmaRow => !!r).map((r) => ({ ...r, gender: s.genderOverrides[r.id], genderInferred: undefined }));
    await db.lemmas.bulkPut(upd);
  }
}

/** F1: store a user's gender correction for an inferred noun. */
export async function setGenderOverride(id: string, gender: 'm' | 'f' | 'n'): Promise<void> {
  const s = await loadSettings();
  await setSetting('genderOverrides', { ...s.genderOverrides, [id]: gender });
  const row = await db.lemmas.get(id);
  if (row) await db.lemmas.put({ ...row, gender, genderInferred: undefined });
}

async function fetchWithProgress(url: string, onRatio: (r: number) => void): Promise<string> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`dict.json を取得できません (HTTP ${res.status})。npm run build:dict を実行してください。`);
  const total = Number(res.headers.get('content-length') ?? 0);
  if (!res.body || !total) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onRatio(Math.min(1, got / total));
  }
  return new Blob(chunks as BlobPart[]).text();
}

/**
 * First run (or changed dict file): fetch dict.json and bulk-load it into `lemmas`.
 * The file hash comes from dict.meta.json (written by build-dict) and is kept in settings.dictVersion.
 */
let running: Promise<void> | null = null;
const listeners = new Set<(p: DictProgress) => void>();

/** Single-flight wrapper (React StrictMode mounts effects twice in dev). */
export function ensureDict(onProgress: (p: DictProgress) => void): Promise<void> {
  listeners.add(onProgress);
  running ??= loadDict((p) => listeners.forEach((l) => l(p))).finally(() => { running = null; });
  return running.finally(() => listeners.delete(onProgress));
}

async function loadDict(onProgress: (p: DictProgress) => void): Promise<void> {
  onProgress({ phase: 'check', ratio: 0 });
  const settings = await loadSettings();
  const base = import.meta.env.BASE_URL;
  let hash = '';
  try {
    const res = await fetch(`${base}dict/dict.meta.json`, { cache: 'no-cache' });
    if (res.ok) {
      const meta = (await res.json()) as { hash?: string; spellExceptions?: string[] };
      hash = String(meta.hash ?? '');
      if (Array.isArray(meta.spellExceptions)) await setSetting('spellExceptions', meta.spellExceptions);
    }
  } catch {
    hash = '';
  }
  const count = await db.lemmas.count();
  if (count > 0 && (hash === '' || hash === settings.dictVersion)) {
    onProgress({ phase: 'done', ratio: 1 });
    return;
  }
  if (hash === '') throw new Error('辞書ファイルが見つかりません。data/raw にCSVを置いて npm run build:dict を実行してください。');

  const text = await fetchWithProgress(`${base}dict/dict.json`, (r) => onProgress({ phase: 'download', ratio: r }));
  onProgress({ phase: 'parse', ratio: 0 });
  await new Promise((r) => setTimeout(r, 0));
  const lemmas = JSON.parse(text) as Lemma[];
  await db.lemmas.clear();
  const CHUNK = 2000;
  for (let i = 0; i < lemmas.length; i += CHUNK) {
    await db.lemmas.bulkPut(lemmas.slice(i, i + CHUNK).map((l) => toRow(l)));
    onProgress({ phase: 'import', ratio: Math.min(1, (i + CHUNK) / lemmas.length) });
  }
  await reapplyUserData();
  await setSetting('dictVersion', hash);
  onProgress({ phase: 'done', ratio: 1 });
}

/** Dictionary lookup for the search box: exact / prefix match on the normalized headword. */
export async function searchLemmas(query: string, limit = 30): Promise<LemmaRow[]> {
  const q = lemmaKey(query);
  if (!q) return [];
  const rows = await db.lemmas.where('key').startsWith(q).limit(300).toArray();
  rows.sort((a, b) => a.key.length - b.key.length || (a.rank ?? 1e9) - (b.rank ?? 1e9));
  return rows.slice(0, limit);
}

/** All lemmas whose normalized headword equals `bare`, lowest rank first. */
export async function findLemmas(bare: string): Promise<LemmaRow[]> {
  const rows = await db.lemmas.where('key').equals(lemmaKey(bare)).toArray();
  return rows.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
}
