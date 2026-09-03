import { readFileSync, writeFileSync } from "fs";
import { type StyleExample } from "./contentGenerator.js";
import { researchTrendingPosts } from "./threadsResearch.js";

const KEYWORDS_PATH = "data/research-keywords.json";
const STYLE_EXAMPLES_PATH = "data/style-examples.json";
const MAX_STORED_EXAMPLES = 30;
const LIMIT_PER_KEYWORD = 10;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

async function main(): Promise<void> {
  const keywords = readJson<string[]>(KEYWORDS_PATH);
  if (keywords.length === 0) {
    throw new Error("data/research-keywords.json is empty. Add at least one keyword.");
  }

  const trending = await researchTrendingPosts(keywords, LIMIT_PER_KEYWORD);
  console.log(`Fetched ${trending.length} candidate posts across ${keywords.length} keywords.`);

  const existing = readJson<StyleExample[]>(STYLE_EXAMPLES_PATH);
  // Drop old auto-collected entries and the placeholder "note" entry; keep any
  // manually curated examples the owner pasted in by hand.
  const manualExamples = existing.filter((example) => example.source !== "keyword_search" && !example.note);

  const fetchedAt = new Date().toISOString();
  const autoExamples: StyleExample[] = trending.slice(0, MAX_STORED_EXAMPLES).map((post) => ({
    text: post.text,
    source: "keyword_search",
    username: post.username,
    permalink: post.permalink,
    fetchedAt,
  }));

  const merged = [...manualExamples, ...autoExamples];
  writeFileSync(STYLE_EXAMPLES_PATH, JSON.stringify(merged, null, 2) + "\n");
  console.log(
    `Wrote ${merged.length} style examples (${manualExamples.length} manual + ${autoExamples.length} auto).`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
