/** Minimal typing for the Web Speech API (not in the standard DOM lib). */
export type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function ctor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechRecognitionAvailable(): boolean {
  return ctor() !== null;
}

/** All transcripts of one recognition event (results[0] and its alternatives). */
export function transcriptsOf(event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }): string[] {
  const out: string[] = [];
  for (let i = 0; i < event.results.length; i++) {
    const result = event.results[i];
    if (!result) continue;
    for (let j = 0; j < result.length; j++) {
      const t = result[j]?.transcript.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/** A one-shot Russian recogniser (T8), or null when the browser has no support. */
export function createRussianRecognition(): SpeechRecognitionLike | null {
  const Ctor = ctor();
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = 'ru-RU';
  rec.interimResults = false;
  rec.maxAlternatives = 3;
  rec.continuous = false;
  return rec;
}
