import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cachedExplain, runExplain } from '../ai/tasks';
import { CLASS_JA, isCorrectClass, ratingFor, reflexiveWarning } from '../core/classify';
import { grade, hintText, isUncertainGloss, targetLabel, type Answer, type Graded, type Question } from '../core/grade';
import { isVowel, normalize } from '../core/normalize';
import { aspectBadge, confusionLabelJa, featLabelJa } from '../core/tags';
import type { AnswerClass, RatingNum } from '../core/types';
import type { Settings } from '../db/settings';
import { buildSession, loadContext, recordAttempt } from '../db/study';
import { AiErrorBox, navigate, pct, useAiTask, useAsync } from './common';
import { RuInput } from './RuInput';
import { speak, useRuVoices } from './speech';

const RATING_JA: Record<RatingNum, string> = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };
const TYPE_JA: Record<Question['type'], string> = {
  T1: '意味認識', T2: '綴り想起', T3: '語形ドリル', T4: '穴埋め', T5: 'アクセント', T6: 'ディクテーション', T10: '体の選択', T11: '数詞',
};

type Done = { question: Question; graded: Graded; rating: RatingNum };
type Result = { graded: Graded; latencyMs: number; hintCount: number; rating: RatingNum };

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
}

/** What gets read aloud for a question (after answering, or before for dictation). */
function speechText(q: Question): string {
  switch (q.type) {
    case 'T6': return q.sentence;
    case 'T4': return q.sentence.replace('___', q.expected.primary);
    case 'T10': return q.sentence.replace('___', q.expected.primary);
    case 'T3': return q.expected.primary;
    case 'T11': return q.expected.primary;
    default: return q.lemma.accented;
  }
}

function aspectMistake(q: Question, given: string): string | null {
  if (q.type !== 'T2' && q.type !== 'T3' && q.type !== 'T4') return null;
  const n = normalize(given);
  const partner = (q.partners ?? []).find((p) => {
    if (normalize(p.bare) === n) return true;
    if (q.type === 'T2') return false;
    const f = p.forms[q.feat];
    return !!f && [f.primary, ...f.variants].some((v) => normalize(v) === n);
  });
  if (!partner) return null;
  return `体の取り違え: 正解は${aspectBadge(q.lemma)}${q.lemma.bare}（あなたの解答は${aspectBadge(partner)}${partner.bare}）`;
}

function Prompt({ q, onSpeak, canSpeak }: { q: Question; onSpeak: () => void; canSpeak: boolean }): ReactNode {
  const speakBtn = canSpeak && <button className="ghost small" tabIndex={-1} onClick={onSpeak} title="P">🔊 <kbd>P</kbd></button>;
  switch (q.type) {
    case 'T1':
      return <div className="prompt"><div className="ru big-word">{q.lemma.accented}{q.hint && <span className="muted"> {q.hint}</span>}</div>{speakBtn}<p className="muted">意味を選んでください（1〜4）</p></div>;
    case 'T2':
      return <div className="prompt"><div className={isUncertainGloss(q.gloss) ? 'big-word uncertain-gloss' : 'big-word'}>{q.gloss}{aspectBadge(q.lemma)}</div>{q.note && <div className="muted">{q.note}</div>}{q.hint && <div className="muted">{q.hint}</div>}{canSpeak && <button className="ghost small" tabIndex={-1} onClick={onSpeak}>🔊 <kbd>Ctrl+P</kbd></button>}<p className="muted">ロシア語で書いてください</p></div>;
    case 'T3':
      return (
        <div className="prompt">
          <div className="ru big-word">{q.lemma.accented}</div>
          <div className={isUncertainGloss(q.gloss) ? 'muted uncertain-gloss' : 'muted'}>{q.gloss}{aspectBadge(q.lemma)}</div>
          <div className="target">→ {targetLabel(q)}</div>
        </div>
      );
    case 'T4':
      return (
        <div className="prompt">
          <div className="ru sentence">{q.sentence}</div>
          <div className="muted">（{q.lemma.bare}{aspectBadge(q.lemma)}）</div>
          <div>{q.translation}</div>
          <div className="target">→ 空欄に入る形を書いてください</div>
        </div>
      );
    case 'T5':
      return <div className="prompt"><div className="muted">{q.gloss}</div><p className="muted">アクセントのある母音をクリック（または数字キー）</p></div>;
    case 'T10':
      return (
        <div className="prompt">
          <div className="ru sentence">{q.sentence}</div>
          <div className="muted">（{q.impf} / {q.pf}）</div>
          <div>{q.translation}</div>
          <div className="target">→ 正しい体の形を書いてください</div>
        </div>
      );
    case 'T11':
      return (
        <div className="prompt">
          <div className="ru big-word">{q.num} ___</div>
          <div className="muted">（{q.lemma.bare}{aspectBadge(q.lemma)}）</div>
          <div className="target">→ 数に合う名詞の形（1・2 は数詞も含めて）</div>
        </div>
      );
    case 'T6':
      return (
        <div className="prompt">
          <button className="primary" onClick={onSpeak}>🔊 もう一度聞く <kbd>Ctrl+P</kbd></button>
          <p className="muted">聞こえた文を全部書いてください</p>
        </div>
      );
  }
}

function QuestionView(props: {
  q: Question; settings: Settings; canSpeak: boolean; result: Result | null;
  onAnswer: (a: Answer, hintCount: number) => void; onSpeak: () => void;
}): ReactNode {
  const { q, settings, result, onAnswer } = props;
  const [text, setText] = useState('');
  const [hints, setHints] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const answered = result !== null;
  const hintable = q.type === 'T2' || q.type === 'T3';

  const vowels = useMemo(() => (q.type === 'T5' ? [...q.word].map((ch, i) => ({ ch, i })).filter((x) => isVowel(x.ch)) : []), [q]);

  useEffect(() => {
    if (answered) return;
    const on = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (q.type === 'T1' && /^[1-4]$/.test(e.key) && Number(e.key) <= q.options.length) {
        e.preventDefault();
        onAnswer({ kind: 'choice', index: Number(e.key) - 1 }, 0);
      } else if (q.type === 'T5' && /^[1-9]$/.test(e.key) && vowels[Number(e.key) - 1]) {
        e.preventDefault();
        onAnswer({ kind: 'stress', index: vowels[Number(e.key) - 1]!.i }, 0);
      } else if (hintable && !isTyping(e) && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        setHints((h) => h + 1);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [q, answered, onAnswer, vowels, hintable]);

  let input: ReactNode = null;
  if (q.type === 'T1') {
    input = (
      <div className="options">
        {q.options.map((o, i) => {
          const cls = !answered ? '' : i === q.correct ? 'right' : o === result.graded.given ? 'wrong' : '';
          return (
            <button key={i} className={`option ${cls}${isUncertainGloss(o) ? ' uncertain-gloss' : ''}`} disabled={answered} onClick={() => onAnswer({ kind: 'choice', index: i }, 0)}>
              <kbd>{i + 1}</kbd> {o}
            </button>
          );
        })}
      </div>
    );
  } else if (q.type === 'T5') {
    let n = 0;
    input = (
      <div className="stress-word ru">
        {[...q.word].map((ch, i) => {
          if (!isVowel(ch)) return <span key={i}>{ch}</span>;
          const num = ++n;
          const cls = !answered ? '' : q.stressed.includes(i) ? 'right' : 'dim';
          return (
            <button key={i} className={`vowel ${cls}`} disabled={answered} onClick={() => onAnswer({ kind: 'stress', index: i }, 0)}>
              {ch}<sub>{num}</sub>
            </button>
          );
        })}
      </div>
    );
  } else {
    const expected = q.type === 'T6' ? null : q.expected;
    const submitText = (final: string) => {
      if (q.type !== 'T6' && 'lemma' in q && reflexiveWarning(q.lemma, final, settings.liveWarnings)) {
        setPending(final);
        return;
      }
      onAnswer({ kind: 'text', text: final }, hints);
    };
    input = (
      <div>
        <RuInput key={q.itemId} value={text} onChange={setText} autoFocus disabled={answered || pending !== null}
          defaultMode={settings.inputMode} showKeyboardDefault={settings.showKeyboard}
          onEnter={submitText} />
        {pending !== null && (
          <div className="box warn">
            <p>-ся / -сь が抜けています（母音の後は -сь）。このまま送信しますか？</p>
            <div className="row">
              <button className="primary" onClick={() => { const t = pending; setPending(null); onAnswer({ kind: 'text', text: t }, hints + 1); }}>
                このまま送信
              </button>
              <button className="ghost" onClick={() => setPending(null)}>戻る</button>
            </div>
          </div>
        )}
        {hintable && expected && !answered && (
          <div className="row">
            <button className="ghost small" tabIndex={-1} onClick={() => setHints((h) => h + 1)}>ヒント（1文字ずつ） <kbd>Alt+H</kbd></button>
            {hints > 0 && <span className="hint ru">{hintText(expected, hints)}…</span>}
            {hints > 0 && <span className="muted">ヒント使用：評価の上限はHard</span>}
          </div>
        )}
      </div>
    );
  }
  // Alt+H works while typing (plain H would be typed into the field).
  useEffect(() => {
    if (answered || !hintable) return;
    const on = (e: KeyboardEvent) => {
      if (e.altKey && e.code === 'KeyH') {
        e.preventDefault();
        setHints((h) => h + 1);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [answered, hintable]);

  return (
    <div>
      <Prompt q={q} onSpeak={props.onSpeak} canSpeak={props.canSpeak && (answered || q.type === 'T1' || q.type === 'T2')} />
      {input}
    </div>
  );
}

function AltCard({ q }: { q: Question }): ReactNode {
  if (q.type !== 'T3' || !q.lemma.alt) return null;
  const alt = q.lemma.alt;
  const mark = (text: string) => {
    const i = text.indexOf(alt.to);
    return i < 0 ? text : <>{text.slice(0, i)}<b>{alt.to}</b>{text.slice(i + alt.to.length)}</>;
  };
  const keys = ['pres.1sg', 'pres.2sg', 'pres.3sg', 'pres.1pl', 'pres.2pl', 'pres.3pl'];
  return (
    <div className="card alt-card">
      <h3>子音交替</h3>
      <p className="ru big">{q.lemma.bare} → {q.lemma.forms['pres.1sg']?.primary ?? ''}</p>
      <p className="muted">{alt.from} が {alt.to} に変わります（{alt.scope === 'all' ? '全人称' : '1人称単数のみ'}）。</p>
      <table className="forms">
        <tbody>
          {keys.map((k) => q.lemma.forms[k] ? (
            <tr key={k}><th>{featLabelJa(k)}</th><td className="ru">{mark(q.lemma.forms[k]!.primary)}</td></tr>
          ) : null)}
        </tbody>
      </table>
    </div>
  );
}

function ResultView(props: {
  q: Question; result: Result; onRate: (r: RatingNum) => void; onNext: () => void; canSpeak: boolean; onSpeak: () => void;
}): ReactNode {
  const { q, result } = props;
  const g = result.graded;
  const ok = isCorrectClass(g.class);
  const explain = useAiTask();
  const [why, setWhy] = useState<string | null>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    nextRef.current?.focus();
    if (!ok) void cachedExplain(q.itemId, g.given).then((c) => { if (c !== null) setWhy(c); });
  }, [q, g, ok]);

  const askWhy = () => void explain.run(async (p) => setWhy(await runExplain(p, q, g)));
  return (
    <div className={ok ? 'result ok' : 'result ng'}>
      <div className="result-head">
        <span className="badge">{ok ? '○' : '×'} {CLASS_JA[g.class]}</span>
        {g.confusion && <span className="confusion">{confusionLabelJa(g.confusion.expected, g.confusion.given)}</span>}
      </div>
      <div className="answer">
        正解：<span className={`ru big${q.type === 'T1' && isUncertainGloss(g.expected) ? ' uncertain-gloss' : ''}`}>{g.expected}</span>
        {'hint' in q && q.hint && <span className="muted">（{q.hint}）</span>}
        {props.canSpeak && <button className="ghost small" tabIndex={-1} onClick={props.onSpeak}>🔊 <kbd>P</kbd></button>}
      </div>
      {!ok && q.type !== 'T1' && <div>あなたの解答：<span className="ru">{g.given || '（空欄）'}</span></div>}
      {g.class === 'wrong_aspect' && <div className="confusion">{aspectMistake(q, g.given)}</div>}
      {g.class === 'reflexive_drop' && <div className="confusion">-ся / -сь が抜けています（母音の後は -сь）</div>}
      {(q.type === 'T2' || q.type === 'T3' || q.type === 'T4') && (q.partners?.length ?? 0) > 0 && (
        <div className="muted">ペア：{q.partners!.map((p) => `${p.bare}${aspectBadge(p)}`).join(' ↔ ')}</div>
      )}
      {q.type === 'T6' && <div className="muted">{q.translation}</div>}
      {q.type === 'T4' && <div className="muted">{q.explain}</div>}
      {q.type === 'T10' && <div className="muted">手がかり：{q.cue}</div>}
      {q.type === 'T3' && q.lemma.alt && (!ok || q.first) && <AltCard q={q} />}
      {!ok && (
        <div className="why">
          {why === null
            ? <button disabled={explain.busy} onClick={askWhy}>{explain.busy ? '問い合わせ中…' : 'なぜ？（AIの解説）'} <kbd>W</kbd></button>
            : <div className="box">{why}</div>}
          <AiErrorBox task={explain} />
        </div>
      )}
      <div className="rating">
        {([1, 2, 3, 4] as RatingNum[]).map((r) => (
          <button key={r} tabIndex={-1} className={result.rating === r ? 'rate on' : 'rate'} onClick={() => props.onRate(r)}>
            <kbd>{r}</kbd> {RATING_JA[r]}
          </button>
        ))}
        <button ref={nextRef} className="primary" onClick={props.onNext}>次へ <kbd>Enter</kbd></button>
      </div>
      <WhyKey enabled={!ok && why === null && !explain.busy} onWhy={askWhy} />
    </div>
  );
}

function WhyKey({ enabled, onWhy }: { enabled: boolean; onWhy: () => void }): null {
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent) => {
      if (!isTyping(e) && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'w') onWhy();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [enabled, onWhy]);
  return null;
}

function Summary({ done }: { done: Done[] }): ReactNode {
  const total = done.length;
  const correct = done.filter((d) => isCorrectClass(d.graded.class)).length;
  const byClass = new Map<AnswerClass, number>();
  for (const d of done) byClass.set(d.graded.class, (byClass.get(d.graded.class) ?? 0) + 1);
  const missed = done.filter((d) => !isCorrectClass(d.graded.class));
  const again = useRef<HTMLButtonElement>(null);
  useEffect(() => again.current?.focus(), []);
  return (
    <div>
      <h1>セッション終了</h1>
      <div className="card">
        <div className="big-numbers">
          <div><b>{total > 0 ? pct(correct / total) : '—'}</b><span>正答率</span></div>
          <div><b>{correct} / {total}</b><span>正解数</span></div>
        </div>
        <h2>分類の内訳</h2>
        <ul className="plain">
          {[...byClass.entries()].map(([c, n]) => <li key={c}>{CLASS_JA[c]}：{n}</li>)}
        </ul>
      </div>
      <div className="card">
        <h2>間違えた語</h2>
        {missed.length === 0 ? <p className="ok-text">全問正解です。</p> : (
          <table className="table">
            <thead><tr><th>種類</th><th>正解</th><th>あなたの解答</th><th>分類</th></tr></thead>
            <tbody>
              {missed.map((d, i) => (
                <tr key={i}>
                  <td>{TYPE_JA[d.question.type]}</td>
                  <td className="ru">{d.question.type === 'T1' ? `${d.question.lemma.accented} = ${d.graded.expected}` : d.graded.expected}</td>
                  <td className="ru">{d.graded.given || '—'}</td>
                  <td>{CLASS_JA[d.graded.class]}{d.graded.confusion && `（${confusionLabelJa(d.graded.confusion.expected, d.graded.confusion.given)}）`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="row">
        <button ref={again} className="primary" onClick={() => window.location.reload()}>もう1セッション</button>
        <button onClick={() => navigate('home')}>ホームへ</button>
        <button onClick={() => navigate('stats')}>統計を見る</button>
      </div>
    </div>
  );
}

export function SessionPage(): ReactNode {
  const voices = useRuVoices();
  const canSpeak = voices.length > 0;
  const voicesRef = useRef(canSpeak);
  voicesRef.current = canSpeak;
  const { data, error } = useAsync(async () => {
    // Give the browser a moment to load its voice list so dictation is only planned when audio exists.
    if (!voicesRef.current) await new Promise((r) => setTimeout(r, 300));
    const ctx = await loadContext();
    const questions = await buildSession(ctx, { ttsAvailable: voicesRef.current });
    return { settings: ctx.settings, questions };
  }, []);
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [done, setDone] = useState<Done[]>([]);
  const shownAt = useRef(Date.now());
  const saving = useRef(false);

  const q = data?.questions[index];
  const settings = data?.settings;

  const say = useCallback(() => {
    if (q && settings && voicesRef.current) speak(speechText(q), settings.voiceURI, settings.speechRate);
  }, [q, settings]);

  useEffect(() => {
    shownAt.current = Date.now();
    if (q?.type === 'T6') say(); // dictation starts by reading the sentence
  }, [q, say]);

  const onAnswer = useCallback((a: Answer, hintCount: number) => {
    if (!q || !settings || result) return;
    const latencyMs = Date.now() - shownAt.current;
    const graded = grade(q, a, { yoLenient: settings.yoLenient });
    const rating = ratingFor({ class: graded.class, type: q.type, hintUsed: hintCount > 0, latencyMs });
    setResult({ graded, latencyMs, hintCount, rating });
  }, [q, settings, result]);

  const next = useCallback(async () => {
    if (!q || !result || saving.current) return;
    saving.current = true;
    try {
      await recordAttempt({ question: q, graded: result.graded, rating: result.rating, latencyMs: result.latencyMs, hintCount: result.hintCount });
      setDone((d) => [...d, { question: q, graded: result.graded, rating: result.rating }]);
      setResult(null);
      setIndex((i) => i + 1);
    } finally {
      saving.current = false;
    }
  }, [q, result]);

  // Result screen keys: 1-4 override the rating, Enter confirms. P plays audio.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'p' && (e.ctrlKey || !isTyping(e)) && !e.altKey) {
        if (result || q?.type === 'T1' || q?.type === 'T2' || q?.type === 'T6') {
          e.preventDefault();
          say();
        }
        return;
      }
      if (!result || e.ctrlKey || e.altKey || e.metaKey) return;
      if (/^[1-4]$/.test(e.key)) {
        e.preventDefault();
        setResult({ ...result, rating: Number(e.key) as RatingNum });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        void next();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [result, next, say, q]);

  if (error) return <div className="box error">{error}</div>;
  if (!data || !settings) return <p className="muted">セッションを準備中…</p>;
  const total = data.questions.length;
  if (total === 0) {
    return (
      <div>
        <h1>セッション</h1>
        <div className="box">出題できる問題がありません（今日の新規上限に達し、復習もありません）。設定で新規上限を増やすか、明日また来てください。</div>
        <button onClick={() => navigate('home')}>ホームへ</button>
      </div>
    );
  }
  if (!q) return <Summary done={done} />;
  return (
    <div className="session">
      <div className="session-top">
        <div className="progress"><div style={{ width: `${(index / total) * 100}%` }} /></div>
        <span>{index + 1} / {total}</span>
        <span className="tag">{TYPE_JA[q.type]}</span>
        <button className="ghost small" tabIndex={-1} onClick={() => navigate('home')}>中断</button>
      </div>
      <div className="card question">
        <QuestionView key={q.itemId} q={q} settings={settings} canSpeak={canSpeak} result={result} onAnswer={onAnswer} onSpeak={say} />
        {result && (
          <ResultView q={q} result={result} canSpeak={canSpeak} onSpeak={say}
            onRate={(r) => setResult({ ...result, rating: r })} onNext={() => void next()} />
        )}
      </div>
      <p className="muted keys">キー操作：Enter 送信／次へ ・ 1〜4 選択／評価 ・ H（入力中は Alt+H）ヒント ・ P 音声 ・ W なぜ？ ・ Alt+T 入力切替</p>
    </div>
  );
}
