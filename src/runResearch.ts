import { existsSync, readFileSync, writeFileSync } from "fs";
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

// 2026-09-19 owner decision: the recommended ("おすすめ") feed is the main
// research source, since it shows what Threads itself pushes to this
// account's beauty audience. Keyword search only fills in when the feed
// yields fewer than this many usable posts.
const FEED_SCROLLS = 60;
const MIN_FEED_POSTS_BEFORE_KEYWORD_FALLBACK = 3;
const MAX_AUTO_EXAMPLES = 8;
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

  const qualified: QualifiedPost[] = [];
  const seenPermalinks = new Set<string>();

  const adopt = async (candidate: CandidatePost): Promise<boolean> => {
    if (seenPermalinks.has(candidate.permalink)) return false;
    if (candidate.username === OWN_USERNAME) return false;
    const result = await inspectReplies(page, candidate);
    seenPermalinks.add(candidate.permalink);
    qualified.push(result);
    console.log(
      `  [採用] ${candidate.permalink} (いいね${candidate.likes}` +
        `${result.affiliateLinkResolved ? "・返信欄にアフィリエイトリンクあり" : ""})`
    );
    return true;
  };

  try {
    console.log("Reading the recommended (おすすめ) feed...");
    const feedCandidates = (await searchFeedCandidates(page, FEED_SCROLLS)).filter((c) => isBeautyRelated(c.text));
    console.log(`  -> ${feedCandidates.length} beauty-related post(s) in the feed meet the 7-day / 100+ likes conditions.`);
    feedCandidates.sort((a, b) => b.likes - a.likes);
    let feedAdopted = 0;
    for (const candidate of feedCandidates) {
      if (await adopt(candidate)) feedAdopted++;
    }

    if (feedAdopted >= MIN_FEED_POSTS_BEFORE_KEYWORD_FALLBACK) {
      console.log("  おすすめフィードだけで十分な件数が集まったため、キーワード検索は行いません。");
    } else {
      console.log("  おすすめフィードの件数が少ないため、キーワード検索で補います。");
      for (const keyword of keywords) {
        console.log(`Searching keyword "${keyword}"...`);
        const candidates = await searchKeywordCandidates(page, keyword);
        console.log(`  -> ${candidates.length} candidate(s) meet the 7-day / 100+ likes conditions.`);

        let matchedForKeyword = 0;
        for (const candidate of candidates) {
          if (await adopt(candidate)) matchedForKeyword++;
        }
        if (matchedForKeyword === 0) {
          console.log(`  条件(7日以内・いいね100以上)を満たす投稿が見つかりませんでした: "${keyword}"`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  qualified.sort((a, b) => b.likes - a.likes);
  qualified.splice(MAX_AUTO_EXAMPLES);

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
  const autoExamples: StyleExample[] = qualified.map((post) => ({
    text: post.text,
    source: "threads_browser_research",
    username: post.username,
    permalink: post.permalink,
    fetchedAt,
    keyword: post.keyword,
    postedAt: post.postedAt.toISOString(),
    likes: post.likes,
    replyCount: post.replyCount,
    matchedReplyText: post.matchedReplyText,
    affiliateLink: post.affiliateLinkResolved,
    imageUrl: post.imageUrl,
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
