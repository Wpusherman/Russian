export type Pos = 'noun' | 'verb' | 'adj' | 'other';
/**
 * noun: "case.<case>.<sg|pl>" (+ pseudo feat "gender"), verb: "pres.1sg".."pres.3pl",
 * "past.m|f|n|pl", "imp.sg|pl", adj: "adj.<case>.<m|f|n|pl>"
 */
export type FeatKey = string;
export type Form = { primary: string; variants: string[] };

export type Lemma = {
  id: string;
  bare: string;
  accented: string;
  pos: Pos;
  rank: number | null;
  level: string | null;
  gender?: 'm' | 'f' | 'n' | 'pl';
  animate?: boolean;
  aspect?: 'impf' | 'pf';
  partnerIds?: string[];
  glossEn: string[];
  glossJa?: string;
  /** User annotation from word lists (e.g. "+対"): display only, never part of an answer. */
  hint?: string;
  forms: Record<FeatKey, Form>;
};

export type ItemType = 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6';
export type AnswerClass = 'correct' | 'orthographic' | 'wrong_form' | 'spelling_rule' | 'typo' | 'wrong';
export type Confusion = { expected: FeatKey; given: FeatKey };
/** FSRS rating: 1 Again, 2 Hard, 3 Good, 4 Easy */
export type RatingNum = 1 | 2 | 3 | 4;

export type Attempt = {
  id?: number;
  itemId: string;
  ts: number;
  type: ItemType;
  given: string;
  class: AnswerClass;
  confusion?: Confusion;
  rating: RatingNum;
  latencyMs: number;
  hintCount: number;
  tags: string[];
  /** Display data for samples / post-session list. */
  prompt?: string;
  expected?: string;
};

export const CASES = ['nom', 'gen', 'dat', 'acc', 'ins', 'prep'] as const;
export const NUMBERS = ['sg', 'pl'] as const;
export const ADJ_GENDERS = ['m', 'f', 'n', 'pl'] as const;
export const PRES_KEYS = ['pres.1sg', 'pres.2sg', 'pres.3sg', 'pres.1pl', 'pres.2pl', 'pres.3pl'] as const;
export const PAST_KEYS = ['past.m', 'past.f', 'past.n', 'past.pl'] as const;
export const IMP_KEYS = ['imp.sg', 'imp.pl'] as const;
export const GENDER_FEAT = 'gender';
