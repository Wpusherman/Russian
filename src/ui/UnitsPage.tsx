import { useEffect, useState, type ReactNode } from 'react';
import { runNote } from '../ai/tasks';
import { UNITS, UNLOCK_MIN_LB, UNLOCK_MIN_N, isContextOnlyTag, unitProgress, type Unit } from '../content/units';
import { tagLabelJa } from '../core/tags';
import type { UnitStateRow } from '../db/db';
import { loadContext, setUnitState } from '../db/study';
import { AiErrorBox, lbColor, navigate, pct, useAiTask, useAsync } from './common';
import { Markdown } from './Markdown';

function Note(props: { unit: Unit; state: UnitStateRow | undefined; firstVisit: boolean; onChanged: () => void }): ReactNode {
  const { unit, state } = props;
  const gen = useAiTask();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const hasNote = !!state?.noteMd;

  const startEdit = () => {
    setTitle(state?.noteTitle ?? unit.title);
    setBody(state?.noteMd ?? '');
    setEditing(true);
  };
  const save = async () => {
    await setUnitState(unit.id, { noteTitle: title, noteMd: body });
    setEditing(false);
    props.onChanged();
  };
  const generate = () => void gen.run(async (p) => { await runNote(p, unit); props.onChanged(); });
  const begin = async () => {
    await setUnitState(unit.id, { noteSeen: true });
    navigate('session');
  };

  return (
    <section className="card">
      <div className="row between">
        <h2>{unit.id} {state?.noteTitle || unit.title}</h2>
        <a href="#/units">単元一覧へ</a>
      </div>
      {editing ? (
        <div>
          <input className="search" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="タイトル" />
          <textarea rows={18} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Markdownで記述" />
          <div className="row">
            <button className="primary" onClick={() => void save()}>保存</button>
            <button className="ghost" onClick={() => setEditing(false)}>キャンセル</button>
          </div>
        </div>
      ) : hasNote ? (
        <div>
          <Markdown text={state!.noteMd!} />
          <div className="row"><button onClick={startEdit}>編集</button></div>
        </div>
      ) : (
        <div>
          <p className="muted">文法ノートはまだ生成されていません。</p>
          <button className="primary" disabled={gen.busy} onClick={generate}>{gen.busy ? '生成中…' : '生成'}</button>
          <AiErrorBox task={gen} />
        </div>
      )}
      {props.firstVisit && !editing && (
        <div className="row first-visit">
          <button className={hasNote ? 'primary big' : 'big'} onClick={() => void begin()}>
            {hasNote ? '読んだので学習を始める' : 'ノートなしで学習を始める'}
          </button>
        </div>
      )}
    </section>
  );
}

export function UnitsPage({ unitId }: { unitId?: string }): ReactNode {
  const { data, error, reload } = useAsync(() => loadContext(), []);
  useEffect(() => reload(), [unitId, reload]);
  if (error) return <div className="box error">{error}</div>;
  if (!data) return <p className="muted">読み込み中…</p>;
  const unit = UNITS.find((u) => u.id === unitId);

  if (unit) {
    const state = data.unitStates.get(unit.id);
    const firstVisit = data.unlocked.includes(unit.id) && unit.id === data.current.id && !state?.noteSeen;
    return (
      <div>
        <h1>文法ノート</h1>
        <Note key={unit.id} unit={unit} state={state} firstVisit={firstVisit} onChanged={reload} />
      </div>
    );
  }

  const unlock = async (id: string) => {
    await setUnitState(id, { unlocked: true });
    reload();
  };
  return (
    <div>
      <h1>単元</h1>
      <p className="muted">
        解放条件：直前の単元の全タグで 解答数 ≥ {UNLOCK_MIN_N} かつ LB ≥ {pct(UNLOCK_MIN_LB)}。
        前置詞・数詞のタグはAIが作る穴埋め問題でのみ集計されるため、解答数が{UNLOCK_MIN_N}未満の間は条件から除外します。
      </p>
      {UNITS.map((u) => {
        const open = data.unlocked.includes(u.id);
        const prog = unitProgress(u, data.stats);
        return (
          <section key={u.id} className={open ? 'card unit' : 'card unit locked'}>
            <div className="row between">
              <h2>{u.id} {u.title} {u.id === data.current.id && <span className="tag">現在</span>}</h2>
              <div className="row">
                {open ? <a href={`#/units/${u.id}`}>ノート</a> : <button className="small" onClick={() => void unlock(u.id)}>手動で解放</button>}
                <span className={open ? 'ok-text' : 'muted'}>{open ? '解放済み' : '未解放'}</span>
              </div>
            </div>
            <div className="chips">
              {prog.map((p) => (
                <span key={p.tag} className={p.ok ? 'chip ok' : 'chip'} title={p.tag}>
                  {tagLabelJa(p.tag)}：
                  {isContextOnlyTag(p.tag) && p.n < UNLOCK_MIN_N ? `n=${p.n}（対象外）` : <>n={p.n} <b style={{ color: p.n > 0 ? lbColor(p.lb) : undefined }}>LB {pct(p.lb)}</b></>}
                </span>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
