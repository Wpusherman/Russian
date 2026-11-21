import { useState, type ReactNode } from 'react';
import { analyzeZ, type AnalyzeOutput, type NewItem } from '../ai/schemas';
import { backlogMarkdown, registerNewItem } from '../ai/tasks';
import { tagLabelJa } from '../core/tags';
import { db, type QuarantineRow } from '../db/db';
import { loadSettings } from '../db/settings';
import { downloadText, fmtDate, useAsync } from './common';
import { markAllBacklogExported } from '../db/backlog';

// ---------- AI reports ----------

export function ReportsPage(): ReactNode {
  const { data } = useAsync(async () => (await db.plans.orderBy('id').reverse().toArray()), []);
  const now = Date.now();
  const plans = data ?? [];
  return (
    <div>
      <h1>AIレポート</h1>
      {plans.length === 0 && <p className="muted">まだ分析結果がありません。ホームの「分析する」から実行できます。</p>}
      {plans.map((p, i) => {
        const parsed = analyzeZ.safeParse(p.raw);
        const out: AnalyzeOutput | null = parsed.success ? parsed.data : null;
        const active = i === 0 && p.expiresAt > now;
        return (
          <section className="card" key={p.id}>
            <div className="row between">
              <h2>{fmtDate(p.ts)}</h2>
              <span className={active ? 'ok-text' : 'muted'}>
                {active ? `タグの重み：有効（${new Date(p.expiresAt).toLocaleDateString('ja-JP')}まで）` : 'タグの重み：失効'}
              </span>
            </div>
            {!out ? <p className="muted">この記録は表示できません。</p> : (
              <>
                <h3>診断</h3>
                {out.diagnosis.length === 0 && <p className="muted">なし</p>}
                <ul>
                  {out.diagnosis.map((d, j) => (
                    <li key={j}><b>{tagLabelJa(d.tag)}</b>：{d.hypothesis_ja}<div className="muted small-text">根拠：{d.evidence}</div></li>
                  ))}
                </ul>
                <h3>アドバイス</h3>
                <p>{out.tips_ja}</p>
                <h3>タグの重み</h3>
                <div className="chips">
                  {p.weights.length === 0 && <span className="muted">なし</span>}
                  {p.weights.map((w) => <span className="chip" key={w.tag}>{tagLabelJa(w.tag)} ×{w.w}</span>)}
                </div>
                <p className="muted small-text">作成された穴埋め文：{out.new_items.length}件 ・ 機能提案：{out.feature_requests.length}件</p>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ---------- quarantine ----------

const FIELDS: [keyof NewItem, string][] = [
  ['sentence_ru', '文（___ を1つ）'], ['lemma', '見出し語'], ['feat', 'feat'], ['answer', '答え'], ['translation_ja', '和訳'], ['explain_ja', '解説'],
];

function QuarantineItem({ row, onDone }: { row: QuarantineRow; onDone: () => void }): ReactNode {
  const [item, setItem] = useState<NewItem>({
    sentence_ru: '', lemma: '', feat: '', answer: '', translation_ja: '', explain_ja: '', ...(row.payload as Partial<NewItem>),
  });
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approve = async () => {
    const s = await loadSettings();
    const reason = await registerNewItem(item, s.yoLenient);
    if (reason !== null) {
      setError(`まだ検証を通りません：${reason}`);
      setEditing(true);
      return;
    }
    await db.quarantine.delete(row.id!);
    onDone();
  };
  const discard = async () => {
    await db.quarantine.delete(row.id!);
    onDone();
  };
  return (
    <section className="card">
      <div className="row between"><b className="ru">{item.sentence_ru}</b><span className="muted small-text">{fmtDate(row.ts)}</span></div>
      <div className="box error">理由：{row.reason}</div>
      {editing ? (
        <div className="form-grid">
          {FIELDS.map(([k, label]) => (
            <label key={k}>{label}<input value={item[k]} onChange={(e) => setItem({ ...item, [k]: e.target.value })} /></label>
          ))}
        </div>
      ) : (
        <p className="muted">
          {item.lemma} / {item.feat} → <span className="ru">{item.answer}</span> ・ {item.translation_ja}
        </p>
      )}
      {error && <div className="box error">{error}</div>}
      <div className="row">
        <button onClick={() => void approve()}>{editing ? '修正して承認' : '承認'}</button>
        {!editing && <button onClick={() => setEditing(true)}>修正して承認…</button>}
        <button className="ghost" onClick={() => void discard()}>破棄</button>
      </div>
      <p className="muted small-text">承認時にも辞書との照合を行います。通らない場合は修正してください。</p>
    </section>
  );
}

export function QuarantinePage(): ReactNode {
  const { data, reload } = useAsync(() => db.quarantine.orderBy('id').reverse().toArray(), []);
  const rows = data ?? [];
  return (
    <div>
      <h1>検疫</h1>
      <p className="muted">AIが作った穴埋め文のうち、辞書との照合に失敗したものです。正しい形に直せば問題として登録できます。</p>
      {rows.length === 0 && <p className="muted">検疫中の項目はありません。</p>}
      {rows.map((r) => <QuarantineItem key={r.id} row={r} onDone={reload} />)}
    </div>
  );
}

// ---------- backlog ----------

export function BacklogPage(): ReactNode {
  const { data, reload } = useAsync(() => db.backlog.orderBy('id').toArray(), []);
  const [copied, setCopied] = useState(false);
  const rows = data ?? [];
  const fresh = rows.filter((r) => (r.status ?? 'new') === 'new');
  const exported = rows.filter((r) => r.status === 'exported');
  const md = backlogMarkdown(rows);
  const exportAll = async () => {
    await markAllBacklogExported();
    reload();
  };
  const copy = async () => {
    await navigator.clipboard.writeText(md);
    await exportAll();
    setCopied(true);
  };
  const download = async () => {
    downloadText('FEATURE_BACKLOG.md', md, 'text/markdown');
    await exportAll();
  };
  const remove = async (id: number) => {
    await db.backlog.delete(id);
    reload();
  };
  const card = (r: (typeof rows)[number]) => (
    <section className="card" key={r.id}>
      <div className="row between"><h2>{r.title}</h2><span className="muted small-text">{fmtDate(r.ts)}</span></div>
      <p><b>根拠：</b>{r.rationale}</p>
      <p><b>仕様：</b>{r.spec}</p>
      <button className="small ghost" onClick={() => void remove(r.id!)}>削除</button>
    </section>
  );
  return (
    <div>
      <h1>バックログ（AIからの機能提案）</h1>
      <p className="muted">コピーまたはダウンロードした項目は「エクスポート済み」になります。アプリの版が変わると、エクスポート済みの項目は自動で削除されます。</p>
      <div className="row">
        <button disabled={rows.length === 0} onClick={() => void copy()}>全件コピー</button>
        <button disabled={rows.length === 0} onClick={() => void download()}>.mdとしてダウンロード</button>
        {copied && <span className="ok-text">コピーしました</span>}
      </div>
      {rows.length === 0 && <p className="muted">まだ提案はありません。分析を実行すると、AIが必要と判断した機能がここに追加されます。</p>}
      {fresh.length > 0 && <><h2>未エクスポート（{fresh.length}件）</h2>{fresh.map(card)}</>}
      {exported.length > 0 && <><h2 className="muted">エクスポート済み（{exported.length}件）</h2>{exported.map(card)}</>}
    </div>
  );
}
