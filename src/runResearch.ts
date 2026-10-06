import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { type StyleExample } from "./contentGenerator.js";
import {
  inspectReplies,
  isBeautyRelated,
  launchBrowser,
  openAuthenticatedPage,
  searchFeedCandidates,
  searchKeywordCandidates,
  type CandidatePost,
  type QualifiedPost,
} from "./threadsScraper.js";

const KEYWORDS_PATH = "data/research-keywords.json";
const STYLE_EXAMPLES_PATH = "data/style-examples.json";
const SETTINGS_PATH = "data/research-settings.json";

// 2026-09-19 owner decision: viral posts from other genres that surface in the
// feed are collected too, but only as references for *structure* (opening
// lines, line breaks, cliffhangers) — never their topic or images. If the
// posts' performance drops, turning this off is the first thing to revert:
// set includeOtherGenreStyles to false in data/research-settings.json.
interface ResearchSettings {
  includeOtherGenreStyles: boolean;
  maxOtherGenreExamples: number;
}
// Topics we do not want anywhere near our prompt, even as "structure only".
const OTHER_GENRE_BLOCKLIST = [
  "移民", "外国人", "政治", "選挙", "自民", "立憲", "首相", "総理", "差別", "戦争", "殺", "死ね",
  "事故", "逮捕", "宗教", "ハゲ", "翻訳", "ネタバレ",
];
function isUsableOtherGenrePost(text: string): boolean {
  const length = text.trim().length;
  if (length < 30 || length > 600) return false;
  return !OTHER_GENRE_BLOCKLIST.some((word) => text.includes(word));
}

// 2026-09-19 owner decision: the recommended ("おすすめ") feed is the main
// research source, since it shows what Threads itself pushes to this
// account's beauty audience. Keyword search only fills in when the feed
// yields fewer than this many usable posts.
const FEED_SCROLLS = 60;
// 2026-10-01 owner decision: collect more (8 -> 20) so the daily "remix"
// posts (see index.ts) always have fresh image posts to choose from, and
// always add keyword search results rather than only as a fallback.
const MAX_AUTO_EXAMPLES = 20;
// Images are downloaded right away (Threads' CDN URLs expire within days) and
// committed under research-images/<JST date>/, served to Threads from
// raw.githubusercontent.com when a remix post uses them. Capped per run to
// keep the repository from growing too fast; older days are pruned.
const RESEARCH_IMAGES_DIR = "research-images";
const MAX_IMAGE_POSTS_PER_RUN = 10;
const MAX_IMAGES_PER_POST = 4;
const KEEP_IMAGE_DAYS = 14;

// Likes alone missed "everyone stopped scrolling" posts (our 231k-view hit had
// a 0.28% like rate), so reshares and replies count too.
function engagementScore(post: { likes: number; replies: number; reposts: number }): number {
  return post.likes + post.replies * 2 + post.reposts * 3;
}

function jstDate(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(date);
}

async function downloadImages(post: QualifiedPost, dir: string): Promise<string[]> {
  const saved: string[] = [];
  for (const [index, url] of post.imageUrls.slice(0, MAX_IMAGES_PER_POST).entries()) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !/image\/(jpeg|png)/.test(type)) {
        console.warn(`  image skipped (${response.status} ${type}): ${post.permalink}`);
        continue;
      }
      const path = `${dir}/${post.postId}-${index + 1}.${type.includes("png") ? "png" : "jpg"}`;
      writeFileSync(path, Buffer.from(await response.arrayBuffer()));
      saved.push(path);
    } catch (error) {
      console.warn(`  image download failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  return saved;
}

function pruneOldImages(): void {
  if (!existsSync(RESEARCH_IMAGES_DIR)) return;
  const cutoff = jstDate(new Date(Date.now() - KEEP_IMAGE_DAYS * 24 * 60 * 60 * 1000));
  for (const day of readdirSync(RESEARCH_IMAGES_DIR)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) {
      rmSync(`${RESEARCH_IMAGES_DIR}/${day}`, { recursive: true, force: true });
      console.log(`Pruned old research images: ${day}`);
    }
  }
}
// 2026-10-07 owner decision: a feed post no longer needs beauty words in its
// text — many product posts say only things like "Threads買いしたやつ!".
// Such posts are kept when their first image shows cosmetics/skincare
// (a one-word Haiku check), so unrelated viral posts still stay out.
const MAX_IMAGE_CHECKS = 30;

async function isBeautyImage(client: Anthropic, url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !/image\/(jpeg|png)/.test(type)) return false;
    const data = Buffer.from(await response.arrayBuffer()).toString("base64");
    const result = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 8,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: type.includes("png") ? "image/png" : "image/jpeg", data } },
            {
              type: "text",
              text: "この画像の主役は、化粧品(スキンケア・メイク・ボディケア・ヘアケアの商品)や、肌悩み・成分の表ですか? YES か NO の一語だけで答えてください。",
            },
          ],
        },
      ],
    });
    const block = result.content.find((b) => b.type === "text");
    return Boolean(block && block.type === "text" && /YES/i.test(block.text));
  } catch (error) {
    console.warn(`  image check failed: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

// Our own posting account; its posts appear in its own feed but are not research material.
const OWN_USERNAME = "bihada_biyoshitsu";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

async function main(): Promise<void> {
  const keywords = readJson<string[]>(KEYWORDS_PATH);
  if (keywords.length === 0) {
    throw new Error("data/research-keywords.json is empty. Add at least one keyword.");
  }

  const browser = await launchBrowser();
  const page = await openAuthenticatedPage(browser);

  const settings = readJson<ResearchSettings>(SETTINGS_PATH);
  const qualified: QualifiedPost[] = [];
  const otherGenre: QualifiedPost[] = [];
  const seenPermalinks = new Set<string>();

  const adopt = async (candidate: CandidatePost): Promise<boolean> => {
    if (seenPermalinks.has(candidate.permalink)) return false;
    if (candidate.username === OWN_USERNAME) return false;
    const result = await inspectReplies(page, candidate);
    seenPermalinks.add(candidate.permalink);
    qualified.push(result);
    console.log(
      `  [採用] ${candidate.permalink} (いいね${candidate.likes}・返信${candidate.replies}・リポスト${candidate.reposts}` +
        `・画像${candidate.imageUrls.length}枚${candidate.hasVideo ? "・動画" : ""}` +
        `${result.affiliateLinkResolved ? "・返信欄にアフィリエイトリンクあり" : ""})`
    );
    return true;
  };

  try {
    console.log("Reading the recommended (おすすめ) feed...");
    const allFeedCandidates = await searchFeedCandidates(page, FEED_SCROLLS);
    const textMatched = allFeedCandidates.filter((c) => isBeautyRelated(c.text));
    const imageMatched: CandidatePost[] = [];
    if (process.env.ANTHROPIC_API_KEY) {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const toCheck = allFeedCandidates
        .filter((c) => !isBeautyRelated(c.text) && c.imageUrls.length > 0 && c.username !== OWN_USERNAME)
        .sort((a, b) => engagementScore(b) - engagementScore(a))
        .slice(0, MAX_IMAGE_CHECKS);
      for (const candidate of toCheck) if (await isBeautyImage(client, candidate.imageUrls[0])) imageMatched.push(candidate);
      console.log(`  -> ${imageMatched.length} of ${toCheck.length} feed post(s) without beauty words kept for their cosmetics image.`);
    }
    const feedCandidates = [...textMatched, ...imageMatched];
    if (settings.includeOtherGenreStyles) {
      const others = allFeedCandidates
        .filter(
          (c) =>
            !isBeautyRelated(c.text) &&
            !imageMatched.includes(c) &&
            c.username !== OWN_USERNAME &&
            isUsableOtherGenrePost(c.text)
        )
        .sort((a, b) => b.likes - a.likes)
        .slice(0, settings.maxOtherGenreExamples);
      // Structure-only references: no reply inspection, and the photo is dropped
      // so an unrelated image can never end up on one of our posts.
      for (const candidate of others) {
        otherGenre.push({ ...candidate, imageUrl: undefined, imageUrls: [], replyCount: 0, topComments: [], authorReplies: [] });
      }
      console.log(`  -> ${otherGenre.length} other-genre post(s) kept as structure-only references.`);
    }
    console.log(`  -> ${feedCandidates.length} beauty-related post(s) in the feed meet the 7-day / 100+ likes conditions.`);

    // Feed first (what Threads pushes to this audience), then every keyword,
    // pooled and ranked together; only the top ones get their replies opened.
    const pool = new Map<string, CandidatePost>();
    for (const candidate of feedCandidates) pool.set(candidate.permalink, candidate);
    for (const keyword of keywords) {
      console.log(`Searching keyword "${keyword}"...`);
      const candidates = await searchKeywordCandidates(page, keyword);
      console.log(`  -> ${candidates.length} candidate(s) meet the 7-day / 100+ likes conditions.`);
      for (const candidate of candidates) if (!pool.has(candidate.permalink)) pool.set(candidate.permalink, candidate);
    }
    const ranked = Array.from(pool.values()).sort((a, b) => engagementScore(b) - engagementScore(a));
    for (const candidate of ranked) {
      if (qualified.length >= MAX_AUTO_EXAMPLES) break;
      await adopt(candidate);
    }
  } finally {
    await browser.close();
  }

  qualified.sort((a, b) => engagementScore(b) - engagementScore(a));
  qualified.splice(MAX_AUTO_EXAMPLES);

  pruneOldImages();
  const imageDir = `${RESEARCH_IMAGES_DIR}/${jstDate()}`;
  mkdirSync(imageDir, { recursive: true });
  const localImagesByPermalink = new Map<string, string[]>();
  for (const post of qualified.filter((p) => p.imageUrls.length > 0).slice(0, MAX_IMAGE_POSTS_PER_RUN)) {
    const saved = await downloadImages(post, imageDir);
    if (saved.length > 0) localImagesByPermalink.set(post.permalink, saved);
  }
  console.log(`Saved images for ${localImagesByPermalink.size} post(s) under ${imageDir}/.`);

  if (qualified.length === 0) {
    console.log("");
    console.log(
      "おすすめフィードでもキーワード検索でも、条件(7日以内・いいね100以上・美容関連)を" +
        "満たす投稿が見つかりませんでした。条件は緩めず、style-examples.json の自動収集分は今回0件のまま更新します。"
    );
  }

  const existing = existsSync(STYLE_EXAMPLES_PATH) ? readJson<StyleExample[]>(STYLE_EXAMPLES_PATH) : [];
  // Drop old auto-collected entries (both the old API-based ones and previous
  // browser-research runs) and the placeholder "note" entry; keep any
  // manually curated examples the owner pasted in by hand.
  const manualExamples = existing.filter(
    (example) => example.source !== "threads_browser_research" && example.source !== "keyword_search" && !example.note
  );

  const fetchedAt = new Date().toISOString();
  const autoExamples: StyleExample[] = [...qualified, ...otherGenre].map((post) => ({
    text: post.text,
    source: "threads_browser_research",
    username: post.username,
    permalink: post.permalink,
    fetchedAt,
    keyword: post.keyword,
    postedAt: post.postedAt.toISOString(),
    likes: post.likes,
    replies: post.replies,
    reposts: post.reposts,
    score: engagementScore(post),
    replyCount: post.replyCount,
    matchedReplyText: post.matchedReplyText,
    affiliateLink: post.affiliateLinkResolved,
    imageUrl: post.imageUrl,
    ...(post.imageUrls.length > 0 ? { imageUrls: post.imageUrls } : {}),
    ...(localImagesByPermalink.has(post.permalink) ? { localImages: localImagesByPermalink.get(post.permalink) } : {}),
    ...(post.hasVideo ? { hasVideo: true } : {}),
    ...(post.topComments.length > 0 ? { topComments: post.topComments } : {}),
    ...(post.authorReplies.length > 0 ? { authorReplies: post.authorReplies } : {}),
    ...(otherGenre.includes(post) ? { genre: "other" as const } : {}),
  }));

  const merged = [...manualExamples, ...autoExamples];
  writeFileSync(STYLE_EXAMPLES_PATH, JSON.stringify(merged, null, 2) + "\n");
  console.log(
    `Wrote ${merged.length} style examples (${manualExamples.length} manual + ${autoExamples.length} auto, ` +
      `all auto entries passed the 3 required conditions).`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
