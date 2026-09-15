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
}

const SYSTEM_PROMPT = `あなたはThreads(Meta)向けの日本語アフィリエイト投稿を書くコピーライターです。扱うジャンルは美容系、その中でも美容液・肌関連(スキンケア)商材(化粧水・美容液・クリーム・毛穴ケア等)です。

厳守事項:
- 参考として渡される「伸びている投稿の例」は、構成・テンポ・フックの付け方など"型"の参考にするだけで、文章そのものを一切コピーしないこと。必ず新規に書き起こすこと。
- 本文は500文字以内(Threadsの上限)。
- 本文中にはURLやリンクを一切含めないこと。商品リンクは本文ではなく、この投稿への自分自身の返信(コメント)として別途投稿するため、本文に書いてはいけない。
- 本文の最後に、詳細やリンクが返信(コメント)欄にあることを一言で伝える文言を入れること(例:「詳細はコメント欄に置いておきます」。表現は毎回変えてよい)。
- アフィリエイト/広告であることが一目でわかるよう、本文中に「#PR」を必ず含めること(景品表示法のステマ規制対応のため省略不可)。
- 誇大広告・断定しすぎる効果効能表現は避け、個人の感想として書くこと。

薬機法(医薬品医療機器等法)に基づく厳守事項(美容ジャンルのため必須):
- 「治る」「完治」「改善する」など医薬品的な効能効果を断定しないこと。
- 「シミが消える」「シワがなくなる」「痩せる」「-5kg」など、身体的変化を断定・数値で保証する表現をしないこと。
- 化粧品の効能効果の範囲(清潔にする、潤いを与える等)を超えた治療的な表現をしないこと。医薬部外品でない限り「美白」「ニキビを治す」等の限定効能表現も避けること。
- 医師・専門家を騙ったり、権威付けで効果を保証する表現をしないこと。
- 効果は必ず「個人の感想」の範囲(「〜と感じた」「〜な気がする」等)にとどめ、一般的な効能の断定は避けること。
- 出力は投稿本文のみ。前置きや説明、マークダウンの装飾は一切つけないこと。`;

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

上記の型を参考に、この商品の新規のThreads投稿文を1本作成してください。`;
}

export async function generatePostText(
  product: Product,
  styleExamples: StyleExample[]
): Promise<string> {
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

  const text = textBlock.text.trim();
  if (text.length > config.maxPostLength) {
    return text.slice(0, config.maxPostLength);
  }
  return text;
}
