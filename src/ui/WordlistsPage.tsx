import { useState, type ReactNode } from 'react';
import { db } from '../db/db';
import { createWordlist, listWordlists, moveWordlist, type ImportSummary } from '../db/wordlists';
import { useAsync } from './common';

export function WordlistsPage(): ReactNode {
  const { data, reload } = useAsync(async () => {
    const lists = await listWordlists();
    const learned = new Set((await db.cards.where('type').equals('T1').toArray()).map((c) => c.lemmaId));
    const ids = [...new Set(lists.flatMap((l) => l.entries.map((e) => e.lemmaId)))];
    const rows = await db.lemmas.bulkGet(ids);
    const byId = new Map(rows.filter((r) => !!r).map((r) => [r!.id, r!]));
    const playable = new Map(lists.map((l) => [
      l.id!, l.entries.filter((e) => { const r = byId.get(e.lemmaId); return !!r && (!!r.glossJa || r.glossEn.length > 0); }).length,
    ]));
    return { lists, learned, playable };
  }, []);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const add = async () => {
    setBusy(true);
    try {
      setSummary(await createWordlist(name, text));
      setName('');
      setText('');
      reload();
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (id: number, active: boolean) => {
    await db.wordlists.update(id, { active });
    reload();
  };
  const move = async (id: number, dir: -1 | 1) => {
    await moveWordlist(id, dir);
    reload();
  };
  const remove = async (id: number, listName: string) => {
    if (!window.confirm(`リスト「${listName}」を削除しますか？（学習済みのカードは残ります）`)) return;
    await db.wordlists.delete(id);
    reload();
  };

  const lists = data?.lists ?? [];
  return (
    <div>
      <h1>単語リスト</h1>
      <p className="muted">手持ちの単語帳の語を登録すると、新規の語として優先的に出題されます（上にあるリストほど優先）。</p>
      <section className="card">
        <h2>登録済みのリスト</h2>
        {lists.length === 0 ? <p className="muted">まだありません。</p> : (
          <table className="table">
            <thead><tr><th>優先</th><th>名前</th><th>語数</th><th>出題可能</th><th>学習済み</th><th>有効</th><th /></tr></thead>
            <tbody>
              {lists.map((l, i) => (
                <tr key={l.id} className={l.active ? '' : 'dim-row'}>
                  <td>
                    <button className="small" disabled={i === 0} onClick={() => void move(l.id!, -1)} aria-label="上へ">▲</button>
                    <button className="small" disabled={i === lists.length - 1} onClick={() => void move(l.id!, 1)} aria-label="下へ">▼</button>
                  </td>
                  <td>{l.name}</td>
                  <td>{l.entries.length}</td>
                  <td>{data!.playable.get(l.id!) ?? 0}</td>
                  <td>{l.entries.filter((e) => data!.learned.has(e.lemmaId)).length}</td>
                  <td><input type="checkbox" checked={l.active} onChange={(e) => void toggle(l.id!, e.target.checked)} /></td>
                  <td><button className="small ghost" onClick={() => void remove(l.id!, l.name)}>削除</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card">
        <h2>リストを追加</h2>
        <label>リスト名（例：書籍名）<input className="search" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>
          単語（1行に1語。<code>見出し語</code> または <code>見出し語[TAB か ,]日本語訳</code>）
          <textarea rows={10} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={'книга\tほん\nчитать,読む\nсесть на +対\t乗る\nспасибо'} />
        </label>
        <div className="row">
          <button className="primary" disabled={busy || !text.trim()} onClick={() => void add()}>{busy ? '登録中…' : '登録'}</button>
          {summary && (
            <span className="ok-text">
              {summary.total}語を登録しました（辞書と一致 {summary.matched}語、辞書にない語 {summary.created}語）。
              {summary.unglossed.length > 0 && ` 訳がなく出題対象外：${summary.unglossed.length}語（${summary.unglossed.slice(0, 10).join(', ')}${summary.unglossed.length > 10 ? ' ほか' : ''}）`}
            </span>
          )}
        </div>
        <p className="muted">
          辞書にない語は、日本語訳を付けた場合のみ出題されます（意味認識と綴り想起のみ）。同じ語に別の訳を登録すると上書きされず、「1. 訳1 2. 訳2」と追記されます。
          フレーズ（例：<code>сесть на +対</code>）も登録でき、<code>+主/生/属/与/対/造/具/前/複</code> は文法のヒントとして表示されます（属は生、具は造として扱われ、入力対象にはならない）。
        </p>
      </section>
    </div>
  );
}
