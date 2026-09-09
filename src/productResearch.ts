import { readFileSync, writeFileSync } from "fs";
import { searchKeyword, type TrendingPost } from "./threadsResearch.js";

const KEYWORDS_PATH = "data/product-research-keywords.json";
const OUTPUT_PATH = "data/product-research-log.json";
const LIMIT_PER_KEYWORD = 15;

interface KeywordResult {
  keyword: string;
  status: "ok" | "error";
  postCount?: number;
  error?: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

async function main(): Promise<void> {
  const keywords = readJson<string[]>(KEYWORDS_PATH);
  if (keywords.length === 0) {
    throw new Error("data/product-research-keywords.json is empty. Add at least one keyword.");
  }

  const results: KeywordResult[] = [];
  const posts: TrendingPost[] = [];
  const seenIds = new Set<string>();

  for (const keyword of keywords) {
    try {
      const found = await searchKeyword(keyword, LIMIT_PER_KEYWORD);
      results.push({ keyword, status: "ok", postCount: found.length });
      console.log(`OK "${keyword}": ${found.length} posts`);
      for (const post of found) {
        if (!seenIds.has(post.id)) {
          seenIds.add(post.id);
          posts.push(post);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ keyword, status: "error", error: message });
      console.log(`ERROR "${keyword}": ${message}`);
    }
  }

  writeFileSync(
    OUTPUT_PATH,
    JSON.stringify({ fetchedAt: new Date().toISOString(), results, posts }, null, 2) + "\n"
  );

  const okCount = results.filter((r) => r.status === "ok").length;
  console.log(`Done: ${okCount}/${keywords.length} keywords succeeded, ${posts.length} unique posts fetched.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
