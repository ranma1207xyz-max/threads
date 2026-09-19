# threads-auto-post

Threads(Meta)へのアフィリエイト投稿を自動化するプロジェクト。ジャンルは美容系。
ブラウザ自動操作で「伸びている投稿の型」を自動リサーチし、Claude API でその型を模倣した新規投稿文を商品ごとに生成、公式Threads APIで投稿する。GitHub Actionsで定期実行する。

## 投稿の2段階構成(フック投稿 → 自己返信で本文+リンク)

1回の投稿処理で、Threads投稿は次の2段階になる(2026-09-18〜)。

1. **新規投稿**: Claudeが生成した短い「フック」(興味を引く導入文。商品の詳細やアフィリエイトリンクは含まない)を新規投稿として投稿する。
2. **自己返信**: STEP1で作成した自分自身の投稿(そのpublish結果のID)に対して、`reply_to_id` を指定した返信として、Claudeが生成した「本文」(商品の魅力・使用感を伝える本編)+商品のアフィリエイトリンク+広告表示(`pr`)をまとめて投稿する。

アフィリエイトリンクが新規投稿の本文に入ることは絶対にない。`products.json` の商品に `url` が設定されていない場合は、投稿処理自体を開始前に中断する(意味のないフック投稿を避けるため)。新規投稿(STEP1)が失敗した場合、またはSTEP1の投稿IDが取得できない場合は、返信(STEP2)は一切実行しない。

広告表示は `#PR` ではなく、リンクの末尾に小文字の `pr` を添えるだけの形式を使う(例: `https://a.r10.to/xxxx pr`)。`#`付きだとThreadsが本文中の先頭のハッシュタグを「トピックタグ」としてユーザー名の隣にバッジ表示してしまう(`#`自体も本文表示から消える)ため回避している。小文字`pr`は、実際にこのジャンルで高い実績を上げているアカウントの投稿を分析して確認した表記に合わせたもの(2026-09-18)。

## 閲覧数などの自動記録(インサイト収集)

投稿した各Threads投稿について、閲覧数(views)・いいね・返信・リポスト・引用・シェアの数を、Threads公式APIのInsightsエンドポイント(`GET /{投稿ID}/insights`)経由で取得し、`data/insights-log.json` に時系列のスナップショットとして追記していく。

- 実行: `npm run insights`(GitHub Actionsでは `.github/workflows/insights.yml` が毎日22:30 JSTに自動実行する)。
- 対象は直近30日以内に投稿したものに限定する(古い投稿まで毎回取り直すと際限なく重くなるため)。
- 1回の実行につき、対象の投稿ごとに1件のスナップショット(取得時点の累計値)を追記する形式。上書きではなく追記なので、同じ投稿の数字が時間とともにどう伸びたかを後から追える。
- 一部の投稿の取得に失敗しても(削除済み投稿など)処理全体は止めない。全件失敗した場合のみエラーにする。
- 使うには、下記セットアップの `threads_manage_insights` スコープの認可が必須(既存の長期アクセストークンにこのスコープが含まれていない場合、スコープを追加して認可フローを取り直す必要がある)。

## 「伸びている投稿」の自動リサーチ(ブラウザ自動操作方式)

Threads公式APIには、他人の投稿の「いいね数」や「返信欄の中身」を取得する手段が無い(自分の投稿の閲覧数等は`threads_manage_insights`で取れるが、他人の投稿には使えない)。そのため、このリサーチはAPIではなく、**ヘッドレスブラウザ(Playwright)でThreadsのWeb版に実際にログインして巡回する方式**で行う。

### 採用条件(すべてAND条件)

`data/research-keywords.json` に登録された5キーワード(`美容`・`美容液`・`肌荒れ`・`ニキビ`・`美肌`。これ以外のキーワードは使わない)ごとに検索し、以下を**すべて**満たす投稿だけを参考例として採用する。

1. 投稿されてから7日以内(Threads上の正確な投稿日時を確認)
2. いいね数が100以上
3. 検索に使ったキーワードが指定の5つのいずれかである(検索自体をこの5キーワードだけに限定しているため自動的に満たす)

**調べる場所(2026-09-19、オーナー判断)**: キーワード検索ではなく、ログイン中アカウントのThreadsホーム「おすすめ」フィードを主な調査元にする。`src/runResearch.ts` はまず「おすすめ」を60回スクロールして投稿を集め(Threadsは画面付近の投稿しかDOMに残さないため、スクロールのたびに収集して重複を除く)、美容関連の語(`isBeautyRelated`)を含み、7日以内・いいね100以上のものを採用する。「おすすめ」は美容以外の投稿も多く流れるため、この絞り込みが必要。採用が3件未満のときだけ、従来のキーワード検索(上の5キーワード)で補う。自社アカウント(`bihada_biyoshitsu`)の投稿は対象外。自動採用は最大8件。

(2026-09-19、オーナー判断で「返信欄にアフィリエイトリンクが存在する」という条件を外した。以前はこれを満たす投稿がほぼ見つからず、参考例が常に0件だったため。ただし返信欄は今も確認しており、`data/affiliate-domains.json` に登録済みの提携先(ASP)ドメインへのリンクが実際に確認できた場合は、`matchedReplyText`・`affiliateLink` に記録する。)

条件に合う投稿が1件も見つからなかった場合は、条件を緩めて代わりの投稿を採用することはせず、実行ログにその旨を明示し、`style-examples.json` の自動収集分は0件のまま更新する。

### 実行方法とログイン

- 実行: `npm run research`(GitHub Actionsでは `.github/workflows/research.yml` が毎朝6:00 JSTに自動実行し、投稿ワークフローより先に最新の型に更新する)。
- ブラウザ操作には、ログイン済みのThreadsセッションが必要。**投稿に使っている本番アカウントと同じアカウント**でログインする(取締役会で承認済み。非公式な自動巡回のため、Threads側の検知次第でこのアカウントに制限がかかるリスクがある点は把握した上で運用する)。
- 初回セットアップ: ローカルで `npm run research:login` を実行すると、ブラウザが開くので手動でThreadsにログイン(2段階認証があれば完了させる)し、ターミナルでEnterを押すとログイン状態が `data/threads-session.json` に保存される(このファイルはログイン情報そのものに相当するため`.gitignore`済み・絶対にコミットしない)。
  - 保存した `data/threads-session.json` の中身をbase64化し、GitHub Secretsに `THREADS_SESSION_STATE_B64` として登録する(例: `powershell -c "[Convert]::ToBase64String([IO.File]::ReadAllBytes('data/threads-session.json'))"`)。
  - Threadsのログインセッションは無期限ではなく、いずれ切れる可能性がある。ワークフローが「セッション切れ」で失敗するようになったら、`npm run research:login` をやり直して `THREADS_SESSION_STATE_B64` を更新すること。
- 自動収集した例には `source: "threads_browser_research"` に加え、`keyword`(検索キーワード)・`postedAt`(投稿日時)・`likes`(いいね数)・`replyCount`(返信数)・`matchedReplyText`(アフィリエイトリンクが見つかった返信の本文)・`affiliateLink`(確認できたリンクの実際の遷移先)・`imageUrl`(投稿に付いていた画像のURL、無ければ未設定)を付与して保存する。オーナーが手動で追加した例(`source` フィールドなし)は上書きされず残る。
- **注意(文章)**: `contentGenerator.ts` のプロンプトは、これらの例を「構成・トーン・テンポの参考」としてのみ使い、文章そのものはコピーせず新規に書き起こすよう指示している。取得した文章をそのまま転載しているわけではないが、著しく似た投稿にならないか気になる場合は生成結果を確認すること。
- **注意(画像・著作権リスク、取締役会承認済み)**: `imageUrl` が入った例がある場合、`index.ts` の投稿時にその中からランダムに1枚選び、**他人の投稿の画像をそのままURLで参照(ホットリンク)して自社の投稿に使用する**(2026-09-17 オーナー承認。文章とは異なりAI生成による代替ではなく、他人が撮影・作成した画像をそのまま利用する方式であり、著作権侵害のリスクがあることを理解した上での意思決定。詳細は `経営企画/事業計画.md` 参照)。該当する例が無い場合、または画像URLがすでに失効している場合は `products.json` の `imageUrl` にフォールバックする。
- `data/affiliate-domains.json` に登録されている提携先(ASP)ドメインは随時見直す(新しいASPと提携したら追加する)。

## 商材候補リサーチ(手動実行)

`data/product-research-keywords.json` に登録した悩み別キーワード(例: 「毛穴 美容液 おすすめ」)でThreads公式APIのキーワード検索を行い、実際にユーザーが言及している商品・ブランドを`data/product-research-log.json`に出力する。ASPで商材候補を探す前段の一次リサーチ用。

- 実行: GitHub Actionsの「Threads product research」を手動実行(`workflow_dispatch`)する。定期実行はしない。
- 出力はテキストの生ログ(投稿本文・ユーザー名・パーマリンク)のみで、ブランド名の自動抽出などは行わない。人(ほにょ・オーナー)が目視で拾い出す想定。
- ローカルで試す場合は `npm run research:products`。

## セットアップ

### 1. Meta Developer アプリの作成 & アクセストークン取得

1. [Meta for Developers](https://developers.facebook.com/) でアプリを作成し、「Threads API」プロダクトを追加する。
2. あなたのThreadsアカウント(プロ/ビジネスアカウント推奨)を連携する。
3. `threads_basic`・`threads_content_publish`・`threads_keyword_search`(商材候補リサーチ機能に必須。伸びている投稿の自動リサーチはブラウザ自動操作方式のためこのスコープ不要)・`threads_manage_insights`(閲覧数などの自動記録機能に必須)のスコープでOAuth認可フローを実行し、短期アクセストークンを取得する。
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
- `THREADS_SESSION_STATE_B64` — 伸びている投稿の自動リサーチ(ブラウザ自動操作)用。`npm run research:login` で作った `data/threads-session.json` をbase64化した文字列(詳細は上記「伸びている投稿の自動リサーチ」参照)。

### 4. データの準備

- `data/products.json` — 投稿したいアフィリエイト商品を追加(`id`, `name`, `url`, `points`, 任意で `imageUrl`)。
  - `imageUrl` を指定すると画像付き投稿になる。ローカルファイルは不可で、インターネット上に公開されている画像URL(ASPのバナー画像URL等)を指定する必要がある。未指定の場合はテキストのみの投稿になる。
- `data/research-keywords.json` — 自動リサーチで検索するキーワード(`美容`・`美容液`・`肌荒れ`・`ニキビ`・`美肌`の5つに固定。追加・変更する場合は取締役会で合意のうえ調整する)。
- `data/affiliate-domains.json` — 返信欄のリンクを「アフィリエイトリンク」と判定するための提携先(ASP)ドメイン一覧。新しいASPと提携したら追加する。
- `data/style-examples.json` — 自動リサーチ(`npm run research`)で自動的に埋まる。手動で気に入った投稿例を追加したい場合はコピペで追記してもよい(`source`フィールドを付けなければ自動リサーチで上書きされない)。

### 5. ローカルでの試し実行(任意)

```bash
npm install
npx playwright install --with-deps chromium   # ブラウザ自動操作用のChromiumを取得
cp .env.example .env   # .envに各種キーを入力
npm run research:login # 初回のみ: 手動でThreadsにログインし、セッションを保存
npm run research       # 伸びている投稿を自動リサーチしてstyle-examples.jsonを更新
npm run post:dry       # 投稿文を生成するだけ(実際には投稿しない)
npm run post           # 実際にThreadsへ投稿する
```

### 6. スケジュール実行

- `.github/workflows/research.yml` が毎朝6:00 JSTに自動リサーチを実行し、`style-examples.json` を更新する。
- `.github/workflows/post.yml` が1日5回(8:00 / 18:00 / 19:00 / 20:00 / 21:00 JST)自動実行する。
- 投稿の型は時間帯ごとに固定(2026-09-19 オーナー決定。夜の連投が似通わないようにするため。`src/index.ts` の `SLOT_BY_JST_HOUR`)。実行時の日本時間の「時」で決まる(GitHub Actionsの遅延は10〜15分程度なので時で判定する)。
  - 8時台: 悩み共感+使い方(フックは短め)
  - 18時台: 早見表(悩み→成分の一覧)
  - 19時台: 「◯◯は買いません」の言い切りリズム
  - 20時台: 質問だけの投稿(商品・リンク・広告表示なし。`data/posted-log.json` には `productId: "engagement-question"` で記録、返信IDなし)
  - 21時台: 使い方の手順(①②③中心)
  - それ以外の時刻(手動実行など)は型を指定しない。ドライランでは `npm run post:dry -- --slot=<morning|cheatsheet|decisive|question|steps>` で型を指定できる。
- `.github/workflows/insights.yml` が毎日22:30 JSTに閲覧数などを自動記録する。

頻度はどれもcron式を編集して調整可能。GitHub Actionsの画面から手動実行(`workflow_dispatch`)もでき、投稿ワークフローでは `dry_run: true` を指定すると投稿せず生成だけ確認できる。

## 法令順守について

日本の景品表示法(ステマ規制、2023年10月施行)により、アフィリエイト・広告投稿には広告であることの明示が義務付けられている。

- 2026-09-17まで: 生成プロンプトが投稿本文に必ず `#PR` を含める設計だった。
- 2026-09-17以降(オーナー承認): 本文には広告表示を含めず、**自己返信(コメント欄、`src/index.ts` のSTEP3)側に記載する運用に変更**。返信欄のみの表示が「一見して広告と分かる」というステマ規制の要件を満たすかは確立していないリスクを、オーナーが理解した上での意思決定(詳細は `経営企画/事業計画.md` 参照)。
- 2026-09-18: 表記を `#PR` → `[PR]` → 小文字 `pr`(リンク末尾)に変更(ハッシュ記号によるThreadsのトピックタグ化=ユーザー名隣へのバッジ表示を避けるため。詳細は上記「投稿の2段階構成」参照)。オーナーから広告表示自体の完全削除を求められた場面もあったが、明確な規制違反リスクのため実装していない。
- 表示が実際に十分か、また問題が生じた場合は本文表示に戻すことも含めて、引き続き自分でも確認すること。

## ディレクトリ構成

```
threads-auto-post/
  data/
    products.json           # アフィリエイト商品一覧
    research-keywords.json  # 自動リサーチで検索するキーワード(5つ固定)
    affiliate-domains.json  # 返信欄のリンクをアフィリエイトリンクと判定するASPドメイン一覧
    style-examples.json     # 伸びている投稿の型(自動リサーチ+手動追記)
    posted-log.json         # 投稿履歴(自動更新、重複防止用)
    insights-log.json       # 閲覧数などのスナップショット履歴(自動更新)
    threads-session.json    # ブラウザ自動操作用のログイン済みセッション(gitignore対象・要ローカル生成)
  src/
    config.ts              # 環境変数の読み込み
    threadsClient.ts        # Threads公式Graph API連携(新規投稿・自己返信・インサイト取得)
    threadsResearch.ts      # Threads公式Graph API連携(キーワード検索。商材候補リサーチ専用)
    threadsScraper.ts       # ブラウザ自動操作(Playwright)によるThreads巡回・条件判定
    threadsLogin.ts         # ブラウザ自動操作用ログインセッションの作成スクリプト
    contentGenerator.ts     # Claude APIで投稿文を生成
    runResearch.ts          # 伸びている投稿の自動リサーチのエントリスクリプト
    index.ts                # 投稿のエントリスクリプト
    collectInsights.ts      # 閲覧数などの自動記録のエントリスクリプト
  .github/workflows/
    research.yml   # 自動リサーチのスケジュール実行(ブラウザ自動操作)
    post.yml       # 投稿のスケジュール実行
    insights.yml   # 閲覧数などの自動記録のスケジュール実行
```

## 他ジャンルの「型だけ」参考(2026-09-19)

「おすすめ」フィードに流れる美容以外の伸びている投稿(最大4件)を、書き出し・改行のリズム・引きの作り方だけの参考として投稿生成に渡す(`data/style-examples.json` の `genre: "other"`)。話題・内容・画像は使わない。伸びが悪くなったら最初に戻す対象: `data/research-settings.json` の `includeOtherGenreStyles` を `false` にすると、次の投稿からすぐ無効になる(翌朝の調査を待たなくてよい)。
