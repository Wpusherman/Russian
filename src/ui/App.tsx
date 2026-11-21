import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { GeminiProvider } from '../ai/gemini';
import { ManualProvider, type ManualRequest } from '../ai/manual';
import type { AIProvider } from '../ai/provider';
import { aiCallsToday, countAiCall } from '../ai/tasks';
import { syncAppVersion } from '../db/backlog';
import { ensureDict, type DictProgress } from '../db/dict';
import { getApiKey, loadSettings } from '../db/settings';
import { AI_EVENT, AiContext, navigate, useHashRoute } from './common';
import { BacklogPage, QuarantinePage, ReportsPage } from './AiPages';
import { DictPage } from './DictPage';
import { HomePage } from './HomePage';
import { SessionPage } from './SessionPage';
import { SettingsPage } from './SettingsPage';
import { StatsPage } from './StatsPage';
import { UnitsPage } from './UnitsPage';
import { WordlistsPage } from './WordlistsPage';

const NAV: [string, string][] = [
  ['home', 'ホーム'], ['stats', '統計'], ['units', '単元'], ['wordlists', '単語リスト'], ['dict', '辞書'],
  ['reports', 'AIレポート'], ['quarantine', '検疫'], ['backlog', 'バックログ'], ['settings', '設定'],
];

const PHASE_JA: Record<DictProgress['phase'], string> = {
  check: '辞書を確認中…', download: '辞書をダウンロード中…', parse: '辞書を解析中…', import: '辞書をデータベースに登録中…', done: '完了',
};

type ManualState = { req: ManualRequest; validate: (t: string) => string | null; resolve: (t: string | null) => void };

function ManualDialog({ state }: { state: ManualState }): ReactNode {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(state.req.prompt);
    } catch {
      promptRef.current?.select();
      document.execCommand('copy');
    }
    setCopied(true);
  };
  const take = () => {
    const err = state.validate(text);
    if (err) setError(err);
    else state.resolve(text);
  };
  return (
    <div className="modal-back">
      <div className="modal">
        <h2>Manualモード（{state.req.task}）</h2>
        <p className="muted">① 「コピー」でプロンプトをコピーし、お使いのAIチャットに貼り付けます。② 返ってきたJSONを下の欄に貼り付けて「取り込み」を押します。</p>
        <textarea ref={promptRef} readOnly value={state.req.prompt} rows={7} />
        <div className="row">
          <button className="primary" onClick={() => void copy()}>コピー</button>
          {copied && <span className="ok-text">コピーしました</span>}
        </div>
        <textarea value={text} onChange={(e) => { setText(e.target.value); setError(null); }} rows={8} placeholder="AIの応答（JSON）をここに貼り付け" />
        {error && <div className="box error">{error}</div>}
        <div className="row">
          <button className="primary" disabled={!text.trim()} onClick={take}>取り込み</button>
          <button className="ghost" onClick={() => state.resolve(null)}>キャンセル</button>
        </div>
      </div>
    </div>
  );
}

export function App(): ReactNode {
  const route = useHashRoute();
  const [progress, setProgress] = useState<DictProgress>({ phase: 'check', ratio: 0 });
  const [bootError, setBootError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [manual, setManual] = useState<ManualState | null>(null);
  const [aiCount, setAiCount] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    ensureDict((p) => { if (alive) setProgress(p); }).then(
      () => { if (alive) setReady(true); },
      (e: unknown) => { if (alive) setBootError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void syncAppVersion(__APP_VERSION__).then((n) => {
      if (alive && n > 0) setToast(`更新を検出: エクスポート済みのバックログ ${n} 件を削除しました`);
    });
    return () => { alive = false; };
  }, [ready]);

  useEffect(() => {
    if (toast === null) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const refresh = () => void aiCallsToday().then(setAiCount);
    refresh();
    window.addEventListener(AI_EVENT, refresh);
    return () => window.removeEventListener(AI_EVENT, refresh);
  }, []);

  const getProvider = useCallback(async (forceManual = false): Promise<AIProvider> => {
    const s = await loadSettings();
    if (forceManual || s.aiProvider === 'manual') {
      return new ManualProvider((req, validate) => new Promise<string | null>((resolve) => {
        setManual({ req, validate, resolve: (t) => { setManual(null); resolve(t); } });
      }));
    }
    return new GeminiProvider({
      apiKey: getApiKey(), models: s.models, useProxy: s.useProxy,
      onCall: async () => { await countAiCall(); window.dispatchEvent(new Event(AI_EVENT)); },
    });
  }, []);
  const aiValue = useMemo(() => ({ getProvider }), [getProvider]);

  if (bootError) {
    return (
      <div className="boot">
        <h1>Ruslo</h1>
        <div className="box error">{bootError}</div>
        <p className="muted">手順：<code>data/raw/</code> にCSVを置く → <code>npm run build:dict</code> → ページを再読み込み</p>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="boot">
        <h1>Ruslo</h1>
        <p>{PHASE_JA[progress.phase]}</p>
        <div className="progress"><div style={{ width: `${Math.round(progress.ratio * 100)}%` }} /></div>
        <p className="muted">初回のみ、辞書（約5.6万語）の登録に少し時間がかかります。</p>
      </div>
    );
  }

  const [rawPage, arg] = route.split('/');
  const page = rawPage.split('?')[0]!;
  let body: ReactNode;
  switch (page) {
    case 'session': body = <SessionPage />; break;
    case 'stats': body = <StatsPage />; break;
    case 'units': body = <UnitsPage unitId={arg} />; break;
    case 'wordlists': body = <WordlistsPage />; break;
    case 'dict': body = <DictPage />; break;
    case 'reports': body = <ReportsPage />; break;
    case 'quarantine': body = <QuarantinePage />; break;
    case 'backlog': body = <BacklogPage />; break;
    case 'settings': body = <SettingsPage />; break;
    default: body = <HomePage />;
  }
  return (
    <AiContext.Provider value={aiValue}>
      <header className="top">
        <a className="brand" href="#/home" onClick={() => navigate('home')}>Ruslo</a>
        <nav>
          {NAV.map(([id, label]) => (
            <a key={id} href={`#/${id}`} className={page === id || (id === 'home' && !NAV.some(([n]) => n === page) && page !== 'session') ? 'active' : ''}>{label}</a>
          ))}
        </nav>
        <span className="ai-count" title="Gemini APIの呼び出し回数（太平洋時間の日付ごと）">本日のAI呼び出し回数：{aiCount}</span>
      </header>
      <main>{body}</main>
      {manual && <ManualDialog key={manual.req.prompt} state={manual} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </AiContext.Provider>
  );
}
