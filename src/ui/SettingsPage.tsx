import { useRef, useState, type ReactNode } from 'react';
import { exportAll, importAll, parseBackup } from '../db/backup';
import { db } from '../db/db';
import { AI_TASKS, DEFAULT_MODELS, getApiKey, loadSettings, setApiKey, setSetting, type Settings } from '../db/settings';
import { downloadText, useAsync } from './common';
import { speak, useRuVoices } from './speech';

export function SettingsPage(): ReactNode {
  const { data, reload } = useAsync(async () => ({ s: await loadSettings(), lemmas: await db.lemmas.count() }), []);
  const voices = useRuVoices();
  const [key, setKey] = useState(getApiKey);
  const [showKey, setShowKey] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!data) return <p className="muted">読み込み中…</p>;
  const s = data.s;

  const set = async <K extends keyof Settings>(k: K, v: Settings[K]) => {
    await setSetting(k, v);
    reload();
  };
  const num = (v: string, lo: number, hi: number, fallback: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  const doExport = async () => {
    const backup = await exportAll();
    downloadText(`ruslo-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup), 'application/json');
  };
  const doImport = async (file: File) => {
    setMsg(null);
    try {
      const backup = parseBackup(await file.text());
      const n = backup.tables['attempts']?.length ?? 0;
      if (!window.confirm(`現在の学習データをすべて削除し、このファイルの内容（解答 ${n}件、${backup.exportedAt}）に置き換えます。よろしいですか？`)) return;
      await importAll(backup);
      setMsg('インポートしました。');
      reload();
    } catch (e) {
      setMsg(`インポートに失敗しました：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const reloadDict = async () => {
    if (!window.confirm('辞書を読み込み直します（学習データは消えません）。よろしいですか？')) return;
    await setSetting('dictVersion', '');
    await db.lemmas.clear();
    window.location.reload();
  };

  return (
    <div>
      <h1>設定</h1>

      <section className="card">
        <h2>学習</h2>
        <div className="form-grid">
          <label>1セッションの問題数（10〜50）
            <input type="number" min={10} max={50} defaultValue={s.sessionSize} onBlur={(e) => void set('sessionSize', num(e.target.value, 10, 50, s.sessionSize))} />
          </label>
          <label>1日の新規語の上限
            <input type="number" min={0} max={200} defaultValue={s.dailyNewLimit} onBlur={(e) => void set('dailyNewLimit', num(e.target.value, 0, 200, s.dailyNewLimit))} />
          </label>
          <label className="check">
            <input type="checkbox" checked={s.yoLenient} onChange={(e) => void set('yoLenient', e.target.checked)} />
            ё を е と書いても正解にする（yoLenient）
          </label>
        </div>
      </section>

      <section className="card">
        <h2>入力</h2>
        <div className="form-grid">
          <label>入力モードの既定値
            <select value={s.inputMode} onChange={(e) => void set('inputMode', e.target.value as Settings['inputMode'])}>
              <option value="translit">Translit（ローマ字→キリル文字）</option>
              <option value="os">OSキーボード（変換なし）</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={s.showKeyboard} onChange={(e) => void set('showKeyboard', e.target.checked)} />
            画面キーボードを最初から表示する
          </label>
        </div>
        <p className="muted">入力欄では Alt+T でいつでも切り替えられます。Translitの例：<code>shch</code>→щ、<code>ya</code>→я、<code>'</code>→ь、<code>#</code>→ъ、<code>ot/syuda</code>→отсюда（<code>/</code> は区切り）。</p>
      </section>

      <section className="card">
        <h2>音声</h2>
        {voices.length === 0 ? (
          <div className="box">ロシア語の音声が見つかりません。Edgeの使用、またはWindowsの音声パックの追加を推奨します。（音声ボタンとディクテーションは非表示になります）</div>
        ) : (
          <div className="form-grid">
            <label>声
              <select value={voices.some((v) => v.voiceURI === s.voiceURI) ? s.voiceURI : voices[0]!.voiceURI} onChange={(e) => void set('voiceURI', e.target.value)}>
                {voices.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name}</option>)}
              </select>
            </label>
            <label>速さ（{s.speechRate}）
              <input type="range" min={0.5} max={1.2} step={0.05} value={s.speechRate} onChange={(e) => void set('speechRate', Number(e.target.value))} />
            </label>
            <button onClick={() => speak('Здравствуйте! Как дела?', s.voiceURI, s.speechRate)}>🔊 試聴</button>
          </div>
        )}
      </section>

      <section className="card">
        <h2>AI連携</h2>
        <div className="form-grid">
          <label>使用するAI
            <select value={s.aiProvider} onChange={(e) => void set('aiProvider', e.target.value as Settings['aiProvider'])}>
              <option value="gemini">Gemini API</option>
              <option value="manual">Manual（コピー＆貼り付け）</option>
            </select>
          </label>
          <label>Gemini APIキー
            <span className="row">
              <input type={showKey ? 'text' : 'password'} value={key} autoComplete="off" onChange={(e) => setKey(e.target.value)} onBlur={() => setApiKey(key)} />
              <button className="small" onClick={() => setShowKey((v) => !v)}>{showKey ? '隠す' : '表示'}</button>
            </span>
          </label>
          {AI_TASKS.filter((t) => t !== 'grade_t7').map((t) => (
            <label key={t}>モデル（{t}）
              <input defaultValue={s.models[t]} placeholder={DEFAULT_MODELS[t]}
                onBlur={(e) => void set('models', { ...s.models, [t]: e.target.value.trim() || DEFAULT_MODELS[t] })} />
            </label>
          ))}
          <label className="check">
            <input type="checkbox" checked={s.useProxy} onChange={(e) => void set('useProxy', e.target.checked)} />
            開発サーバーのプロキシ（/gemini）を使う（CORSエラーが出る場合。<code>npm run dev</code> でのみ有効）
          </label>
        </div>
        <p className="muted">
          APIキーはこのブラウザの localStorage にのみ保存され、エクスポートには含まれません。
          <b>無料枠では入力内容がGoogleの改善に利用され得ます。</b>送信されるのは集計済みの統計・誤答例・語のリストです。
        </p>
      </section>

      <section className="card">
        <h2>データ</h2>
        <div className="row">
          <button onClick={() => void doExport()}>エクスポート（JSON）</button>
          <button onClick={() => fileRef.current?.click()}>インポート（全置換）</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); }} />
          <button className="ghost" onClick={() => void reloadDict()}>辞書を読み込み直す</button>
        </div>
        {msg && <p className={msg.includes('失敗') ? 'box error' : 'ok-text'}>{msg}</p>}
        <p className="muted">辞書：{data.lemmas.toLocaleString()}語（バージョン {s.dictVersion || '—'}）。エクスポートには辞書以外の全データが含まれます。</p>
      </section>

      <section className="card">
        <h2>クレジット</h2>
        <p>辞書データ：OpenRussian.org（CC BY-SA 4.0）</p>
      </section>
    </div>
  );
}
