import { useEffect, useRef, useState, type ReactNode } from 'react';
import { bestReadingMatch, type ReadingMatch } from '../core/reading';
import { buildTranslationSources } from '../core/translation';
import { db } from '../db/db';
import { loadSettings } from '../db/settings';
import { pct, useAsync } from './common';
import { createRussianRecognition, speechRecognitionAvailable, transcriptsOf, type SpeechRecognitionLike } from './speechRecognition';
import { speak } from './speech';

const ERROR_JA: Record<string, string> = {
  'not-allowed': 'マイクの使用が許可されていません。ブラウザの設定で許可してください。',
  'service-not-allowed': '音声認識サービスが許可されていません。',
  'no-speech': '音声が聞き取れませんでした。もう一度、はっきり読み上げてください。',
  network: '音声認識サーバーに接続できませんでした。',
  'audio-capture': 'マイクが見つかりません。',
  aborted: '',
};

export function ReadingPage(): ReactNode {
  const { data, error } = useAsync(async () => {
    const [items, settings] = await Promise.all([db.items.toArray(), loadSettings()]);
    return { sources: buildTranslationSources(items, 5), settings };
  }, []);
  const [listeningId, setListeningId] = useState<string | null>(null);
  const [heard, setHeard] = useState<Record<string, string[]>>({});
  const [matches, setMatches] = useState<Record<string, ReadingMatch>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const rec = useRef<SpeechRecognitionLike | null>(null);
  const supported = speechRecognitionAvailable();

  useEffect(() => () => { rec.current?.abort(); }, []);

  const stop = () => {
    rec.current?.stop();
    rec.current = null;
    setListeningId(null);
  };

  const start = (itemId: string, ru: string) => {
    rec.current?.abort();
    const r = createRussianRecognition();
    if (!r) return;
    setNotice(null);
    setListeningId(itemId);
    r.onresult = (e) => {
      const alts = transcriptsOf(e);
      setHeard((h) => ({ ...h, [itemId]: alts }));
      if (alts.length > 0) setMatches((m) => ({ ...m, [itemId]: bestReadingMatch(ru, alts) }));
    };
    r.onerror = (e) => {
      const msg = ERROR_JA[e.error];
      if (msg) setNotice(msg);
      else setNotice(`音声認識エラー：${e.error}`);
    };
    r.onend = () => {
      rec.current = null;
      setListeningId((cur) => (cur === itemId ? null : cur));
    };
    rec.current = r;
    try {
      r.start();
    } catch {
      rec.current = null;
      setListeningId(null);
      setNotice('音声認識を開始できませんでした。ページを再読み込みしてください。');
    }
  };

  if (error) return <div className="box error">{error}</div>;
  if (!data) return <p className="muted">読み込み中…</p>;
  const { sources, settings } = data;

  return (
    <div>
      <h1>音読（T8）</h1>
      <p className="muted">
        例文を音読し、ブラウザの音声認識（ロシア語）で聞き取れた語を照合します。語順も含めて単語単位で判定し、80%以上で合格の目安です。
      </p>
      {!supported && (
        <div className="box warn">
          このブラウザは音声認識に対応していません。Chrome または Edge（デスクトップ）で開いてください。マイクの使用許可が必要です。
        </div>
      )}
      {sources.length === 0 ? (
        <div className="box">
          出題できる例文がありません。ホームの「弱点の分析（AI）」で穴埋め文を作るか、単語リストに <code>+対</code> などの注記付きの語を登録してください。
        </div>
      ) : (
        <>
          {notice && <div className="box warn">{notice}</div>}
          {sources.map((s, i) => {
            const m = matches[s.itemId];
            const alts = heard[s.itemId] ?? [];
            const listening = listeningId === s.itemId;
            return (
              <section className="card" key={s.itemId}>
                <div className="row between">
                  <h2>{i + 1}.</h2>
                  <button className="ghost small" onClick={() => speak(s.ru, settings.voiceURI, settings.speechRate)}>🔊 お手本</button>
                </div>
                <div className="ru reading-text">
                  {m
                    ? m.expectedWords.map((w, k) => (
                      <span key={`${w}-${k}`} className={m.matched[k] ? 'word-ok' : 'word-ng'}>{w}{k < m.expectedWords.length - 1 ? ' ' : ''}</span>
                    ))
                    : s.ru}
                </div>
                <div className="muted">{s.ja}</div>
                <div className="row">
                  <button className="primary" disabled={!supported || (listeningId !== null && !listening)} onClick={() => (listening ? stop() : start(s.itemId, s.ru))}>
                    {listening ? '停止' : '音読する'}
                  </button>
                  {listening && <span className="muted">聞き取り中…</span>}
                  {m && (
                    <span className={m.rate >= 0.8 ? 'ok-text' : 'error-text'}>
                      一致率 {pct(m.rate)}（{m.hits} / {m.expectedWords.length} 語）
                    </span>
                  )}
                </div>
                {alts.length > 0 && (
                  <div className="small-text">
                    <span className="muted">認識結果：</span>
                    <span className="ru">{alts.join(' / ')}</span>
                  </div>
                )}
                {m && <div className="muted small-text">下線：緑＝一致、赤破線＝不一致（余分に認識された語は減点しません）</div>}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
