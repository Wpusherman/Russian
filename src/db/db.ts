import Dexie, { type Table } from 'dexie';
import type { FsrsFields } from '../core/scheduler';
import type { Attempt, FeatKey, ItemType, Lemma } from '../core/types';

export const SCHEMA_VERSION = 2;

/** `key` = normalize(bare) (lowercase, ё folded) for lookups; `user` marks word-list words missing from the dictionary. */
export type LemmaRow = Lemma & { key: string; user?: boolean };
export type CardRow = FsrsFields & { id: string; type: ItemType; lemmaId: string; tags: string[]; createdAt: number };
export type T4Payload = {
  sentence_ru: string; lemma: string; lemmaId: string; feat: FeatKey; answer: string; translation_ja: string; explain_ja: string;
};
export type ItemRow = { id: string; type: 'T4'; payload: T4Payload; tags: string[]; source: 'ai' | 'user'; createdAt: number };
export type WordlistEntry = { lemmaId: string; glossJa?: string };
export type WordlistRow = { id?: number; name: string; priority: number; active: boolean; entries: WordlistEntry[] };
export type UnitStateRow = { unitId: string; unlocked: boolean; noteSeen?: boolean; noteTitle?: string; noteMd?: string };
export type TagWeight = { tag: string; w: number };
export type PlanRow = { id?: number; ts: number; raw: unknown; weights: TagWeight[]; expiresAt: number };
export type QuarantineRow = { id?: number; ts: number; payload: unknown; reason: string };
export type ExplainRow = { key: string; explain: string; ts: number };
export type BacklogStatus = 'new' | 'exported';
export type BacklogRow = { id?: number; ts: number; status: BacklogStatus; title: string; rationale: string; spec: string };
export type AiUsageRow = { ptDate: string; count: number };
export type SettingRow = { key: string; value: unknown };

export class RusloDB extends Dexie {
  lemmas!: Table<LemmaRow, string>;
  cards!: Table<CardRow, string>;
  items!: Table<ItemRow, string>;
  attempts!: Table<Attempt, number>;
  wordlists!: Table<WordlistRow, number>;
  unitState!: Table<UnitStateRow, string>;
  plans!: Table<PlanRow, number>;
  quarantine!: Table<QuarantineRow, number>;
  explainCache!: Table<ExplainRow, string>;
  backlog!: Table<BacklogRow, number>;
  aiUsage!: Table<AiUsageRow, string>;
  settings!: Table<SettingRow, string>;

  constructor(name = 'ruslo') {
    super(name);
    this.version(1).stores({
      lemmas: 'id, key, rank, pos, level, [pos+rank]',
      cards: 'id, type, lemmaId, *tags, due, state',
      items: 'id, type, *tags, source, createdAt',
      attempts: '++id, itemId, ts, type, class, *tags',
      wordlists: '++id, name, priority',
      unitState: 'unitId',
      plans: '++id, ts',
      quarantine: '++id, ts',
      explainCache: 'key',
      backlog: '++id, ts',
      aiUsage: 'ptDate',
      settings: 'key',
    });
    // v2: backlog status ('new' | 'exported') for the version-driven cleanup.
    this.version(2).stores({ backlog: '++id, ts, status' }).upgrade((tx) => tx.table('backlog').toCollection().modify((r: BacklogRow) => {
      r.status ??= 'new';
    }));
  }
}

export let db = new RusloDB();

/** Tests swap in a fresh database. */
export function setDb(next: RusloDB): void {
  db = next;
}

/** Tables included in export / import (everything except lemmas). */
export const EXPORT_TABLES = [
  'cards', 'items', 'attempts', 'wordlists', 'unitState', 'plans', 'quarantine', 'explainCache', 'backlog', 'aiUsage', 'settings',
] as const;
