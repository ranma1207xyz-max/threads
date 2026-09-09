# threads-auto-post

Threads(Meta)へのアフィリエイト投稿を自動化するプロジェクト。ジャンルは美容系。
`threads_keyword_search` を使って「伸びている投稿の型」を自動リサーチし、Claude API でその型を模倣した新規投稿文を商品ごとに生成、公式Threads APIで投稿する。GitHub Actionsで定期実行する。

## 「伸びている投稿」の自動リサーチ

`data/research-keywords.json` に登録したキーワード(美容系のジャンル語)ごとに、Threads公式APIのキーワード検索エンドポイント(`GET /keyword_search`, `search_type=TOP`)で公開投稿を取得し、`data/style-examples.json` に自動反映する。

- 実行: `npm run research`(GitHub Actionsでは `.github/workflows/research.yml` が毎朝6:00 JSTに自動実行し、投稿ワークフローより先に最新の型に更新する)。
- 30文字未満の短文はノイズとして除外し、キーワードをまたいで重複除去した上で最大30件まで保存する。
- 自動収集した例には `source: "keyword_search"` と元投稿の `permalink` を付与して保存する。オーナーが手動で追加した例(`source` フィールドなし)は上書きされず残る。
- **注意**: `contentGenerator.ts` のプロンプトは、これらの例を「構成・トーン・テンポの参考」としてのみ使い、文章そのものはコピーせず新規に書き起こすよう指示している。取得した文章をそのまま転載しているわけではないが、著しく似た投稿にならないか気になる場合は生成結果を確認すること。
- この検索エンドポイントには24時間あたり最大2,200クエリの上限があるが、1日1回・数キーワードの実行では余裕がある。
- 使うには、下記セットアップの `threads_keyword_search` スコープの認可が必須。

## 商材候補リサーチ(手動実行)

`data/product-research-keywords.json` に登録した悩み別キーワード(例: 「毛穴 美容液 おすすめ」)でThreads公式APIのキーワード検索を行い、実際にユーザーが言及している商品・ブランドを`data/product-research-log.json`に出力する。ASPで商材候補を探す前段の一次リサーチ用。

- 実行: GitHub Actionsの「Threads product research」を手動実行(`workflow_dispatch`)する。定期実行はしない。
- 出力はテキストの生ログ(投稿本文・ユーザー名・パーマリンク)のみで、ブランド名の自動抽出などは行わない。人(ほにょ・オーナー)が目視で拾い出す想定。
- ローカルで試す場合は `npm run research:products`。

## セットアップ

### 1. Meta Developer アプリの作成 & アクセストークン取得

1. [Meta for Developers](https://developers.facebook.com/) でアプリを作成し、「Threads API」プロダクトを追加する。
2. あなたのThreadsアカウント(プロ/ビジネスアカウント推奨)を連携する。
3. `threads_basic`・`threads_content_publish`・`threads_keyword_search`(自動リサーチ機能に必須)のスコープでOAuth認可フローを実行し、短期アクセストークンを取得する。
4. 短期トークンを長期トークン(60日)に交換する(Meta Graph APIの `access_token` エンドポイント)。
5. `GET https://graph.threads.net/v1.0/me?fields=id,username&access_token=...` で自分の `id`(= `THREADS_USER_ID`)を確認する。
6. 長期トークンは60日ごとに更新が必要(リフレッシュ用エンドポイントあり)。GitHub Secretsを都度更新するか、リフレッシュを自動化する仕組みを別途検討する。

### 2. Anthropic APIキーの取得

[console.anthropic.com](https://console.anthropic.com/) でAPIキーを発行する。

### 3. GitHub Secretsの設定

このリポジトリをGitHubにpushした後、`Settings > Secrets and variables > Actions` で以下を登録する。

- `THREADS_ACCESS_TOKEN`
- `THREADS_USER_ID`
- `ANTHROPIC_API_KEY`

### 4. データの準備

- `data/products.json` — 投稿したいアフィリエイト商品を追加(`id`, `name`, `url`, `points`, 任意で `imageUrl`)。
  - `imageUrl` を指定すると画像付き投稿になる。ローカルファイルは不可で、インターネット上に公開されている画像URL(ASPのバナー画像URL等)を指定する必要がある。未指定の場合はテキストのみの投稿になる。
- `data/research-keywords.json` — 自動リサーチで検索する美容系キーワードを登録(デフォルトでいくつか入っている。必要に応じて調整)。
- `data/style-examples.json` — 自動リサーチ(`npm run research`)で自動的に埋まる。手動で気に入った投稿例を追加したい場合はコピペで追記してもよい(`source`フィールドを付けなければ自動リサーチで上書きされない)。

### 5. ローカルでの試し実行(任意)

```bash
npm install
cp .env.example .env   # .envに各種キーを入力
npm run research       # 伸びている投稿を自動リサーチしてstyle-examples.jsonを更新
npm run post:dry       # 投稿文を生成するだけ(実際には投稿しない)
npm run post           # 実際にThreadsへ投稿する
```

### 6. スケジュール実行

- `.github/workflows/research.yml` が毎朝6:00 JSTに自動リサーチを実行し、`style-examples.json` を更新する。
- `.github/workflows/post.yml` が1日5回(8:00 / 11:00 / 14:00 / 17:00 / 20:00 JST)自動実行する。

頻度はどちらもcron式を編集して調整可能。GitHub Actionsの画面から手動実行(`workflow_dispatch`)もでき、投稿ワークフローでは `dry_run: true` を指定すると投稿せず生成だけ確認できる。

## 法令順守について

日本の景品表示法(ステマ規制、2023年10月施行)により、アフィリエイト・広告投稿には広告であることの明示が義務付けられている。このプロジェクトの生成プロンプトは投稿文に必ず `#PR` を含めるよう設計しているが、実際の運用では表示が十分か自分でも確認すること。

## ディレクトリ構成

```
threads-auto-post/
  data/
    products.json           # アフィリエイト商品一覧
    research-keywords.json  # 自動リサーチで検索するキーワード
    style-examples.json     # 伸びている投稿の型(自動リサーチ+手動追記)
    posted-log.json         # 投稿履歴(自動更新、重複防止用)
  src/
    config.ts              # 環境変数の読み込み
    threadsClient.ts        # Threads公式Graph API連携(投稿)
    threadsResearch.ts      # Threads公式Graph API連携(キーワード検索)
    contentGenerator.ts     # Claude APIで投稿文を生成
    runResearch.ts          # 自動リサーチのエントリスクリプト
    index.ts                # 投稿のエントリスクリプト
  .github/workflows/
    research.yml  # 自動リサーチのスケジュール実行
    post.yml       # 投稿のスケジュール実行
```
