import { useRef, useState, type ReactNode } from 'react';
import type { GradeT7Result } from '../ai/schemas';
import { runGradeT7 } from '../ai/tasks';
import { buildTranslationSources } from '../core/translation';
import { db } from '../db/db';
import { loadSettings } from '../db/settings';
import { recordT7Attempt } from '../db/study';
import { AiErrorBox, useAiTask, useAsync } from './common';
import { RuInput } from './RuInput';

const SCORE_JA = { 1: '正解', 0.5: '部分点', 0: '不正解' } as const;

export function TranslationPage(): ReactNode {
  const { data, error, reload } = useAsync(async () => {
    const [items, settings] = await Promise.all([db.items.toArray(), loadSettings()]);
    return { sources: buildTranslationSources(items, 5), settings };
  }, []);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, GradeT7Result>>({});
  const recorded = useRef(new Set<string>());
  const task = useAiTask();

  const sources = data?.sources ?? [];
  const filled = sources.filter((s) => (answers[s.itemId] ?? '').trim() !== '');

  const grade = () => {
    if (filled.length === 0) return;
    const submitted = filled.map((s, i) => ({ attemptId: i, source: s, given: (answers[s.itemId] ?? '').trim() }));
    void task.run(async (p) => {
      const out = await runGradeT7(p, submitted.map(({ attemptId, source, given }) => ({ attemptId, ja: source.ja, given })));
      const next: Record<string, GradeT7Result> = {};
      for (const r of out.results) {
        const item = submitted[r.attemptId];
        if (!item) continue;
        next[item.source.itemId] = r;
        if (!recorded.current.has(item.source.itemId)) {
          recorded.current.add(item.source.itemId);
          await recordT7Attempt({
            itemId: item.source.itemId, ja: item.source.ja, given: item.given,
            score: r.score, corrected: r.corrected,
          });
        }
      }
      setResults(next);
    });
  };

  const nextSet = () => {
    setAnswers({});
    setResults({});
    recorded.current.clear();
    reload();
  };

  if (error) return <div className="box error">{error}</div>;
  if (!data) return <p className="muted">読み込み中…</p>;

  return (
    <div>
      <h1>和文露訳（T7）</h1>
      <p className="muted">
        日本語をロシア語に訳してまとめてAIに採点させます。採点は「意味が通じるか」を見るので、語順の細かな違いは減点されません。
        例文はこれまでに作られた穴埋め文（T4/T10）から出題します。
      </p>
      {sources.length === 0 ? (
        <div className="box">
          出題できる例文がありません。ホームの「弱点の分析（AI）」で穴埋め文を作るか、単語リストに <code>+対</code> などの注記付きの語を登録してください。
        </div>
      ) : (
        <>
          {sources.map((s, i) => {
            const r = results[s.itemId];
            return (
              <section className="card" key={s.itemId}>
                <h2>{i + 1}. {s.ja}</h2>
                <RuInput
                  value={answers[s.itemId] ?? ''}
                  onChange={(v) => setAnswers((a) => ({ ...a, [s.itemId]: v }))}
                  defaultMode={data.settings.inputMode}
                  showKeyboardDefault={data.settings.showKeyboard}
                  placeholder="ロシア語で入力（ローマ字入力も可）"
                />
                {r && (
                  <div className={r.score === 0 ? 'box error' : 'box'}>
                    <div className="row between">
                      <b className={r.score === 1 ? 'ok-text' : r.score === 0 ? 'error-text' : ''}>{SCORE_JA[r.score]}（{r.score} / 1）</b>
                    </div>
                    <div className="ru">添削：{r.corrected}</div>
                    <div className="muted">講評：{r.comment_ja}</div>
                    <details>
                      <summary className="muted">模範解答を見る</summary>
                      <div className="ru">{s.ru}</div>
                    </details>
                  </div>
                )}
              </section>
            );
          })}
          <div className="row">
            <button className="primary" disabled={task.busy || filled.length === 0} onClick={grade}>
              {task.busy ? '採点中…' : `まとめて採点（${filled.length}問）`}
            </button>
            <button className="ghost" disabled={task.busy} onClick={nextSet}>別の問題</button>
          </div>
          <AiErrorBox task={task} />
        </>
      )}
    </div>
  );
}
