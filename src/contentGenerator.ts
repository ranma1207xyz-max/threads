import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "fs";
import { config } from "./config.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export interface Product {
  id: string;
  name: string;
  url: string;
  points: string[];
  imageUrl?: string;
}

export interface StyleExample {
  text: string;
  note?: string;
  source?: string;
  username?: string;
  permalink?: string;
  fetchedAt?: string;
  // Fields populated only by the browser-based research (source: "threads_browser_research").
  keyword?: string;
  postedAt?: string;
  likes?: number;
  replyCount?: number;
  matchedReplyText?: string;
  affiliateLink?: string;
  imageUrl?: string;
  // Added 2026-10-01 (research rework): every photo on the post, the copies
  // saved into the repo (research-images/...), and more than likes alone.
  imageUrls?: string[];
  localImages?: string[];
  hasVideo?: boolean;
  replies?: number;
  reposts?: number;
  score?: number;
  topComments?: { username: string; text: string }[];
  authorReplies?: string[];
  // "other" = a viral post from a non-beauty genre, kept only as a reference
  // for structure and phrasing (never its topic).
  genre?: "other";
}

export interface GeneratedPost {
  hook: string;
  body: string;
  // Set only for "clone" style: the same trending example's own photo, so
  // index.ts can attach it instead of independently picking a random trend
  // image (the whole point of "clone" is reusing one post's image+text
  // together, not mixing one post's wording with a different post's photo).
  cloneImageUrl?: string;
}

// The body shares a single Threads post (the reply) with the affiliate link
// and "pr" disclosure appended after it by index.ts, so it needs headroom
// under the 500-char Threads limit rather than the full budget.
// Raised from 150 on 2026-09-19 so the "ingredient cheat-sheet" hook (a
// concern -> ingredient list ending in a cliffhanger) fits; Threads' own
// limit is 500.
const HOOK_MAX_LENGTH = 300;
const BODY_MAX_LENGTH = 400;

const SYSTEM_PROMPT = `あなたはThreads(Meta)向けの日本語アフィリエイト投稿を書くコピーライターです。扱うジャンルは美容系、その中でも美容液・肌関連(スキンケア)商材(化粧水・美容液・クリーム・毛穴ケア等)です。

投稿は2つのパートに分かれています。
1. フック: 新規投稿として単独で投稿される短い導入文。読者の興味を引き、続きを読みたくさせるのが目的。
2. 本文: そのフックへの自分自身の返信として投稿される、商品の魅力を伝える本編(このあとにシステム側でアフィリエイトリンクと広告表示が自動で追記される)。

この美容ジャンルで実際に繰り返し伸びている投稿の型(2026-09-18、複数の高再生・高いいね投稿を分析して確認):
- 一文一行のテンポ: 長い一文にせず、意味の区切りごとに改行して詩のように読ませる(スマホでのスクロール・可読性を重視)。
- 具体的な固有名詞・成分名を出す: 「ビタミンC」「セラミド」のような一般名だけでなく、可能なら商品名や成分名など具体性のある言葉を使い、説得力を出す。
- 番号(①②③)や矢印(→)による構造化: 手順・使い方・比較を箇条書きや流れ図のように視覚的に構造化すると、プレーンな説明文より読まれやすい。
- フックは「悩み・あるある」の共感から入る: 「〜って思う日、増えてませんか」のような、読者自身の経験に重ねやすい問いかけや、話者自身の体験談(「何十万円も試してわかった」等)から始める。
- フックの締めに気づき・学びを一言添える: 押し売りの宣伝文句ではなく、「人気だからじゃなくて、自分の肌質・悩みで選ぶのが大事」のような、素直に納得できる一言でまとめると自然に本文へつながる。
- 引きの作り方(2026-09-19、オーナー指定のアカウント motomane_beautylab を分析): フックを文の途中や「それは、」「入ってる成分が、」のような言いかけで終えて、続きを見たくさせる。答えの直前で切る。
- 「しつこいけど一生言い続ける」型(2026-09-19、オーナー指定。同じ文面が多くの美容アカウントに広まっている定番型で、10万回表示・いいね400超の例がある): 冒頭は「しつこいけど一生言い続ける。」「何回でも言う。」「しつこいって言われても、これは一生言う。」のような宣言調の一言に、「美容頑張る人応援したいから。」「本気でずっと綺麗な肌でいたいなら、」といった理由づけを添える。続けて悩み→成分の早見表を置き、「他にもまだまだあって、」または「それは、」の言いかけで切る。同じ文面が広まっているので、冒頭の言い回しも表の中身も毎回自分の言葉に変え、他のアカウントの文面をそのまま使わないこと。
- 返信(本文)の書き方(同じ投稿の返信欄を分析): 商品名を「」で先頭に置き、成分を1行ずつ短く並べ、口語の短い一言で締める。長い説明は避け、10行前後に収める。
- 「買いません/〜してください」の言い切りリズム(同アカウントで反応が良かった型): 「◯◯は買いません。理由は△△だからです。」を数行くり返し、最後に「□□を買ってください。入ってる成分が、」と落とす。ただし理由は事実として言えるものだけにし、他社や他の商品をけなさない。
- 「明日のテストに出るからな」のような、学校・先生と生徒の小ネタで早見表を始める型もある(毎回は使わず、使うときは冒頭の一言だけ)。
- 数字・固有名詞で具体性を出す(価格帯、配合成分、使う順番など)。ただし数字や成分は、下の「推しポイント」にあるものだけを使う。
- 「早見表」型のフック(2026-09-19、オーナーが指定した伸びている投稿の型): 冒頭で「美容頑張る人を応援したい」といった姿勢を一言示し、「悩み→成分」を一行ずつ並べた早見表(例: 「毛穴には◯◯」「乾燥には◯◯」)を見せる。最後に「この表のうち◯つが、この1本(1セット)で埋まる」と匂わせ、「それは、」のような引きで終えて、答え(商品)を返信欄に回す。本文(返信)では、成分名と使用感を短く具体的に伝える。

厳守事項:
- 参考として渡される「伸びている投稿の例」は、上記の"型"の参考にするだけで、文章そのものを一切コピーしないこと。必ず新規に書き起こすこと。(例外: 今回の型が「clone」の場合のみ、指示に従って「今回お手本にする1件」の文章をほぼそのまま使ってよい。)
- フックは${HOOK_MAX_LENGTH}文字以内。商品名や具体的な商品説明にはまだ踏み込まず、読者の関心・悩みに寄り添う一文〜数文にとどめること。文末に「続きはリプ欄で」「それは、」のように、答えや本文が返信にあることが伝わる引きを入れること(表現は毎回変えてよい)。早見表型のときだけ、この文字数を上限いっぱいまで使ってよい。
- 早見表型を使うときの決まり: 表に並べる悩みと成分の組み合わせ・順番・項目数は毎回変え、参考例の表をそのまま写さないこと。「この表のうち◯つが埋まる」の◯には、表の中で実際に推しポイントに当てはまる項目の数以下しか書かないこと(当てはまらない項目まで「埋まる」と言わない)。「この商品に入っている」と書いてよい成分は、下の「推しポイント」に書かれているものだけ(推しポイントに無い成分名・配合量(%)を、この商品のものとして書かない)。一般的な成分の紹介は「〜が気になる人が選びがちな成分」程度の言い方にとどめ、効能を断定しない。成分と悩みの組み合わせは、一般に広く言われているもの(例: ビタミンC→くすみ・透明感の印象、セラミド→乾燥、ヒアルロン酸→うるおい)だけにし、根拠のない組み合わせ(例: アルブチン→めぐり)を作らない。
- 本文は${BODY_MAX_LENGTH}文字以内。フックの続きとして、商品の魅力・使用感を伝えること。可能なら使い方や特徴を番号・矢印で構造化すること。
- フック・本文のどちらにもURLやリンクを一切含めないこと。商品リンクはシステム側が本文の後ろに別途自動で追加する。
- フック・本文のどちらにも「PR」やそれに類する広告表示を入れないこと。広告であることの明示はシステム側が別途行う。
- 日本語だけで書くこと。「today」のように英単語を文中に混ぜない(ブランド名・成分名などの固有名詞を除く)。
- 誇大広告・断定しすぎる効果効能表現は避け、個人の感想として書くこと。
- 参考例の書き手の肩書き・経歴(「元◯◯」「◯◯の裏側を見てきた」等)や、リピート回数・年間課金額などの実績、芸能人などの実在の人物名は、事実として確認できないので一切まねしないこと。

薬機法(医薬品医療機器等法)に基づく厳守事項(美容ジャンルのため必須):
- 「治る」「完治」「改善する」など医薬品的な効能効果を断定しないこと。
- 「シミが消える」「シワがなくなる」「痩せる」「-5kg」など、身体的変化を断定・数値で保証する表現をしないこと。
- 化粧品の効能効果の範囲(清潔にする、潤いを与える等)を超えた治療的な表現をしないこと。医薬部外品でない限り「美白」「ニキビを治す」等の限定効能表現も避けること。
- 医師・専門家を騙ったり、権威付けで効果を保証する表現をしないこと。
- 効果は必ず「個人の感想」の範囲(「〜と感じた」「〜な気がする」等)にとどめ、一般的な効能の断定は避けること。

出力形式(厳守): 前置きや説明、マークダウンの装飾は一切つけず、次の形式のみで出力すること。
[HOOK]
(フックの本文のみ)
[BODY]
(本文のみ)`;

// The post "shape" is fixed per time slot (2026-09-19 owner decision) so the
// four evening posts don't read as one template repeated. See index.ts for
// the hour -> style mapping. "question" posts carry no product, so they are
// generated separately (generateQuestionPost) rather than through this type.
export type PostStyle =
  | "morning"
  | "cheatsheet"
  | "decisive"
  | "steps"
  | "feed"
  | "clone"
  | "remix"
  | "translate"
  | "surprise"
  | "combo";

const STYLE_INSTRUCTIONS: Record<PostStyle, string> = {
  // 2026-10-03 owner decision: our own version of the by-concern combination
  // chart behind 10/2 20:00's 2,909 views. The hook's chart lines are parsed
  // into the "悩み別 組み合わせ表" card (cardRenderer.ts parseComboPanels), so
  // the line format below is strict.
  combo:
    "「悩み別の組み合わせ表」型で書くこと。フックは「美容液、組み合わせ多すぎて迷う人これ保存👀」のような共感+保存をうながす一言(言い回しは毎回変える)から入り、続けて悩みごとの組み合わせを4行か6行(画像が2列のため偶数)、必ず「・悩み → 成分A+成分B(夜)」の形で1行ずつ並べる(悩みは8文字以内、成分名は1つ8文字以内、( )の中は「朝」「夜」「朝夜」のどれか)。組み合わせは、原則として次の一般に広く言われているものから選ぶ(この中で、毎回悩みの顔ぶれ・順番を変える): シミ・くすみ→ナイアシンアミド+ビタミンC/くすみ→トラネキサム酸+ビタミンC/透明感→アルブチン+ビタミンC/開き毛穴→ナイアシンアミド+レチノール/たるみ毛穴→レチノール+ヒアルロン酸/乾燥→ヒアルロン酸+セラミド/ゆらぎ・赤み→ドクダミ+セラミド/ゆらぎ→CICA+セラミド/ザラつき→アゼライン酸+ヒアルロン酸/大人ニキビ→ドクダミ+ナイアシンアミド/ハリ不足→レチノール+ナイアシンアミド/ツヤ不足→ビタミンC+ヒアルロン酸。推しポイントにある成分を含む行を少なくとも1〜2行入れる。表のあとに使う順番(化粧水→美容液→クリーム)を一言添え、「この表のうち◯つの成分が1本に入っているのが、」のような言いかけで終える。◯には、表の中で推しポイントに実際にある成分の数以下しか書かない。早見表(悩み→成分1つ)型・言い切り型は混ぜない。",
  // 2026-10-03 owner decision: two other types trending in the research pool
  // (9/16-10/2), one post each per day. "translate" = motomane_beautylab
  // (likes 7,216) and mochikono_hitorigoto (3,768) both went big with
  // "I translated confusing beauty names into plain Japanese" + a line of
  // dialogue per item.
  translate:
    "「美容成分の名前、ややこしいから日本語に翻訳してみた」型で書くこと。フックは「〜ややこしいから日本語に翻訳してみた」系の一言(言い回しは毎回変える。「wwww」「🥹」などの軽いノリも可)から入り、成分名を3〜5個、1つずつ「・成分名」の次の行に「」でその成分が話しているような一言(例:「肌のすき間を埋めて、水を逃がしません」)を付けて並べる。セリフは一般に広く言われている働きの範囲だけにし、効能を断定しない。最後はこの商品に入っている成分へつなげ、「で、この中の◯つが入ってるのが、」のような言いかけで終える。この商品に入っていると書いてよい成分は推しポイントにあるものだけ。早見表(悩み→成分)型・言い切り型は混ぜない。",
  // "surprise" = the "I did a triple take" discovery story: bihada.no.nonochan
  // (HAKU, likes 5,088, 119 comments), kahonobiyou (3,407), shin_a40beauty
  // (1,956). Effect claims are the risk here, so the wording rules are strict.
  surprise:
    "「ふと気づいて驚いた」体験談型で書くこと。フックは「え、待って。」「朝、鏡見て二度見した。」のような驚きの一言から入り、何気ない日常の場面→ふと肌の変化に気づいた→「新しく変えたのはこれしかない…」と、短い行でテンポよく驚きを重ね、商品名は出さずに「それが、」のような言いかけで終える。身近な人の一言(「肌なんかした?」と聞かれた等)を入れてもよいが、その人の肌の変化は書かない。気づく変化は化粧品の範囲にとどめる(うるおい・ツヤっぽく見える・キメが整って見える・メイクのりがいい気がする等)。「消えた」「消滅」「薄くなった」「治った」など、シミ・シワ・ニキビが変化したと言い切る表現、日数や数字で効果を示す表現は使わない。本文(返信)は「」で商品名→推しポイント→使い方→「あくまで個人の感想です」と添えた一言、で締める。早見表型・言い切り型は混ぜない。",
  // Only used through generateRemixPost below, which builds its own prompt.
  remix: "",
  // 2026-09-28 owner decision, 1週間だけの試し(リスクをほにょから伝えた上で承認): "feed" とは違い、
  // 構成だけでなく文章そのものをほぼそのまま使う。他人の投稿の丸パクリに近く、著作権・炎上リスクが
  // "feed" より明確に高いことを理解した上での実施。
  clone:
    "下に示す「今回お手本にする1件」の文章を、ほぼそのまま使うこと。変えてよいのは、商品名・成分名など、この商品に合わせるために本当に必要な一言・数語だけ。書き出し、改行の位置、語尾、絵文字の使い方も含めて、お手本とほぼ同じにすること。お手本に無い新しい言い回しを付け加えたり、大きく書き換えたりしないこと。早見表型・言い切り型・手順型は混ぜない。",
  feed:
    "下に示す「今回お手本にする1件」(おすすめフィードで実際に伸びていた投稿)の構成に沿って書くこと。書き出しの言い回し、改行のリズム、言いかけの引き、締め方をそのまま参考にする。ただし、お手本の話題・固有名詞・数字は使わず、この商品の紹介に置き換える。早見表型・言い切り型・手順型は混ぜない。",
  morning:
    "「悩み共感+使い方」型で書くこと。フックは朝の鏡・あるあるなどの共感から入り、150文字以内の短さにする。早見表型・言い切り型は使わない。",
  cheatsheet:
    "「早見表」型(「しつこいけど一生言い続ける」系の宣言調の書き出しも可)で書くこと。言い切り型は使わない。",
  decisive:
    "「◯◯は買いません。理由は△△だからです。」の言い切りリズム型で書くこと。早見表型は使わない。他社・他商品をけなさず、理由は事実として言えることだけにする。",
  steps:
    "「使い方の手順」型で書くこと。フックは「順番を変えただけで〜」のような1〜3行の短い導入(150文字以内)にとどめ、本文は①②③の手順を中心にする。早見表型・言い切り型は使わない。",
};

// "feed" and "clone" each follow one randomly chosen example from the
// browser-research pool rather than the whole example list. "clone"
// (2026-09-28 owner decision) additionally prefers an example that has its
// own photo, since the point is reusing one trending post's image+text
// together — falls back to any example if none in the pool has a photo.
//
// preferredPermalink (2026-09-29 owner decision): after reviewing a batch of
// research results together, the owner can pin one specific post as the
// priority pick for "clone" (data/research-settings.json's
// cloneStyleWindow.preferredPermalink) rather than leaving it to chance. It's
// a soft preference, not a hard requirement — research refreshes
// style-examples.json daily, so the pinned post can rotate out of the pool;
// when that happens this quietly falls back to the normal random pick among
// examples with a photo, rather than erroring.
function pickExampleToFollow(
  style: PostStyle | undefined,
  styleExamples: StyleExample[],
  preferredPermalink?: string
): StyleExample | undefined {
  if (style !== "feed" && style !== "clone") return undefined;
  const pool = styleExamples.filter((example) => example.source === "threads_browser_research");
  if (pool.length === 0) return undefined;
  if (style === "clone") {
    if (preferredPermalink) {
      const pinned = pool.find((example) => example.permalink === preferredPermalink);
      if (pinned) return pinned;
    }
    const withImage = pool.filter((example) => example.imageUrl);
    if (withImage.length > 0) return withImage[Math.floor(Math.random() * withImage.length)];
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildUserPrompt(
  product: Product,
  styleExamples: StyleExample[],
  style: PostStyle | undefined,
  exampleToFollow: StyleExample | undefined
): string {
  const beautyExamples = styleExamples.filter((example) => example.genre !== "other");
  const otherGenreExamples = styleExamples.filter((example) => example.genre === "other");
  const examplesBlock = beautyExamples
    .map((example, index) => `例${index + 1}:\n${example.text}`)
    .join("\n\n");
  const otherGenreBlock =
    otherGenreExamples.length > 0
      ? `\n\n# 型だけの参考(美容以外のジャンルで伸びている投稿。話題・内容・固有名詞は一切使わず、書き出しの言い回し・改行のリズム・引きの作り方だけ参考にする)\n${otherGenreExamples
          .map((example, index) => `参考${index + 1}:\n${example.text}`)
          .join("\n\n")}`
      : "";
  // "feed"/"clone" need their chosen example to actually exist; with none
  // available, fall back to no forced style rather than an empty "お手本".
  const effectiveStyle = (style === "feed" || style === "clone") && !exampleToFollow ? undefined : style;
  const styleBlock = effectiveStyle
    ? `\n# 今回の型(必ずこの型で書き、他の型は混ぜない)\n${STYLE_INSTRUCTIONS[effectiveStyle]}${
        exampleToFollow ? `\n\n## 今回お手本にする1件\n${exampleToFollow.text}` : ""
      }\n`
    : "";

  const referenceBlock =
    examplesBlock || otherGenreBlock
      ? `# 参考にする「型」の例(コピーではなく構成・トーンの参考のみ)\n${examplesBlock}${otherGenreBlock}\n`
      : "";

  return `${referenceBlock}

# 今回投稿する商品情報
商品名: ${product.name}
リンク: ${product.url}
推しポイント:
${product.points.map((point) => `- ${point}`).join("\n")}
${styleBlock}
上記の型を参考に、この商品のフックと本文を1組作成してください。`;
}

const QUESTION_SYSTEM_PROMPT = `あなたはThreads(Meta)向けの日本語投稿を書くライターです。ジャンルは美容・スキンケアです。
今回書くのは、フォロワーが気軽にコメントできる「質問だけの投稿」です。商品の宣伝ではありません。

決まり:
- 商品名・ブランド名・URL・「PR」などの広告表示は一切入れないこと。
- 全体で100文字前後(最大150文字)。一文一行で、意味の区切りごとに改行する。
- 最後は、一言で答えられる質問で終えること(例:「みんなはどっち?」「教えてください」)。
- 効能効果を断定しない。医師や専門家を名乗らない。実績・肩書き・体験を作らない。
- 前置きや説明、マークダウンの装飾なしで、投稿の本文のみを出力すること。`;

const QUESTION_THEMES = [
  "自分の肌タイプ(乾燥・脂性・混合・敏感)",
  "スキンケアは朝と夜、どちらに力を入れているか",
  "スキンケアの工程は何ステップか",
  "美容液を使う派か、使わない派か",
  "いちばん気になる肌悩み(くすみ・毛穴・乾燥・ゆらぎ)",
  "日焼け止めは毎日塗る派か、そうでない派か",
  "化粧水はハンドプレス派か、コットン派か",
];

export async function generateQuestionPost(): Promise<string> {
  const theme = QUESTION_THEMES[Math.floor(Math.random() * QUESTION_THEMES.length)];
  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 512,
    system: QUESTION_SYSTEM_PROMPT,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: `今回のテーマ: ${theme}\n\nこのテーマで、質問だけの投稿を1つ書いてください。` }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude did not return text content");
  }
  return textBlock.text.trim().slice(0, 150);
}

function parseGeneratedPost(raw: string): GeneratedPost {
  const match = raw.match(/\[HOOK\]\s*([\s\S]*?)\s*\[BODY\]\s*([\s\S]*)/);
  if (!match) {
    throw new Error(`Claude's response did not follow the [HOOK]/[BODY] format: ${raw.slice(0, 200)}`);
  }
  const [, hook, body] = match;
  // The model sometimes closes the sections with [/HOOK] / [/BODY]; those tags
  // must never reach a published post.
  const stripClosingTags = (text: string): string => text.replace(/\[\/(HOOK|BODY)\]/g, "").trim();
  return {
    hook: stripClosingTags(hook).slice(0, HOOK_MAX_LENGTH),
    body: stripClosingTags(body).slice(0, BODY_MAX_LENGTH),
  };
}

export async function generatePostText(
  product: Product,
  styleExamples: StyleExample[],
  style?: PostStyle,
  preferredPermalink?: string
): Promise<GeneratedPost> {
  const exampleToFollow = pickExampleToFollow(style, styleExamples, preferredPermalink);
  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: buildUserPrompt(product, styleExamples, style, exampleToFollow) }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude did not return text content");
  }

  const generated = parseGeneratedPost(textBlock.text.trim());
  if (style === "clone" && exampleToFollow?.imageUrl) {
    generated.cloneImageUrl = exampleToFollow.imageUrl;
  }
  return generated;
}

// "remix" (2026-10-01 owner decision, risk of reusing other users' images
// accepted by the owner): one trending post's own image(s) are attached to
// our post as-is, and Claude — shown those images, the post, and its reader
// comments — writes brand-new wording aimed at selling our product. Unlike
// "clone", the wording must be clearly our own; checked below.
const REMIX_MAX_OVERLAP = 12;
const REMIX_MAX_IMAGES_TO_CLAUDE = 4;

// 2026-10-03 owner decision: remix should repeat what made 10/2 20:00 work
// (2,909 views at ~3h) — an image of skincare products laid out by skin
// concern — and avoid what didn't (celebrity / person-centered photos: 182 and
// 254 views, plus portrait-rights risk). Claude looks at the images and says
// yes/no before a researched post is used as a remix source.
export async function isConcernProductImage(example: StyleExample): Promise<boolean> {
  const images = imageBlocks(example);
  if (images.length === 0) return false;
  // A one-word YES/NO judgment, so it runs on Haiku 4.5 (2026-10-05 owner
  // decision, to stretch API credit) instead of the model that writes posts.
  // Haiku 4.5 rejects output_config.effort, so none is sent.
  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 16,
    messages: [
      {
        role: "user",
        content: [
          ...images,
          {
            type: "text",
            text: "これらの画像について答えてください。画像の主役が「スキンケア・美容の商品(ボトルなど)」か「肌悩み別・成分別の表や比較」で、人物の顔がメインではない場合は YES、それ以外(人物の顔・芸能人・動画の人物の1コマ・食べ物・風景など)は NO。YES か NO の一語だけで答えてください。",
          },
        ],
      },
    ],
  } as Anthropic.MessageCreateParamsNonStreaming);
  const textBlock = response.content.find((block) => block.type === "text");
  return Boolean(textBlock && textBlock.type === "text" && /YES/i.test(textBlock.text));
}

function remixInstructions(example: StyleExample): string {
  const comments = (example.topComments ?? []).map((c) => `- ${c.text.replace(/\n+/g, " ")}`).join("\n");
  const authorReplies = (example.authorReplies ?? []).map((r) => `- ${r.replace(/\n+/g, " ")}`).join("\n");
  return `# 今回の型: 伸びている投稿のリミックス(必ずこの型で書き、他の型は混ぜない)
添付した画像は、下の「伸びている投稿」に実際に付いていた画像です。この画像は、あなたが書くフックと一緒に、そのまま新規投稿として投稿されます。

手順(考える過程は出力しない):
1. この投稿がなぜ伸びたかを考える。画像のどこで指が止まるか、書き出しのどこに引きがあるか、コメント欄の読者が何に反応し、何を知りたがっているか。
2. フックを書く。画像と自然にかみ合い、元の投稿が伸びた理由(感情の動き・引き・テンポ・改行のリズム)を活かす。ただし文言は完全に自分の言葉で書き直すこと。元の投稿と同じ文を使わない。${REMIX_MAX_OVERLAP}文字以上同じ並びを作らない。話の流れを、この商品が応えられる悩みへ自然につなげ、最後は答えが返信にあると分かる引きで終える。画像が悩み別・成分別の並びなら、フックも「悩み→成分」を1行ずつ並べる形にして、画像と読み合わせられるようにする。
3. 本文(返信)を書く。ここが商品を売る本編。コメント欄で読者が知りたがっていたこと・迷っていたことに先回りして答える形で、「商品名」→推しポイント(成分・使い方・使用感)→「☑︎こんな人に」→やわらかい一言、の流れで、読んだ人がリンクを押したくなるように書く。

画像についての決まり:
- 画像に写っている人物の名前を書かない。その人物がこの商品を使っている・すすめているとは書かない。
- 画像に写っている商品を、この商品だと偽らない。元の投稿が別の商品を紹介していても、その商品名や効果は書かない。
- 画像は「こういう肌になりたい」「こういう悩みがある」という雰囲気・きっかけとして使う。

## 伸びている投稿(いいね${example.likes ?? "?"}・返信${example.replies ?? "?"}・リポスト${example.reposts ?? "?"})
${example.text}
${authorReplies ? `\n## 投稿者自身の返信(続き)\n${authorReplies}\n` : ""}${comments ? `\n## コメント欄の読者の声\n${comments}\n` : ""}`;
}

function imageBlocks(example: StyleExample): Anthropic.ImageBlockParam[] {
  return (example.localImages ?? []).slice(0, REMIX_MAX_IMAGES_TO_CLAUDE).flatMap((path) => {
    if (!existsSync(path)) return [];
    const mediaType = path.endsWith(".png") ? "image/png" : "image/jpeg";
    return [{ type: "image" as const, source: { type: "base64" as const, media_type: mediaType, data: readFileSync(path).toString("base64") } }];
  });
}

// Longest run of identical characters (whitespace ignored) shared by a and b.
export function longestSharedRun(a: string, b: string): string {
  const x = a.replace(/\s+/g, "");
  const y = b.replace(/\s+/g, "");
  let best = "";
  let prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] === y[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best.length) best = x.slice(i - cur[j], i);
      }
    }
    prev = cur;
  }
  return best;
}

export async function generateRemixPost(product: Product, example: StyleExample): Promise<GeneratedPost> {
  const source = [example.text, ...(example.authorReplies ?? [])].join("\n");
  const basePrompt = `${remixInstructions(example)}
# 今回投稿する商品情報
商品名: ${product.name}
推しポイント:
${product.points.map((point) => `- ${point}`).join("\n")}

上記の型で、この商品のフックと本文を1組作成してください。`;

  let generated: GeneratedPost | undefined;
  let feedback = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: [...imageBlocks(example), { type: "text", text: basePrompt + feedback }] }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") throw new Error("Claude did not return text content");
    generated = parseGeneratedPost(textBlock.text.trim());

    const shared = longestSharedRun(`${generated.hook}\n${generated.body}`, source);
    if (shared.length < REMIX_MAX_OVERLAP) return generated;
    console.warn(`Remix attempt ${attempt}: ${shared.length} chars copied from the source ("${shared}").`);
    feedback = `\n\n注意: 前回の案は元の投稿と「${shared}」が同じ並びでした。この部分を含め、元の投稿の言い回しを使わず自分の言葉で書き直してください。`;
  }
  return generated!;
}

// ---------------------------------------------------------------------------
// "trend" (2026-10-07 owner decision): take a trending post, keep its images
// as they are, and introduce the very product it introduces — found on
// Rakuten and linked with our affiliate link — in our own words following its
// structure. Never a "similar" product: if the exact one can't be found on
// Rakuten, the post isn't used.

export interface FeaturedProduct {
  brand: string;
  name: string;
  keyword: string; // what to search Rakuten with
}

async function askHaiku(content: Anthropic.MessageParam["content"], maxTokens: number): Promise<string> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: maxTokens,
    messages: [{ role: "user", content }],
  } as Anthropic.MessageCreateParamsNonStreaming);
  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock && textBlock.type === "text" ? textBlock.text : "";
}

function parseJsonLoose<T>(raw: string): T | undefined {
  const match = raw.match(/[[{][\s\S]*[\]}]/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return undefined;
  }
}

// The products the post itself is introducing (brand + product name), read
// from its text, its author's follow-up replies and its images. Most
// important first, at most 3. Empty when no specific product is named.
export async function identifyFeaturedProducts(example: StyleExample): Promise<FeaturedProduct[]> {
  const text = [example.text, ...(example.authorReplies ?? [])].join("\n");
  const raw = await askHaiku(
    [
      ...imageBlocks(example),
      {
        type: "text",
        text: `次のThreadsの投稿(本文・投稿者の返信・画像)が紹介している、具体的なスキンケア・美容の商品を特定してください。
ブランド名と商品名の両方が本文か画像ではっきり分かるものだけを挙げ、推測で補わないこと。化粧品(スキンケア・メイク・ボディケア・ヘアケア)だけを対象とし、サプリメント・食品・飲み物・医薬品・美容機器は挙げないこと。紹介の中心になっている順に最大3つ。
JSON配列だけを出力: [{"brand":"ブランド名","name":"商品名","keyword":"楽天市場で検索する語(ブランド名 商品名)"}]
該当なしなら [] だけを出力。

## 投稿
${text}`,
      },
    ],
    400
  );
  const parsed = parseJsonLoose<FeaturedProduct[]>(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((p) => p && p.brand && p.name && p.keyword).slice(0, 3);
}

// Which Rakuten listing (if any) is the very same product — same brand and
// same product line (a different size or a set of it is fine); never a
// look-alike, a different line of the same brand, an empty container, or a
// used item. Returns the index into `items`, or undefined.
export async function pickSameRakutenItem(target: FeaturedProduct, items: RakutenItemSummary[]): Promise<number | undefined> {
  if (items.length === 0) return undefined;
  const list = items.map((item, i) => `${i}: ${item.name.slice(0, 120)}(${item.shopName}・${item.price}円・レビュー${item.reviewCount}件)`).join("\n");
  const raw = await askHaiku(
    [
      {
        type: "text",
        text: `探している商品: ${target.brand} ${target.name}

楽天市場の検索結果:
${list}

探している商品と「同じ商品」(同じブランド・同じ商品。容量違いやその商品のセットは可)の番号を1つ選んでください。似た別商品・同じブランドの別シリーズ・空容器・中古・サンプル品は不可。同じ商品が複数あれば、レビュー件数が多く公式・正規店らしいものを優先。
番号の数字だけを出力。該当なしなら NONE だけを出力。`,
      },
    ],
    16
  );
  const index = Number(raw.trim().match(/^\d+/)?.[0]);
  return Number.isInteger(index) && index >= 0 && index < items.length ? index : undefined;
}

export interface RakutenItemSummary {
  name: string;
  shopName: string;
  price: number;
  reviewCount: number;
  caption: string;
}

function trendInstructions(example: StyleExample, products: { target: FeaturedProduct; item: RakutenItemSummary }[], bodyMax: number): string {
  const comments = (example.topComments ?? []).map((c) => `- ${c.text.replace(/\n+/g, " ")}`).join("\n");
  const authorReplies = (example.authorReplies ?? []).map((r) => `- ${r.replace(/\n+/g, " ")}`).join("\n");
  const productInfo = products
    .map(
      ({ target, item }, i) =>
        `### 商品${i + 1}: ${target.brand} ${target.name}\n楽天の商品名: ${item.name}\n商品ページの説明(抜粋): ${item.caption.replace(/\s+/g, " ").slice(0, 600)}`
    )
    .join("\n\n");
  return `# 今回の型: 伸びている投稿と同じ商品を、自分の言葉で紹介する(必ずこの型で書き、他の型は混ぜない)
添付した画像は、下の「伸びている投稿」に実際に付いていた画像です。この画像は、あなたが書くフックと一緒に、そのまま新規投稿として投稿されます。
紹介する商品は、元の投稿が紹介しているのと同じ商品です(下の「紹介する商品」)。

手順(考える過程は出力しない):
1. この投稿がなぜ伸びたかを考える。画像のどこで指が止まるか、書き出しのどこに引きがあるか、コメント欄の読者が何に反応し、何を知りたがっているか。
2. フックを書く。元の投稿の構成(話の順番・改行のリズム・引き・テンポ)はそのまま活かし、画像と自然にかみ合わせる。ただし文言は完全に自分の言葉で書き直すこと。元の投稿と同じ文を使わない。${REMIX_MAX_OVERLAP}文字以上同じ並びを作らない。最後は答えが返信にあると分かる引きで終える。
3. 本文(返信)を書く。${bodyMax}文字以内。「商品名」→推しポイント→やわらかい一言、の流れ。コメント欄で読者が知りたがっていたことに先回りして答える。

商品についての決まり:
- 商品の特徴・成分として書いてよいのは、下の「商品ページの説明」に書かれていることだけ。
- 元の投稿者の体験(「◯日で変わった」など)を、自分の体験として書かない。
- 画像に写っている人物の名前を書かない。その人物がすすめているとは書かない。

## 伸びている投稿(いいね${example.likes ?? "?"}・返信${example.replies ?? "?"}・リポスト${example.reposts ?? "?"})
${example.text}
${authorReplies ? `\n## 投稿者自身の返信(続き)\n${authorReplies}\n` : ""}${comments ? `\n## コメント欄の読者の声\n${comments}\n` : ""}
## 紹介する商品
${productInfo}

上記の型で、フックと本文を1組作成してください。`;
}

export async function generateTrendPost(
  example: StyleExample,
  products: { target: FeaturedProduct; item: RakutenItemSummary }[],
  bodyMax: number
): Promise<GeneratedPost> {
  const source = [example.text, ...(example.authorReplies ?? [])].join("\n");
  const basePrompt = trendInstructions(example, products, bodyMax);
  let generated: GeneratedPost | undefined;
  let feedback = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: [...imageBlocks(example), { type: "text", text: basePrompt + feedback }] }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") throw new Error("Claude did not return text content");
    generated = parseGeneratedPost(textBlock.text.trim());

    const shared = longestSharedRun(`${generated.hook}\n${generated.body}`, source);
    if (shared.length < REMIX_MAX_OVERLAP) return generated;
    console.warn(`Trend attempt ${attempt}: ${shared.length} chars copied from the source ("${shared}").`);
    feedback = `\n\n注意: 前回の案は元の投稿と「${shared}」が同じ並びでした。この部分を含め、元の投稿の言い回しを使わず自分の言葉で書き直してください。`;
  }
  return generated!;
}
