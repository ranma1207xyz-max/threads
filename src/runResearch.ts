import { existsSync, readFileSync, writeFileSync } from "fs";
import { type StyleExample } from "./contentGenerator.js";
import {
  checkRepliesForAffiliateLink,
  launchBrowser,
  openAuthenticatedPage,
  searchKeywordCandidates,
  type QualifiedPost,
} from "./threadsScraper.js";

const KEYWORDS_PATH = "data/research-keywords.json";
const STYLE_EXAMPLES_PATH = "data/style-examples.json";

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

  try {
    for (const keyword of keywords) {
      console.log(`Searching keyword "${keyword}"...`);
      const candidates = await searchKeywordCandidates(page, keyword);
      console.log(`  -> ${candidates.length} candidate(s) meet the 3-day / 100+ likes conditions.`);

      let matchedForKeyword = 0;
      for (const candidate of candidates) {
        if (seenPermalinks.has(candidate.permalink)) continue;
        const result = await checkRepliesForAffiliateLink(page, candidate);
        if (result) {
          seenPermalinks.add(candidate.permalink);
          qualified.push(result);
          matchedForKeyword++;
          console.log(`  [採用] ${candidate.permalink} (いいね${candidate.likes})`);
        }
      }

      if (matchedForKeyword === 0) {
        console.log(
          `  条件(3日以内・いいね100以上・返信欄にアフィリエイトリンクあり)をすべて満たす投稿が見つかりませんでした: "${keyword}"`
        );
      }
    }
  } finally {
    await browser.close();
  }

  qualified.sort((a, b) => b.likes - a.likes);

  if (qualified.length === 0) {
    console.log("");
    console.log(
      "すべてのキーワードで、4条件(指定キーワード・3日以内・いいね100以上・返信欄にアフィリエイトリンクあり)を" +
        "すべて満たす投稿が見つかりませんでした。条件は緩めず、style-examples.json の自動収集分は今回0件のまま更新します。"
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
  }));

  const merged = [...manualExamples, ...autoExamples];
  writeFileSync(STYLE_EXAMPLES_PATH, JSON.stringify(merged, null, 2) + "\n");
  console.log(
    `Wrote ${merged.length} style examples (${manualExamples.length} manual + ${autoExamples.length} auto, ` +
      `all auto entries passed the 4 required conditions).`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
