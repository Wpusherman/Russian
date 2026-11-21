# DATA_REPORT

調査日 2026-11-21、コード未変更。対象は FEATURE_BACKLOG.md、data/raw、public/dict/dict.json（55,850語、hash 811c5a7c）。

## 1. 未実装項目・依存関係・推奨実装順

P運用・W単語リスト・A体・B活用・M7任意・C作文。

| ID | 未実装項目 | 依存 |
|---|---|---|
| P1 | backlog の status('new'/'exported') と起動時の自動削除 | なし（version 埋め込み） |
| P2 | APP_FEATURES の定義と analyze への送信 | P1 |
| P3 | analyze 改善（backlog_titles・重複禁止文） | P2 |
| W1 | 単語リストのラテン→キリル変換 | translit.ts |
| W2 | ユーザー語のアポストロフィ→アクセント変換 | build-dict の convertAccent |
| W3 | 同音異義語の照合先を選ぶ UI | なし（登録画面） |
| W4 | フレーズの誤答選択肢をフレーズにする | なし（distractors） |
| W5 | 訳なし語の件数・一覧表示 | なし |
| W6 | 注記を空白なしでも切り離す | なし（HINT_RE） |
| W7 | 注記の上書きをやめ entry 側に持つ | W6 |
| W8 | ユーザー語を gloss の対象にする | A4 |
| W9 | 注記を使った穴埋め（T4 自動生成） | W6、T4 生成 |
| A1 | 体の表示（'both' 許可・バッジ・ペア表示） | build-dict |
| A2 | T2 の曖昧さ解消（補足・誤答除外） | A1 |
| A3 | wrong_aspect 判定 | A1 |
| A4 | gloss 入力の拡張（aspect/partner） | A1 |
| A5 | T10 体の使い分けドリル（U14） | A3・A4 |
| B1 | 動詞の子音交替（alt・no_alternation・交替カード） | build-dict、A3（classify の挿入順） |
| B2 | 再帰動詞（verb.reflexive・reflexive_drop） | B1 |
| B3 | 正書法規則のハイライト（spellExceptions） | build-dict |
| B4 | T9 形容詞一致ドリル・タグ別の集中練習 | 集中練習は汎用 |
| B5 | アクセント入力（`=`）と stressOk 記録 | なし |
| M7 | T7 和文露訳 | 実装済み（`#/translation`） |
| M7 | T8 音読 | 実装済み（`#/reading`） |
| M7 | 多読モード | 実装済み（`#/tadoku`） |
| C | 作文機能（逆引き表・自由穴埋め・AI 添削） | 逆引き表、W6、A5 |

推奨順: **P1→P2→P3 → W6→W7→W1→W2→W5→W3→W4 → build-dict 一括（both/alt/spellExceptions）→ A1→A2→A3→A4→A5 → B1→B2→B3→B4→B5 → W8→W9 → M7 → C**。
理由: A1〜A5 は aspect/partner を共有し、A3 の classify 挿入は B1・B2 より前が仕様。build-dict の変更は1回の再ビルドにまとめる。W8 は A4 に相乗りできる。M7 と作文は独立だが規模が大きいので最後。

## 2. data/raw と dict.json の統計

内訳: 名詞 24,137 / 動詞 14,258 / 形容詞 10,169 / その他 7,286。

| 項目 | 件数・結果 | 例（3件） |
|---|---|---|
| 動詞 aspect（dict） | impf 7,235 / pf 6,539 / 未設定 484（3.4%） | impf: быть, мочь, знать／pf: сказать, спросить, понять／未設定: использовать, велеть, жениться |
| aspect の元データ | verbs.csv 14,871行: imperfective 7,597 / perfective 6,706 / both 567 / 空1。'both' を捨てるため未設定484語 | — |
| partnerIds | 8,948 / 14,258 = 62.8%、参照切れ 0 | сказать↔говорить, мочь↔смочь, знать↔узнать |
| 名詞の gender 欠損 | 4,405 / 24,137 = 18.3% | свет, право, сын |
| 数詞 один〜сто・тысяча | 30語すべて見出しあり。語形ありは пять（主格・生格の単複）、пятнадцать（単数6格）、тридцать（主格・生格の単複）、тысяча（12形）の4語のみ。他は pos:other・forms空で одного/одной 等も未収録 | один, два, сто（語形なし） |
| 空白を含む見出し語 | 24 件（0.04%、すべて pos:other。others.csv の24行と一致） | друг друга, до свидания, доброе утро |
| 英訳なし | 11,328 件（20.3%）: 名詞 3,775 / other 3,817 / 動詞 2,082 / 形容詞 1,654 | ах, санкт, окружающее |

## 3. AI 日本語訳（gloss）の現状

**削除されていない。** 履歴は4コミットのみ。b676bc0（first commit）で導入され、`git log -S"gloss"` は追加のみ、ファイル削除コミットもない。

実装箇所: `src/ai/tasks.ts:98` の `runGloss`、`src/ai/schemas.ts:37`、`src/ai/prompts.ts:9`、`src/ui/HomePage.tsx:93` の「日本語訳を生成」。既定モデルは `src/db/settings.ts:32` の `gemini-3.5-flash-lite`。結果は `settings.glossJa` に保存し、辞書の再読込時に再適用する（`src/db/dict.ts:22`）。

制限: `src/db/study.ts:91` の `glossCandidates` は「glossJa 未設定かつ glossEn がある新規語」だけを最大100件返すため、ユーザー語と英訳なし語は対象外（前掲 W8）。glossJa を持つ辞書語は 0 件。
