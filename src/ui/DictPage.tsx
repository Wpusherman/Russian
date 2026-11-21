import { useState, type ReactNode } from 'react';
import { translit } from '../core/translit';
import { glossOf, isUncertainGloss } from '../core/grade';
import { CASE_JA, GENDER_JA, NUM_JA, aspectBadge, featLabelJa, verbConjType } from '../core/tags';
import { ADJ_GENDERS, CASES, IMP_KEYS, NUMBERS, PAST_KEYS, PRES_KEYS, type Form, type Lemma } from '../core/types';
import type { LemmaRow } from '../db/db';
import { searchLemmas, setGenderOverride } from '../db/dict';
import { useAsync } from './common';

const POS_JA: Record<string, string> = { noun: '名詞', verb: '動詞', adj: '形容詞', other: 'その他' };

function cell(f: Form | undefined): ReactNode {
  if (!f) return <span className="muted">—</span>;
  return <>{f.primary}{f.variants.length > 0 && <span className="muted"> / {f.variants.join(' / ')}</span>}</>;
}

export function FormsTable({ lemma }: { lemma: Lemma }): ReactNode {
  if (lemma.pos === 'noun') {
    return (
      <table className="forms">
        <thead><tr><th />{NUMBERS.map((n) => <th key={n}>{NUM_JA[n]}</th>)}</tr></thead>
        <tbody>
          {CASES.map((c) => (
            <tr key={c}><th>{CASE_JA[c]}</th>{NUMBERS.map((n) => <td key={n}>{cell(lemma.forms[`case.${c}.${n}`])}</td>)}</tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (lemma.pos === 'adj') {
    return (
      <table className="forms">
        <thead><tr><th />{ADJ_GENDERS.map((g) => <th key={g}>{GENDER_JA[g]}</th>)}</tr></thead>
        <tbody>
          {CASES.map((c) => (
            <tr key={c}><th>{CASE_JA[c]}</th>{ADJ_GENDERS.map((g) => <td key={g}>{cell(lemma.forms[`adj.${c}.${g}`])}</td>)}</tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (lemma.pos === 'verb') {
    return (
      <table className="forms">
        <tbody>
          {[...PRES_KEYS, ...PAST_KEYS, ...IMP_KEYS].map((k) => (
            <tr key={k}><th>{featLabelJa(k, lemma)}</th><td>{cell(lemma.forms[k])}</td></tr>
          ))}
          {lemma.forms['aspect'] && <tr><th>{featLabelJa('aspect', lemma)}</th><td>{cell(lemma.forms['aspect'])}</td></tr>}
        </tbody>
      </table>
    );
  }
  return <p className="muted">語形変化の情報はありません。</p>;
}

export function LemmaCard({ lemma, onGenderChange }: { lemma: LemmaRow; onGenderChange?: (g: 'm' | 'f' | 'n') => void }): ReactNode {
  const meta = [
    POS_JA[lemma.pos],
    lemma.gender && `性：${GENDER_JA[lemma.gender]}`,
    lemma.animate !== undefined && (lemma.animate ? '活動体' : '不活動体'),
    lemma.aspect && `体：${lemma.aspect === 'impf' ? '不完了体' : lemma.aspect === 'pf' ? '完了体' : '両体'}`,
    lemma.pos === 'verb' && `活用：${verbConjType(lemma)}`,
    lemma.level && `レベル ${lemma.level}`,
    lemma.rank !== null && `頻度順位 ${lemma.rank}`,
    lemma.user && 'ユーザー語',
  ].filter(Boolean);
  return (
    <div className="card">
      <h3 className="ru">{lemma.accented}{lemma.hint && <span className="muted"> {lemma.hint}</span>}</h3>
      <div className={isUncertainGloss(glossOf(lemma)) ? 'uncertain-gloss' : ''}>{glossOf(lemma) || <span className="muted">（訳語なし）</span>}{aspectBadge(lemma)}</div>
      {lemma.glossJa && lemma.glossEn.length > 0 && <div className="muted">{lemma.glossEn.slice(0, 4).join(', ')}</div>}
      <div className="muted small-text">{meta.join(' ・ ')}</div>
      {lemma.pos === 'noun' && lemma.genderInferred && (
        <div className="row">
          <span className="muted small-text">性（語尾から推定）：</span>
          {(['m', 'f', 'n'] as const).map((g) => (
            <button key={g} className={`small${lemma.gender === g ? ' on' : ''}`} onClick={() => onGenderChange?.(g)}>{GENDER_JA[g]}</button>
          ))}
        </div>
      )}
      <FormsTable lemma={lemma} />
    </div>
  );
}

export function DictPage(): ReactNode {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<LemmaRow | null>(null);
  // Latin input is transliterated so the box can be used without a Russian keyboard.
  const q = /[a-z]/i.test(query) ? translit(query) : query;
  const { data, reload } = useAsync(() => searchLemmas(q), [q]);
  const results = data ?? [];
  const shown = selected && results.some((r) => r.id === selected.id) ? selected : results[0] ?? null;
  return (
    <div>
      <h1>辞書</h1>
      <input className="search" autoFocus value={query} onChange={(e) => { setQuery(e.target.value); setSelected(null); }}
        placeholder="ロシア語で検索（ローマ字入力も可：kniga → книга）" />
      {q && q !== query && <div className="muted">検索語：{q}</div>}
      <div className="split">
        <ul className="list">
          {results.map((r) => (
            <li key={r.id}>
              <button className={shown?.id === r.id ? 'link on' : 'link'} onClick={() => setSelected(r)}>
                <span className="ru">{r.accented}</span> <span className="muted">{POS_JA[r.pos]} ・ {glossOf(r)}{aspectBadge(r)}</span>
              </button>
            </li>
          ))}
          {q && results.length === 0 && <li className="muted">見つかりません。</li>}
        </ul>
        <div>{shown && <LemmaCard lemma={shown} onGenderChange={(g) => {
          if (!shown) return;
          void setGenderOverride(shown.id, g).then(() => { setSelected(null); reload(); });
        }} />}</div>
      </div>
    </div>
  );
}
