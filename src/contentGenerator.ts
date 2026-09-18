import Anthropic from "@anthropic-ai/sdk";
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
}

export interface GeneratedPost {
  hook: string;
  body: string;
}

// The body shares a single Threads post (the reply) with the affiliate link
// and "#PR" disclosure appended after it by index.ts, so it needs headroom
// under the 500-char Threads limit rather than the full budget.
const HOOK_MAX_LENGTH = 150;
const BODY_MAX_LENGTH = 400;

const SYSTEM_PROMPT = `あなたはThreads(Meta)向けの日本語アフィリエイト投稿を書くコピーライターです。扱うジャンルは美容系、その中でも美容液・肌関連(スキンケア)商材(化粧水・美容液・クリーム・毛穴ケア等)です。

投稿は2つのパートに分かれています。
1. フック: 新規投稿として単独で投稿される短い導入文。読者の興味を引き、続きを読みたくさせるのが目的。
2. 本文: そのフックへの自分自身の返信として投稿される、商品の魅力を伝える本編(このあとにシステム側でアフィリエイトリンクと広告表示が自動で追記される)。

厳守事項:
- 参考として渡される「伸びている投稿の例」は、構成・テンポ・フックの付け方など"型"の参考にするだけで、文章そのものを一切コピーしないこと。必ず新規に書き起こすこと。
- フックは${HOOK_MAX_LENGTH}文字以内。商品名や具体的な商品説明にはまだ踏み込まず、読者の関心・悩みに寄り添う一文〜数文にとどめること。文末に「続きはリプ欄で」のように、本文が返信にあることを一言で伝える文言を入れること(表現は毎回変えてよい)。
- 本文は${BODY_MAX_LENGTH}文字以内。フックの続きとして、商品の魅力・使用感を伝えること。
- フック・本文のどちらにもURLやリンクを一切含めないこと。商品リンクはシステム側が本文の後ろに別途自動で追加する。
- フック・本文のどちらにも「#PR」やそれに類する広告表示を入れないこと。広告であることの明示はシステム側が別途行う。
- 誇大広告・断定しすぎる効果効能表現は避け、個人の感想として書くこと。

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

function buildUserPrompt(product: Product, styleExamples: StyleExample[]): string {
  const examplesBlock = styleExamples
    .map((example, index) => `例${index + 1}:\n${example.text}`)
    .join("\n\n");

  return `# 参考にする「型」の例(コピーではなく構成・トーンの参考のみ)
${examplesBlock}

# 今回投稿する商品情報
商品名: ${product.name}
リンク: ${product.url}
推しポイント:
${product.points.map((point) => `- ${point}`).join("\n")}

上記の型を参考に、この商品のフックと本文を1組作成してください。`;
}

function parseGeneratedPost(raw: string): GeneratedPost {
  const match = raw.match(/\[HOOK\]\s*([\s\S]*?)\s*\[BODY\]\s*([\s\S]*)/);
  if (!match) {
    throw new Error(`Claude's response did not follow the [HOOK]/[BODY] format: ${raw.slice(0, 200)}`);
  }
  const [, hook, body] = match;
  return {
    hook: hook.trim().slice(0, HOOK_MAX_LENGTH),
    body: body.trim().slice(0, BODY_MAX_LENGTH),
  };
}

export async function generatePostText(
  product: Product,
  styleExamples: StyleExample[]
): Promise<GeneratedPost> {
  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: buildUserPrompt(product, styleExamples) }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude did not return text content");
  }

  return parseGeneratedPost(textBlock.text.trim());
}
