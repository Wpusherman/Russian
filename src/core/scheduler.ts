import { createEmptyCard, fsrs, generatorParameters, type Card, type Grade } from 'ts-fsrs';
import type { RatingNum } from './types';

/** FSRS state persisted on a card row (dates as epoch ms). */
export type FsrsFields = {
  due: number;
  stability: number;
  difficulty: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  /** 0 New, 1 Learning, 2 Review, 3 Relearning */
  state: number;
  last_review?: number;
};

export const STATE_NEW = 0;
export const STATE_REVIEW = 2;

const engine = fsrs(generatorParameters({ request_retention: 0.9, enable_fuzz: true }));

function toCard(f: FsrsFields): Card {
  return {
    due: new Date(f.due),
    stability: f.stability,
    difficulty: f.difficulty,
    scheduled_days: f.scheduled_days,
    learning_steps: f.learning_steps,
    reps: f.reps,
    lapses: f.lapses,
    state: f.state,
    last_review: f.last_review === undefined ? undefined : new Date(f.last_review),
    // ts-fsrs keeps this deprecated field on its Card type in some versions.
    ...({ elapsed_days: 0 } as object),
  } as Card;
}

function fromCard(c: Card): FsrsFields {
  return {
    due: c.due.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps ?? 0,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as number,
    last_review: c.last_review ? new Date(c.last_review).getTime() : undefined,
  };
}

export function newFsrs(now: number): FsrsFields {
  return fromCard(createEmptyCard(new Date(now)));
}

export function review(f: FsrsFields, rating: RatingNum, now: number): FsrsFields {
  return fromCard(engine.next(toCard(f), new Date(now), rating as unknown as Grade).card);
}

/** Probability of recall right now (0..1). New cards return 0. */
export function retrievability(f: FsrsFields, now: number): number {
  if (f.state === STATE_NEW || f.last_review === undefined || f.stability <= 0) return 0;
  const r = Number(engine.retrievability(toCard(f), new Date(Math.max(now, f.last_review))));
  return Number.isFinite(r) ? r : 0;
}
