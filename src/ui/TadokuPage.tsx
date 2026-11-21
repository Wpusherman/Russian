import { Fragment, useMemo, useRef, useState, type ReactNode } from 'react';
import { glossOf } from '../core/grade';
import { tokenizeRussian } from '../core/tadoku';
import { db } from '../db/db';
import { addToReadingList, lookupWord, type LookupHit, type WordLookup } from '../db/tadoku';
import { useAsync } from './common';
import { LemmaCard } from './DictPage';

const SAMPLE = 'Это моя книга. Я живу в Москве и учусь в университете. Каждый день я читаю русские книги и слушаю музыку. Мой друг говорит по-русски очень хорошо.';

const VIA_JA: Record<LookupHit['via'], string> = { headword: '見出し語', form: '本文の語形', prefix: '推定候補' };

export function TadokuPage(): ReactNode {
  const [text, setText] = useState('');
  const [committed, setCommitted] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [lookup, setLookup] = useState<WordLookup | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const seq = useRef(0);
  const { data } = useAsync(async () => {
    const lists = await db.wordlists.toArray();
    const list = lists.find((l) => l.name === '多読');
    return { added: list?.entries.length ?? 0 };
  }, [message]);

  const pieces = useMemo(() => tokenizeRussian(committed), [committed]);
  const chosen = lookup?.hits.find((h) => h.lemma.id === chosenId) ?? lookup?.hits[0] ?? null;

  const open = (word: string) => {
    setSelected(word);
    setLooking(true);
    setLookup(null);
    setChosenId(null);
    setMessage(null);
    const n = ++seq.current;
    void lookupWord(word).then((r) => {
      if (n !== seq.current) return;
      setLookup(r);
      setChosenId(r.hits[0]?.lemma.id ?? null);
      setLooking(false);
    }, () => {
      if (n !== seq.current) return;
      setLooking(false);
    });
  };

  const add = async () => {
    if (!chosen) return;
    const r = await addToReadingList(chosen.lemma.id);
    setMessage(r === 'added' ? `「多読」リストに ${chosen.lemma.bare} を追加しました。` : `${chosen.lemma.bare} はすでに「多読」リストにあります。`);
  };

  const show = () => {
    setCommitted(text);
    setSelected(null);
    setLookup(null);
    setMessage(null);
  };

  return (
    <div>
      <h1>多読</h1>
      <p className="muted">
        ロシア語の文章を貼り付け、分からない単語をクリックすると辞書の見出し語と語形を表示します。見出し語は「多読」リストに追加でき、新規の語として優先的に出題されます。
      </p>
      <section className="card">
        <label>
          本文（ロシア語）
          <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="ロシア語の文章を貼り付け…" />
        </label>
        <div className="row">
          <button className="primary" disabled={!text.trim()} onClick={show}>本文を表示</button>
          <button className="ghost" onClick={() => { setText(SAMPLE); setCommitted(SAMPLE); setSelected(null); setLookup(null); }}>サンプル</button>
          <button className="ghost" onClick={() => { setText(''); setCommitted(''); setSelected(null); setLookup(null); }}>クリア</button>
          <span className="muted small-text">「多読」リスト：{data?.added ?? 0} 語</span>
        </div>
      </section>
      {committed && (
        <div className="split">
          <section className="card" style={{ margin: 0 }}>
            <div className="tadoku-text">
              {pieces.map((p, i) => p.word
                ? <button key={i} type="button" className={`word${selected === p.text ? ' on' : ''}`} onClick={() => open(p.text)}>{p.text}</button>
                : <Fragment key={i}>{p.text}</Fragment>)}
            </div>
          </section>
          <aside className="card" style={{ margin: 0 }}>
            <h2>辞書</h2>
            {!selected && <p className="muted">本文中の単語をクリックしてください。</p>}
            {selected && looking && <p className="muted">「{selected}」を検索中…</p>}
            {selected && !looking && lookup && lookup.hits.length === 0 && (
              <div>
                <p><span className="ru">{selected}</span> は辞書に見つかりませんでした。</p>
                <p className="muted small-text">固有名詞や変化形は見つからないことがあります。単語リスト画面から登録できます。</p>
              </div>
            )}
            {lookup && lookup.hits.length > 0 && (
              <>
                <p className="muted small-text">
                  「<span className="ru">{lookup.token}</span>」の候補（{lookup.hits.length}件）
                </p>
                {lookup.hits.length > 1 && (
                  <ul className="list" style={{ maxHeight: '30vh' }}>
                    {lookup.hits.map((h) => (
                      <li key={h.lemma.id}>
                        <button className={h.lemma.id === chosen?.lemma.id ? 'link on' : 'link'} onClick={() => setChosenId(h.lemma.id)}>
                          <span className="ru">{h.lemma.accented}</span>
                          <span className="muted"> {VIA_JA[h.via]} ・ {glossOf(h.lemma) || '訳なし'}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {chosen && (
                  <>
                    {chosen.via !== 'headword' && (
                      <p className="muted small-text">
                        本文の形 <span className="ru">{lookup.token}</span> → 見出し語 <span className="ru">{chosen.lemma.bare}</span>（{VIA_JA[chosen.via]}）
                      </p>
                    )}
                    <LemmaCard lemma={chosen.lemma} />
                    <div className="row">
                      <button className="primary" onClick={() => void add()}>「多読」リストに追加</button>
                    </div>
                  </>
                )}
              </>
            )}
            {message && <div className="box">{message}</div>}
          </aside>
        </div>
      )}
    </div>
  );
}
