import { useState, type ReactNode } from 'react';
import { confusionCounts, dailyCounts, streakDays, type TagStat } from '../core/stats';
import { CASE_JA, NUM_JA, confusionLabelJa, tagLabelJa } from '../core/tags';
import { CASES, NUMBERS } from '../core/types';
import { loadContext } from '../db/study';
import { lbColor, navigate, pct, useAsync } from './common';

type SortKey = 'tag' | 'n' | 'acc' | 'lb' | 'trend' | 'w';

function Heatmap({ stats }: { stats: Map<string, TagStat> }): ReactNode {
  return (
    <div className="heatmap">
      <div />
      {CASES.map((c) => <div key={c} className="hm-head">{CASE_JA[c]}</div>)}
      {NUMBERS.map((n) => [
        <div key={n} className="hm-head">{NUM_JA[n]}</div>,
        ...CASES.map((c) => {
          const s = stats.get(`noun.${c}.${n}`);
          return (
            <div key={`${c}${n}`} className="hm-cell" style={s ? { background: lbColor(s.lb), color: '#fff' } : undefined}
              title={s ? `n=${s.n} 正答率 ${pct(s.acc)} LB ${pct(s.lb)}` : 'データなし'}>
              {s ? <><b>{pct(s.lb)}</b><span>n={s.n}</span></> : <span>—</span>}
            </div>
          );
        }),
      ])}
    </div>
  );
}

function Bars({ days }: { days: { day: string; count: number }[] }): ReactNode {
  const max = Math.max(1, ...days.map((d) => d.count));
  const W = 600;
  const H = 120;
  const bw = W / days.length;
  return (
    <svg className="bars" viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label="日ごとの解答数">
      {days.map((d, i) => {
        const h = (d.count / max) * H;
        return (
          <g key={d.day}>
            <rect x={i * bw + 2} y={H - h} width={bw - 4} height={h} rx={2}><title>{d.day}：{d.count}問</title></rect>
            {(i % 5 === 0 || i === days.length - 1) && <text x={i * bw + bw / 2} y={H + 14} textAnchor="middle">{d.day.slice(5)}</text>}
          </g>
        );
      })}
      <text x={2} y={10}>{max}</text>
    </svg>
  );
}

export function StatsPage(): ReactNode {
  const { data, error } = useAsync(() => loadContext(), []);
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'lb', asc: true });
  if (error) return <div className="box error">{error}</div>;
  if (!data) return <p className="muted">読み込み中…</p>;
  const now = data.now;
  const w = (t: string) => data.weights[t] ?? 1;
  const rows = [...data.stats.values()].sort((a, b) => {
    const d = sort.key === 'tag' ? tagLabelJa(a.tag).localeCompare(tagLabelJa(b.tag), 'ja')
      : sort.key === 'w' ? w(a.tag) - w(b.tag) : a[sort.key] - b[sort.key];
    return sort.asc ? d : -d;
  });
  const th = (key: SortKey, label: string) => (
    <th>
      <button className="link" onClick={() => setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }))}>
        {label}{sort.key === key ? (sort.asc ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  );
  const confusions = confusionCounts(data.attempts, now).slice(0, 10);
  return (
    <div>
      <h1>統計</h1>
      <div className="grid2">
        <section className="card">
          <div className="big-numbers">
            <div><b>{streakDays(data.attempts, now)}</b><span>連続学習日数</span></div>
            <div><b>{data.attempts.length}</b><span>総解答数</span></div>
            <div><b>{data.cards.length}</b><span>カード数</span></div>
          </div>
        </section>
        <section className="card">
          <h2>日ごとの解答数（直近30日）</h2>
          <Bars days={dailyCounts(data.attempts, now, 30)} />
        </section>
      </div>
      <section className="card">
        <h2>名詞の格（信頼下限 LB、直近30日）</h2>
        <Heatmap stats={data.stats} />
        <p className="muted">色は Wilson 下限（赤＝弱い、緑＝安定）。主格・単数は辞書形なので出題されません。</p>
      </section>
      <section className="card">
        <h2>タグ別（直近30日）</h2>
        {rows.length === 0 ? <p className="muted">まだデータがありません。</p> : (
          <table className="table">
            <thead><tr>{th('tag', '項目')}{th('n', '解答数')}{th('acc', '正答率')}{th('lb', 'LB')}{th('trend', '傾向')}{th('w', 'AIの重み')}<th /></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.tag}>
                  <td>{tagLabelJa(s.tag)} <span className="muted small-text">{s.tag}</span></td>
                  <td>{s.n}</td><td>{pct(s.acc)}</td>
                  <td><span className="lb" style={{ background: lbColor(s.lb) }}>{pct(s.lb)}</span></td>
                  <td>{s.trend === 0 ? '—' : `${s.trend > 0 ? '+' : ''}${Math.round(s.trend * 100)}pt`}</td>
                  <td>{w(s.tag) === 1 ? '—' : `×${w(s.tag)}`}</td>
                  <td><button className="small" onClick={() => navigate(`session?tag=${encodeURIComponent(s.tag)}`)}>集中練習</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {confusions.length > 0 && (
        <section className="card">
          <h2>よくある取り違え（直近30日）</h2>
          <ul className="plain">
            {confusions.map((c) => <li key={`${c.expected}|${c.given}`}>{confusionLabelJa(c.expected, c.given)}：{c.n}回</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
