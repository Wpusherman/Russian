/**
 * Build /public/dict/dict.json from the OpenRussian CSV export placed in /data/raw/.
 * Run: npm run build:dict
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertAccent } from '../src/core/accent';
import type { Form, Lemma } from '../src/core/types';

export { convertAccent };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', 'raw');
const OUT_DIR = join(ROOT, 'public', 'dict');

const CASE_COLS: [string, string][] = [
  ['nom', 'nom'], ['gen', 'gen'], ['dat', 'dat'], ['acc', 'acc'], ['ins', 'inst'], ['prep', 'prep'],
];

/**
 * COLUMN_MAP: confirmed against the actual headers of the files in /data/raw
 * (tab-separated export: nouns.csv / verbs.csv / adjectives.csv / others.csv; there is
 * no words.csv, so id / rank / level are derived - see DECISIONS.md).
 * Every column named here is required; if one is missing the script prints the
 * actual header and exits with code 1.
 */
const COLUMN_MAP = {
  common: { bare: 'bare', accented: 'accented', glossEn: 'translations_en' },
  nouns: {
    file: 'nouns.csv',
    gender: 'gender', animate: 'animate', plOnly: 'pl_only',
    forms: Object.fromEntries(
      (['sg', 'pl'] as const).flatMap((n) => CASE_COLS.map(([c, col]) => [`case.${c}.${n}`, `${n}_${col}`])),
    ) as Record<string, string>,
  },
  verbs: {
    file: 'verbs.csv',
    aspect: 'aspect', partner: 'partner',
    forms: {
      'pres.1sg': 'presfut_sg1', 'pres.2sg': 'presfut_sg2', 'pres.3sg': 'presfut_sg3',
      'pres.1pl': 'presfut_pl1', 'pres.2pl': 'presfut_pl2', 'pres.3pl': 'presfut_pl3',
      'past.m': 'past_m', 'past.f': 'past_f', 'past.n': 'past_n', 'past.pl': 'past_pl',
      'imp.sg': 'imperative_sg', 'imp.pl': 'imperative_pl',
    } as Record<string, string>,
  },
  adjectives: {
    file: 'adjectives.csv',
    forms: Object.fromEntries(
      (['m', 'f', 'n', 'pl'] as const).flatMap((g) => CASE_COLS.map(([c, col]) => [`adj.${c}.${g}`, `decl_${g}_${col}`])),
    ) as Record<string, string>,
  },
  others: { file: 'others.csv' },
};

/** Split a cell into cleaned forms (primary first). */
export function splitForms(cell: string): Form | null {
  const parts = cell
    .split(/[,;]/)
    .map((p) => convertAccent(p.replace(/\([^)]*\)/g, '').replace(/[*()]/g, '').replace(/\s+/g, ' ').trim()))
    .filter((p) => p.length > 0);
  const uniq = [...new Set(parts)];
  if (uniq.length === 0) return null;
  return { primary: uniq[0]!, variants: uniq.slice(1) };
}

/** Level derived from the per-file frequency rank (the export has no level column). */
export function levelFromRank(rank: number): string | null {
  if (rank <= 200) return 'A1';
  if (rank <= 500) return 'A2';
  if (rank <= 1000) return 'B1';
  if (rank <= 2000) return 'B2';
  if (rank <= 4000) return 'C1';
  return null;
}

/** Accent-free lower-case form used by the derivation helpers below. */
function plain(s: string): string {
  return s.normalize('NFC').replace(/\u0301/g, '').toLowerCase();
}

const VOWEL_SET = new Set([...'аеиоуыэюя']);
const CONSONANTS = 'бвгджзйклмнпрстфхцчшщ';

/**
 * Gender inferred from the nominative-singular ending. -ь gives no answer.
 * A gender that the source data provides always wins over this (see the nouns block).
 */
export function inferGender(bare: string): 'm' | 'f' | 'n' | undefined {
  const b = plain(bare);
  if (b.endsWith('мя')) return 'n';
  if (b.endsWith('ь')) return undefined;
  const last = b.slice(-1);
  if (CONSONANTS.includes(last)) return 'm';
  if (last === 'а' || last === 'я') return 'f';
  if (last === 'о' || last === 'е' || last === 'ё') return 'n';
  return undefined;
}

/** Consonant alternations, longest source first. */
const ALT_PAIRS: readonly [string, string][] = [
  ['ст', 'щ'], ['ск', 'щ'], ['д', 'жд'], ['с', 'ш'], ['з', 'ж'], ['т', 'ч'], ['т', 'щ'], ['д', 'ж'],
  ['к', 'ч'], ['г', 'ж'], ['х', 'ш'], ['б', 'бл'], ['п', 'пл'], ['в', 'вл'], ['ф', 'фл'], ['м', 'мл'],
];

/**
 * Alternation between the infinitive stem and the pres.1sg stem (писать -> с/ш).
 * scope 'all' when the pres.2sg stem ends with the same consonant as the 1sg stem, otherwise '1sg'.
 */
export function alternationFor(bare: string, forms: Record<string, Form>): Lemma['alt'] | undefined {
  const p1 = forms['pres.1sg'];
  if (!p1) return undefined;
  let s = plain(bare).replace(/(ся|сь)$/, '').replace(/(ть|ти|чь)$/, '');
  if (VOWEL_SET.has(s.slice(-1))) s = s.slice(0, -1);
  const t = plain(p1.primary).replace(/(ся|сь)$/, '').replace(/[ую]$/, '');
  for (const [from, to] of ALT_PAIRS) {
    if (!s.endsWith(from) || !t.endsWith(to)) continue;
    if (s.slice(0, -from.length) !== t.slice(0, -to.length)) continue;
    const p2 = forms['pres.2sg'];
    const stem2 = p2 ? plain(p2.primary).replace(/(ся|сь)$/, '').replace(/(ешь|ёшь|ишь)$/, '') : '';
    return { from, to, scope: stem2.endsWith(to) ? 'all' : '1sg' };
  }
  return undefined;
}

/**
 * Dictionary forms that contain a spelling-rule violation ([гкхжшщч]ы / [гкхжшщчц][яю]),
 * i.e. the exceptions (жюри, парашют...) that must not be flagged by the rule check.
 */
export function spellExceptionForms(lemmas: Lemma[]): string[] {
  const re = [/[гкхжшщч]ы/, /[гкхжшщчц][яю]/];
  const out = new Set<string>();
  for (const l of lemmas) {
    const forms = [l.bare, ...Object.entries(l.forms).filter(([k]) => k !== 'aspect' && k !== 'gender').flatMap(([, f]) => [f.primary, ...f.variants])];
    for (const f of forms) {
      const n = plain(f);
      if (re.some((r) => r.test(n))) out.add(n);
    }
  }
  return [...out].sort();
}

type Table = { header: string[]; rows: string[][] };

function parseLine(line: string, delim: string): string[] {
  if (delim === '\t') return line.split('\t');
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function readTable(file: string): Table {
  const path = join(RAW, file);
  if (!existsSync(path)) {
    console.error(`Missing file: ${path}`);
    process.exit(1);
  }
  const lines = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.length > 0);
  const delim = lines[0]!.includes('\t') ? '\t' : ',';
  return { header: parseLine(lines[0]!, delim), rows: lines.slice(1).map((l) => parseLine(l, delim)) };
}

function indexer(file: string, t: Table, required: string[]) {
  const missing = required.filter((c) => !t.header.includes(c));
  if (missing.length > 0) {
    console.error(`${file}: required column(s) not found: ${missing.join(', ')}`);
    console.error(`Actual columns: ${t.header.join(', ')}`);
    process.exit(1);
  }
  const idx = new Map(t.header.map((h, i) => [h, i]));
  return (row: string[], col: string): string => (row[idx.get(col)!] ?? '').trim();
}

function glossList(cell: string): string[] {
  return [...new Set(cell.split(/[,;]/).map((s) => s.trim()).filter(Boolean))];
}

function main() {
  const lemmas: Lemma[] = [];
  const usedIds = new Set<string>();
  const C = COLUMN_MAP.common;
  const commonCols = [C.bare, C.accented, C.glossEn];

  const base = (prefix: string, i: number, get: (c: string) => string): Lemma => {
    const rank = i + 1;
    const bare = get(C.bare).normalize('NFC');
    return {
      id: '', bare, accented: convertAccent(get(C.accented)) || bare, pos: 'other',
      rank, level: levelFromRank(rank), glossEn: glossList(get(C.glossEn)), forms: {},
      // temporary marker, replaced by assignId
      ...({ _p: prefix } as object),
    };
  };
  /** Stable id: "<prefix>-<bare>", duplicates get "~2", "~3"... (no ':' so item ids stay parseable). */
  const assignId = (l: Lemma) => {
    const prefix = (l as unknown as { _p: string })._p;
    delete (l as unknown as { _p?: string })._p;
    const stem = `${prefix}-${l.bare.replace(/[:\s]/g, '_')}`;
    let id = stem;
    for (let k = 2; usedIds.has(id); k++) id = `${stem}~${k}`;
    usedIds.add(id);
    l.id = id;
  };
  const collectForms = (map: Record<string, string>, get: (c: string) => string) => {
    const forms: Record<string, Form> = {};
    for (const [feat, col] of Object.entries(map)) {
      const f = splitForms(get(col));
      if (f) forms[feat] = f;
    }
    return forms;
  };
  // Keep: every noun/verb/adj with inflection data; anything else only when rank <= 10000.
  const keep = (l: Lemma) => l.bare.length > 0 && (Object.keys(l.forms).length > 0 || (l.rank ?? Infinity) <= 10000);

  { // nouns
    const N = COLUMN_MAP.nouns;
    const t = readTable(N.file);
    const g = indexer(N.file, t, [...commonCols, N.gender, N.animate, N.plOnly, ...Object.values(N.forms)]);
    t.rows.forEach((row, i) => {
      const get = (c: string) => g(row, c);
      const l = base('n', i, get);
      l.forms = collectForms(N.forms, get);
      if (Object.keys(l.forms).length > 0) l.pos = 'noun';
      const gender = get(N.gender);
      if (get(N.plOnly) === '1') l.gender = 'pl';
      else if (gender === 'm' || gender === 'f' || gender === 'n' || gender === 'pl') l.gender = gender;
      if (!l.gender && l.pos === 'noun') {
        // Source data always wins; only fill a missing gender from the ending.
        const inferred = inferGender(l.bare);
        if (inferred) { l.gender = inferred; l.genderInferred = true; }
      }
      const an = get(N.animate);
      if (an === '1') l.animate = true;
      else if (an === '0') l.animate = false;
      if (keep(l)) { assignId(l); lemmas.push(l); }
    });
  }
  { // verbs
    const V = COLUMN_MAP.verbs;
    const t = readTable(V.file);
    const g = indexer(V.file, t, [...commonCols, V.aspect, V.partner, ...Object.values(V.forms)]);
    const verbs: { l: Lemma; partners: string[] }[] = [];
    t.rows.forEach((row, i) => {
      const get = (c: string) => g(row, c);
      const l = base('v', i, get);
      l.forms = collectForms(V.forms, get);
      if (Object.keys(l.forms).length > 0) l.pos = 'verb';
      const a = get(V.aspect);
      if (a === 'imperfective') l.aspect = 'impf';
      else if (a === 'perfective') l.aspect = 'pf';
      else if (a === 'both') l.aspect = 'both';
      const alt = alternationFor(l.bare, l.forms);
      if (alt) l.alt = alt;
      if (keep(l)) {
        assignId(l);
        verbs.push({ l, partners: get(V.partner).split(/[,;]/).map((s) => s.trim()).filter(Boolean) });
      }
    });
    const byBare = new Map<string, Lemma>();
    for (const { l } of verbs) if (!byBare.has(l.bare)) byBare.set(l.bare, l);
    for (const { l, partners } of verbs) {
      const ps = partners.map((p) => byBare.get(p)).filter((x): x is Lemma => !!x && x.id !== l.id);
      if (ps.length > 0) {
        l.partnerIds = ps.map((p) => p.id);
        // Pseudo form "aspect": the aspect partner(s), drilled as T3 for tag verb.aspect.
        if (l.aspect) l.forms['aspect'] = { primary: ps[0]!.accented, variants: ps.slice(1).map((p) => p.accented) };
      }
      lemmas.push(l);
    }
  }
  { // adjectives
    const A = COLUMN_MAP.adjectives;
    const t = readTable(A.file);
    const g = indexer(A.file, t, [...commonCols, ...Object.values(A.forms)]);
    t.rows.forEach((row, i) => {
      const get = (c: string) => g(row, c);
      const l = base('a', i, get);
      l.forms = collectForms(A.forms, get);
      if (Object.keys(l.forms).length > 0) l.pos = 'adj';
      if (keep(l)) { assignId(l); lemmas.push(l); }
    });
  }
  { // others
    const O = COLUMN_MAP.others;
    const t = readTable(O.file);
    const g = indexer(O.file, t, commonCols);
    t.rows.forEach((row, i) => {
      const l = base('o', i, (c) => g(row, c));
      if (keep(l)) { assignId(l); lemmas.push(l); }
    });
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const json = JSON.stringify(lemmas);
  const hash = createHash('sha256').update(json).digest('hex').slice(0, 16);
  writeFileSync(join(OUT_DIR, 'dict.json'), json);
  const spellExceptions = spellExceptionForms(lemmas);
  writeFileSync(join(OUT_DIR, 'dict.meta.json'), JSON.stringify({ hash, count: lemmas.length, spellExceptions }));
  const by = (p: string) => lemmas.filter((l) => l.pos === p).length;
  console.log(
    `dict.json: ${lemmas.length} lemmas (noun ${by('noun')}, verb ${by('verb')}, adj ${by('adj')}, other ${by('other')}), ` +
      `${(Buffer.byteLength(json) / 1e6).toFixed(1)} MB, hash ${hash}, ` +
      `alt ${lemmas.filter((l) => l.alt).length}, inferred gender ${lemmas.filter((l) => l.genderInferred).length}, ` +
      `spell exceptions ${spellExceptions.length}`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) main();
