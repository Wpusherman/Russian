import { normalize } from './normalize';
import { ADJ_GENDERS, CASES, GENDER_FEAT, NUMBERS, type FeatKey, type Form, type Lemma } from './types';

export const ASPECT_FEAT = 'aspect';
/** Feats that are not real inflected forms (excluded from wrong_form matching and AI validation). */
export const PSEUDO_FEATS: readonly string[] = [GENDER_FEAT, ASPECT_FEAT];

export const PERSONAL_PRONOUNS = ['я', 'ты', 'он', 'она', 'оно', 'мы', 'вы', 'они'];
export const POSSESSIVES = ['мой', 'твой', 'наш', 'ваш', 'свой'];
export const MOTION_VERBS = [
  'идти', 'ходить', 'ехать', 'ездить', 'бежать', 'бегать', 'лететь', 'летать', 'плыть', 'плавать',
  'нести', 'носить', 'везти', 'возить', 'вести', 'водить',
  'пойти', 'поехать', 'прийти', 'приходить', 'приехать', 'приезжать', 'уйти', 'уходить', 'уехать', 'уезжать',
  'войти', 'входить', 'выйти', 'выходить',
];
/** Prepositions recognised when tagging T4 sentences (word right before the blank). */
export const PREPOSITIONS = [
  'в', 'на', 'о', 'об', 'у', 'из', 'без', 'с', 'со', 'к', 'по', 'от', 'до', 'для', 'за', 'над', 'под', 'перед', 'про', 'через', 'при', 'между', 'около', 'после',
];
const PREP_CANON: Record<string, string> = { об: 'о', обо: 'о', со: 'с', во: 'в', ко: 'к' };

export function prepTag(word: string): string | null {
  const w = normalize(word);
  const canon = PREP_CANON[w] ?? w;
  return PREPOSITIONS.includes(canon) ? `prep.${canon}` : null;
}

const FIXED_TAGS = [
  'spell.y_i', 'spell.o_e', 'spell.a_ya', 'phon.stress', 'noun.gender',
  'verb.pres.conj1', 'verb.pres.conj2', 'verb.pres.irreg', 'verb.pres.alt', 'verb.reflexive', 'verb.past', 'verb.imp', 'verb.aspect', 'verb.aspect.pair',
  'verb.aspect.choice', 'verb.motion',
  'num.gov', 'pron.personal', 'pron.possessive', 'vocab',
];

export const ALL_TAGS: string[] = [
  ...FIXED_TAGS,
  ...CASES.flatMap((c) => NUMBERS.map((n) => `noun.${c}.${n}`)),
  ...CASES.flatMap((c) => ADJ_GENDERS.map((g) => `adj.${c}.${g}`)),
  ...PREPOSITIONS.map((p) => `prep.${p}`),
];
const TAG_SET = new Set(ALL_TAGS);

export function isValidTag(tag: string): boolean {
  return TAG_SET.has(tag) || /^prep\.[а-яё]+$/.test(tag);
}

/** Expand a unit pattern like "noun.*.pl" or "spell.*" against the known tag list. */
export function expandTagPattern(pattern: string): string[] {
  if (!pattern.includes('*')) return [pattern];
  const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]+') + '$');
  return ALL_TAGS.filter((t) => re.test(t));
}

export type ConjType = 'conj1' | 'conj2' | 'irreg';

export function verbConjType(lemma: Lemma): ConjType {
  const f = lemma.forms['pres.2sg'];
  if (!f) return 'irreg';
  const s = normalize(f.primary).replace(/(ся|сь)$/, '');
  if (/[её]шь$/.test(normalize(f.primary, { yoLenient: false }).replace(/(ся|сь)$/, ''))) return 'conj1';
  if (s.endsWith('ишь')) return 'conj2';
  return 'irreg';
}

const GENDER_ANSWER: Record<string, string> = { m: 'он', f: 'она', n: 'оно', pl: 'они' };

/** The expected answer for a lemma + feat (handles the computed "gender" pseudo feat). */
export function expectedForm(lemma: Lemma, feat: FeatKey): Form | null {
  if (feat === GENDER_FEAT) {
    // A gender inferred from the ending is not trustworthy enough to ask "он / она / оно".
    if (lemma.pos !== 'noun' || !lemma.gender || lemma.genderInferred) return null;
    return { primary: GENDER_ANSWER[lemma.gender]!, variants: [] };
  }
  return lemma.forms[feat] ?? null;
}

/** Real inflected feats of a lemma (no pseudo feats). */
export function realFeats(lemma: Lemma): FeatKey[] {
  return Object.keys(lemma.forms).filter((k) => !PSEUDO_FEATS.includes(k));
}

/**
 * Feats worth drilling (T3): forms that differ from the dictionary form, plus "gender" / "aspect".
 */
export function drillFeats(lemma: Lemma): FeatKey[] {
  const bare = normalize(lemma.bare);
  const out = realFeats(lemma).filter((k) => {
    const f = lemma.forms[k]!;
    return normalize(f.primary) !== bare;
  });
  if (lemma.pos === 'noun' && lemma.gender && !lemma.genderInferred) out.push(GENDER_FEAT);
  if (lemma.forms[ASPECT_FEAT]) out.push(ASPECT_FEAT);
  return out;
}

function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Spelling-rule tags exercised by producing this form (7-letter rule etc.). */
export function spellTagsFor(lemma: Lemma, feat: FeatKey, form: Form): string[] {
  const f = normalize(form.primary);
  const start = Math.max(1, commonPrefixLen(normalize(lemma.bare), f) - 1);
  const tags = new Set<string>();
  for (let i = start; i < f.length; i++) {
    const prev = f[i - 1]!;
    const ch = f[i]!;
    if ('гкхжшщч'.includes(prev) && ch === 'и') tags.add('spell.y_i');
    if ((lemma.pos === 'noun' || lemma.pos === 'adj') && 'жшщчц'.includes(prev) && (ch === 'о' || ch === 'е')) tags.add('spell.o_e');
    if (lemma.pos === 'verb' && (feat === 'pres.1sg' || feat === 'pres.3pl') && 'гкхжшщчц'.includes(prev) && (ch === 'а' || ch === 'у')) {
      tags.add('spell.a_ya');
    }
  }
  return [...tags];
}

/** Tags for a T3 (and T4) item, derived from the lemma and the FeatKey. */
export function tagsForFeat(lemma: Lemma, feat: FeatKey): string[] {
  const tags: string[] = [];
  const bare = normalize(lemma.bare);
  if (feat === GENDER_FEAT) return ['noun.gender'];
  if (feat === ASPECT_FEAT) return ['verb.aspect.pair'];
  const p = feat.split('.');
  if (p[0] === 'case') {
    if (PERSONAL_PRONOUNS.includes(bare) && lemma.pos === 'other') tags.push('pron.personal');
    else tags.push(`noun.${p[1]}.${p[2]}`);
  } else if (p[0] === 'adj') {
    tags.push(`adj.${p[1]}.${p[2]}`);
    if (POSSESSIVES.includes(bare)) tags.push('pron.possessive');
  } else if (p[0] === 'pres') {
    tags.push(`verb.pres.${verbConjType(lemma)}`);
  } else if (p[0] === 'past') {
    tags.push('verb.past');
  } else if (p[0] === 'imp') {
    tags.push('verb.imp');
  }
  if (lemma.pos === 'verb' && MOTION_VERBS.includes(bare) && (p[0] === 'pres' || p[0] === 'past')) tags.push('verb.motion');
  // B2: every T3 (and T4) of a reflexive verb exercises the -ся / -сь suffix.
  if (lemma.pos === 'verb' && /(ся|сь)$/.test(bare)) tags.push('verb.reflexive');
  // B1: the alternation tag goes on the persons where the stem actually alternates.
  if (lemma.alt && p[0] === 'pres' && (lemma.alt.scope === 'all' || feat === 'pres.1sg')) tags.push('verb.pres.alt');
  const form = lemma.forms[feat];
  if (form) tags.push(...spellTagsFor(lemma, feat, form));
  return tags;
}

// ---------- Japanese labels ----------

/** Infinitive stem (without the final vowel) and pres.1sg stem, accents removed. */
export function verbStems(lemma: Lemma): { infFull: string; inf: string; pres1: string } | null {
  const infFull = normalize(lemma.bare).replace(/(ся|сь)$/, '').replace(/(ть|ти|чь)$/, '');
  const inf = /[аеиоуыэюя]$/.test(infFull) ? infFull.slice(0, -1) : infFull;
  const p1 = lemma.forms['pres.1sg'];
  if (!p1) return null;
  const pres1 = normalize(p1.primary).replace(/(ся|сь)$/, '').replace(/[ую]$/, '');
  return { infFull, inf, pres1 };
}

export const ASPECT_JA: Record<'impf' | 'pf' | 'both', string> = { impf: '不完', pf: '完', both: '両体' };

/** Badge shown after a verb's translation (A1). */
export function aspectBadge(lemma: Pick<Lemma, 'aspect'>): string {
  return lemma.aspect ? `〔${ASPECT_JA[lemma.aspect]}〕` : '';
}

export const CASE_JA: Record<string, string> = { nom: '主格', gen: '生格', dat: '与格', acc: '対格', ins: '造格', prep: '前置格' };
export const NUM_JA: Record<string, string> = { sg: '単数', pl: '複数' };
export const GENDER_JA: Record<string, string> = { m: '男性', f: '女性', n: '中性', pl: '複数' };
const PERSON_JA: Record<string, string> = {
  '1sg': '1人称単数 (я)', '2sg': '2人称単数 (ты)', '3sg': '3人称単数 (он/она)',
  '1pl': '1人称複数 (мы)', '2pl': '2人称複数 (вы)', '3pl': '3人称複数 (они)',
};

export function featLabelJa(feat: FeatKey, lemma?: Lemma): string {
  if (feat === GENDER_FEAT) return '性（он / она / оно / они で答える）';
  if (feat === ASPECT_FEAT) return lemma?.aspect === 'pf' ? '体のペア（不完了体）' : lemma?.aspect === 'impf' ? '体のペア（完了体）' : '体のペア';
  const p = feat.split('.');
  switch (p[0]) {
    case 'case': return `${CASE_JA[p[1]!] ?? p[1]}・${NUM_JA[p[2]!] ?? p[2]}`;
    case 'adj': return `${CASE_JA[p[1]!] ?? p[1]}・${GENDER_JA[p[2]!] ?? p[2]}`;
    case 'pres': return `${lemma?.aspect === 'pf' ? '未来形' : '現在形'}・${PERSON_JA[p[1]!] ?? p[1]}`;
    case 'past': return `過去形・${GENDER_JA[p[1]!] ?? p[1]}`;
    case 'imp': return `命令形・${p[1] === 'sg' ? '単数 (ты)' : '複数 (вы)'}`;
    default: return feat;
  }
}

export function confusionLabelJa(expected: FeatKey, given: FeatKey): string {
  const e = expected.split('.');
  const g = given.split('.');
  if (e[0] === g[0] && (e[0] === 'case' || e[0] === 'adj') && e.length === 3 && g.length === 3) {
    const numJa = e[0] === 'case' ? NUM_JA : GENDER_JA;
    if (e[1] !== g[1] && e[2] === g[2]) return `${CASE_JA[g[1]!]}と${CASE_JA[e[1]!]}を取り違え`;
    if (e[1] === g[1] && e[2] !== g[2]) return `${numJa[g[2]!]}と${numJa[e[2]!]}を取り違え`;
  }
  return `「${featLabelJa(given)}」と「${featLabelJa(expected)}」を取り違え`;
}

const FIXED_TAG_JA: Record<string, string> = {
  'spell.y_i': '綴り：и / ы の規則', 'spell.o_e': '綴り：о / е の規則', 'spell.a_ya': '綴り：а・у / я・ю の規則',
  'phon.stress': 'アクセント', 'noun.gender': '名詞の性',
  'verb.pres.conj1': '現在形・第1変化', 'verb.pres.conj2': '現在形・第2変化', 'verb.pres.irreg': '現在形・不規則',
  'verb.pres.alt': '子音交替', 'verb.reflexive': '再帰動詞', 'verb.past': '過去形', 'verb.imp': '命令形', 'verb.aspect': '体', 'verb.aspect.pair': '体のペア', 'verb.aspect.choice': '体の選択', 'verb.motion': '運動の動詞',
  'num.gov': '数詞と格', 'pron.personal': '人称代名詞', 'pron.possessive': '所有代名詞', vocab: '語彙',
};

export function tagLabelJa(tag: string): string {
  if (FIXED_TAG_JA[tag]) return FIXED_TAG_JA[tag]!;
  const p = tag.split('.');
  if (p[0] === 'noun' && p.length === 3) return `名詞 ${CASE_JA[p[1]!] ?? p[1]}・${NUM_JA[p[2]!] ?? p[2]}`;
  if (p[0] === 'adj' && p.length === 3) return `形容詞 ${CASE_JA[p[1]!] ?? p[1]}・${GENDER_JA[p[2]!] ?? p[2]}`;
  if (p[0] === 'prep') return `前置詞 ${p[1]}`;
  return tag;
}
