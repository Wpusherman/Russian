# Ruslo

日本語話者向けの、ロシア語を「書ける」ようにするためのローカル学習アプリです。
解答をローカルで採点・誤答分類・集計し、AI（Gemini、または手動コピー＆貼り付け）が弱点を診断して教材を作り、出題に反映します。
サーバーは不要で、データはすべてブラウザ（IndexedDB）に保存されます。対象は最新の Chrome / Edge（PC）です。

## セットアップ

1. **CSVの配置**：[Badestrand/russian-dictionary](https://github.com/Badestrand/russian-dictionary) の `nouns.csv`、`verbs.csv`、`adjectives.csv`、`others.csv` を `data/raw/` に置きます。
2. `npm i`
3. `npm run build:dict` … `public/dict/dict.json` を生成します（必須列が見つからない場合は列名を表示して終了します）。
4. `npm run dev` … 表示されたURLを開きます。初回のみ辞書（約5.6万語）の登録に少し時間がかかります。

そのほかのコマンド：`npm test`（vitest）、`npm run build`（`dist/` に静的ファイルを出力）、`npm run preview`。

## 使い方

- **ホーム**の「学習を始める」で1セッション（既定20問）。全操作をキーボードでできます。
  - Enter：送信／次へ、1〜4：選択肢・評価の上書き（Again / Hard / Good / Easy）、H（入力中は Alt+H）：ヒント、P（入力中は Ctrl+P）：音声、W：なぜ？、Alt+T：入力モード切替
- **入力**：既定はローマ字→キリル文字の変換（Translit）です。例：`privet`→привет、`shch`→щ、`zh`→ж、`ya`→я、`'`→ь、`#`→ъ、`ot/syuda`→отсюда（`/` は区切り）。画面キーボードも使えます。
- **単元**：U1〜U15の順に解放されます（直前の単元の全タグで解答数10以上かつ信頼下限75%以上）。手動での解放もできます。
- **単語リスト**：手持ちの単語帳の語を貼り付けると、新規の語として優先的に出題されます。同じ語に別の訳を後から登録すると、上書きされずに「1. 訳1 2. 訳2」と追記されます。
- **統計**：格ごとのヒートマップ、タグ別の表、日ごとの解答数、連続学習日数。
- **設定**：エクスポート／インポート（辞書以外の全データ）ができます。

## AI連携（任意）

AIは、弱点の分析（穴埋め問題の生成を含む）、日本語訳の一括生成、文法ノート、誤答の解説（「なぜ？」）に使います。自動では実行されません。

- **Gemini APIキーの取得**：[Google AI Studio](https://aistudio.google.com/apikey) で発行し、設定画面の「Gemini APIキー」に貼り付けます。キーはブラウザの localStorage にのみ保存されます。
- **無料枠に関する注意**：無料枠では、送信した内容がGoogleの製品改善に利用され得ます。送信されるのは集計済みの統計・誤答例・語のリストですが、気になる場合はManualモードを使ってください。無料枠には1日・1分あたりの回数制限があります（ヘッダーに本日の呼び出し回数を表示します）。
- **Manualモード**：設定で「Manual」を選ぶと、プロンプトをコピーして任意のAIチャットに貼り付け、返ってきたJSONを貼り戻す方式になります。APIキーは不要です。
- **CORSエラーが出る場合**：設定の「開発サーバーのプロキシを使う」を有効にします（`npm run dev` でのみ動作）。
- 開発時は `.env.development.local` に `VITE_GEMINI_API_KEY=...` を書くと初期値として読み込まれます。このファイルは `.gitignore` 済みで、`npm run build` の成果物には含まれません。

## 音声

ブラウザの speechSynthesis（ru-RU）を使います。ロシア語の声がない場合は音声ボタンとディクテーションが出ません。Edgeの使用、またはWindowsの音声パック（ロシア語）の追加を推奨します。

## ライセンス

- 辞書データ：OpenRussian.org（[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)）。`data/raw/` と生成された `public/dict/dict.json` はこのライセンスに従います（リポジトリには含めません）。再配布する場合は表示・継承の条件を守ってください。
- 使用ライブラリ：React、Dexie、ts-fsrs、zod、Vite、vitest（各ライブラリのライセンスに従います）。

仕様にない細部の判断は `DECISIONS.md` に、未実装の項目は `FEATURE_BACKLOG.md` にあります。
