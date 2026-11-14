import { createContext, useCallback, useContext, useEffect, useRef, useState, type DependencyList, type ReactNode } from 'react';
import { AIError, type AIProvider } from '../ai/provider';
import { setSetting } from '../db/settings';

// ---------- hash router ----------

export function useHashRoute(): string {
  const read = () => window.location.hash.replace(/^#\/?/, '') || 'home';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function navigate(route: string): void {
  window.location.hash = `#/${route}`;
}

// ---------- async data ----------

export type AsyncState<T> = { data: T | undefined; error: string | null; loading: boolean; reload: () => void };

export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn().then(
      (d) => { if (alive) { setData(d); setError(null); setLoading(false); } },
      (e: unknown) => { if (alive) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

// ---------- AI context ----------

export type AiContextValue = { getProvider: (forceManual?: boolean) => Promise<AIProvider> };
export const AiContext = createContext<AiContextValue | null>(null);

export const AI_EVENT = 'ruslo:ai-call';

export type AiTaskState = {
  busy: boolean;
  error: string | null;
  /** True when the failure was a network / CORS error and the dev proxy is a possible fix. */
  network: boolean;
  run: (fn: (p: AIProvider) => Promise<void>, manual?: boolean) => Promise<void>;
  /** Re-run the last task through the manual (copy & paste) screen. */
  retryManual: () => void;
  /** Turn on the dev-server proxy (useProxy) and re-run the last task. */
  retryProxy: () => void;
  clear: () => void;
};

export function useAiTask(): AiTaskState {
  const ai = useContext(AiContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [network, setNetwork] = useState(false);
  const last = useRef<((p: AIProvider) => Promise<void>) | null>(null);
  const run = useCallback(async (fn: (p: AIProvider) => Promise<void>, manual = false) => {
    if (!ai) return;
    last.current = fn;
    setBusy(true);
    setError(null);
    setNetwork(false);
    try {
      await fn(await ai.getProvider(manual));
    } catch (e) {
      if (e instanceof AIError && e.kind === 'cancelled') return;
      setNetwork(e instanceof AIError && e.kind === 'network');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [ai]);
  const retryManual = useCallback(() => { if (last.current) void run(last.current, true); }, [run]);
  const retryProxy = useCallback(() => {
    const fn = last.current;
    if (fn) void setSetting('useProxy', true).then(() => run(fn));
  }, [run]);
  return { busy, error, network, run, retryManual, retryProxy, clear: () => setError(null) };
}

export function AiErrorBox({ task }: { task: AiTaskState }): ReactNode {
  if (!task.error) return null;
  return (
    <div className="box error">
      <div>AIの呼び出しに失敗しました：{task.error}</div>
      <div className="row">
        {task.network && import.meta.env.DEV && <button className="primary" onClick={task.retryProxy}>プロキシを有効にして再試行</button>}
        <button onClick={task.retryManual}>Manualモードで開く（コピー＆貼り付け）</button>
        <button className="ghost" onClick={task.clear}>閉じる</button>
      </div>
    </div>
  );
}

// ---------- small helpers ----------

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Colour for a Wilson lower bound (red -> yellow -> green). */
export function lbColor(lb: number): string {
  const hue = Math.round(Math.max(0, Math.min(1, lb)) * 125);
  return `hsl(${hue} 60% 42%)`;
}

export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fmtDate(ts: number): string {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
