import { readFileSync, writeFileSync } from "fs";
import { researchTrendingPosts } from "./threadsResearch.js";

const KEYWORDS_PATH = "data/product-research-keywords.json";
const OUTPUT_PATH = "data/product-research-log.json";
const LIMIT_PER_KEYWORD = 15;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

async function main(): Promise<void> {
  const keywords = readJson<string[]>(KEYWORDS_PATH);
  if (keywords.length === 0) {
    throw new Error("data/product-research-keywords.json is empty. Add at least one keyword.");
  }

  const posts = await researchTrendingPosts(keywords, LIMIT_PER_KEYWORD);
  console.log(`Fetched ${posts.length} candidate posts across ${keywords.length} keywords.`);

  writeFileSync(
    OUTPUT_PATH,
    JSON.stringify({ fetchedAt: new Date().toISOString(), keywords, posts }, null, 2) + "\n"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
