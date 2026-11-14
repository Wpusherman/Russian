import type { ReactNode } from 'react';
import { analysisDue, runAnalyze, runGloss, type AnalysisImport } from '../ai/tasks';
import { WEAK_MIN_N } from '../core/session';
import { tagLabelJa } from '../core/tags';
import { glossCandidates, loadContext } from '../db/study';
import { AiErrorBox, lbColor, navigate, pct, useAiTask, useAsync } from './common';
import { useState } from 'react';

export function HomePage(): ReactNode {
  const { data, error, reload } = useAsync(async () => {
    const ctx = await loadContext();
    const gloss = await glossCandidates(ctx.cards);
    return { ctx, glossCount: gloss.length };
  }, []);
  const analyze = useAiTask();
  const gloss = useAiTask();
  const [analysis, setAnalysis] = useState<AnalysisImport | null>(null);
  const [glossDone, setGlossDone] = useState<number | null>(null);

  if (error) return <div className="box error">{error}</div>;
  if (!data) return <p className="muted">読み込み中…</p>;
  const { ctx, glossCount } = data;
  const due = analysisDue(ctx);
  const weak = [...ctx.stats.values()].filter((s) => s.n >= WEAK_MIN_N).sort((a, b) => b.weakness - a.weakness).slice(0, 5);
  const noteSeen = ctx.unitStates.get(ctx.current.id)?.noteSeen;

  const start = () => navigate(noteSeen ? 'session' : `units/${ctx.current.id}`);
  const doAnalyze = () => void analyze.run(async (p) => { setAnalysis(await runAnalyze(p, ctx)); reload(); });
  const doGloss = () => void gloss.run(async (p) => { setGlossDone(await runGloss(p, ctx)); reload(); });

  return (
    <div>
      <h1>ホーム</h1>
      <div className="grid2">
        <section className="card">
          <h2>今日の残り</h2>
          <div className="big-numbers">
            <div><b>{ctx.dueCount}</b><span>復習</span></div>
            <div><b>{ctx.newRemainingToday}</b><span>新規（上限 {ctx.settings.dailyNewLimit}）</span></div>
          </div>
          <button className="primary big" autoFocus onClick={start}>学習を始める（{ctx.settings.sessionSize}問）</button>
          {!noteSeen && <p className="muted">初めての単元なので、まず文法ノートを表示します。</p>}
        </section>
        <section className="card">
          <h2>現在の単元</h2>
          <p><b>{ctx.current.id}</b> {ctx.current.title}</p>
          <p className="muted">解放済み：{ctx.unlocked.join(', ')}</p>
          <a href={`#/units/${ctx.current.id}`}>文法ノートを見る</a>
        </section>
      </div>

      <section className="card">
        <h2>弱点トップ5</h2>
        {weak.length === 0 ? <p className="muted">まだ十分なデータがありません（タグごとに{WEAK_MIN_N}問以上解くと表示されます）。</p> : (
          <table className="table">
            <thead><tr><th>項目</th><th>解答数</th><th>正答率</th><th>信頼下限（LB）</th></tr></thead>
            <tbody>
              {weak.map((s) => (
                <tr key={s.tag}>
                  <td>{tagLabelJa(s.tag)}</td><td>{s.n}</td><td>{pct(s.acc)}</td>
                  <td><span className="lb" style={{ background: lbColor(s.lb) }}>{pct(s.lb)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={due.due ? 'card banner hot' : 'card banner'}>
        <div>
          <h2>弱点の分析（AI）</h2>
          <p className="muted">
            {due.due ? '分析のタイミングです。' : '手動でいつでも実行できます。'}
            未分析の解答：{due.unanalyzed}件
            {ctx.settings.lastAnalysisAt > 0 && ` ・ 前回：${new Date(ctx.settings.lastAnalysisAt).toLocaleDateString('ja-JP')}`}
          </p>
          {analysis && (
            <p className="ok-text">
              取り込みました：穴埋め問題 {analysis.added}件、検疫 {analysis.quarantined}件、タグの重み {analysis.weights}件、機能提案 {analysis.requests}件。
              <a href="#/reports">レポートを見る</a>
            </p>
          )}
          <AiErrorBox task={analyze} />
        </div>
        <button className={due.due ? 'primary' : ''} disabled={analyze.busy || ctx.attempts.length === 0} onClick={doAnalyze}>
          {analyze.busy ? '分析中…' : '分析する'}
        </button>
      </section>

      {(glossCount > 0 || glossDone !== null) && (
        <section className="card banner">
          <div>
            <h2>日本語訳の生成（AI）</h2>
            <p className="muted">これから出題される語のうち、日本語訳がない語：{glossCount}語（無い場合は英語の訳語を表示します）</p>
            {glossDone !== null && <p className="ok-text">{glossDone}語の日本語訳を保存しました。</p>}
            <AiErrorBox task={gloss} />
          </div>
          <button disabled={gloss.busy || glossCount === 0} onClick={doGloss}>{gloss.busy ? '生成中…' : '日本語訳を生成'}</button>
        </section>
      )}
    </div>
  );
}
