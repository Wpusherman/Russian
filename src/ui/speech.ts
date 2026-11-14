import { useEffect, useState } from 'react';

function supported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** Russian voices, "Natural" ones first. */
export function ruVoices(): SpeechSynthesisVoice[] {
  if (!supported()) return [];
  const v = window.speechSynthesis.getVoices().filter((x) => x.lang.toLowerCase().replace('_', '-').startsWith('ru'));
  return v.sort((a, b) => Number(b.name.includes('Natural')) - Number(a.name.includes('Natural')));
}

export function pickVoice(voiceURI: string): SpeechSynthesisVoice | null {
  const voices = ruVoices();
  return voices.find((v) => v.voiceURI === voiceURI) ?? voices[0] ?? null;
}

/** Re-renders when the browser finishes loading its voice list. */
export function useRuVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(ruVoices);
  useEffect(() => {
    if (!supported()) return;
    const on = () => setVoices(ruVoices());
    on();
    window.speechSynthesis.addEventListener('voiceschanged', on);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', on);
  }, []);
  return voices;
}

export function speak(text: string, voiceURI: string, rate: number): void {
  const voice = pickVoice(voiceURI);
  if (!voice) return;
  window.speechSynthesis.cancel();
  // Stress marks confuse some voices; send plain text.
  const u = new SpeechSynthesisUtterance(text.replace(/\u0301/g, ''));
  u.voice = voice;
  u.lang = 'ru-RU';
  u.rate = rate;
  window.speechSynthesis.speak(u);
}
