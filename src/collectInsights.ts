import { existsSync, readFileSync, writeFileSync } from "fs";
import { getMediaInsights, type ThreadsInsights } from "./threadsClient.js";

const POSTED_LOG_PATH = "data/posted-log.json";
const INSIGHTS_LOG_PATH = "data/insights-log.json";

// Only re-check posts from the last N days. Older posts accumulate views far
// more slowly, and re-fetching every historical post on every run would make
// this scale unboundedly with the size of posted-log.json.
const LOOKBACK_DAYS = 30;

interface PostedLogEntry {
  productId: string;
  postedAt: string;
  threadsPostId: string;
  threadsReplyId?: string;
}

interface InsightSnapshot extends ThreadsInsights {
  productId: string;
  threadsPostId: string;
  postedAt: string;
  capturedAt: string;
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

async function main(): Promise<void> {
  const postedLog = readJson<PostedLogEntry[]>(POSTED_LOG_PATH, []);
  const insightsLog = readJson<InsightSnapshot[]>(INSIGHTS_LOG_PATH, []);

  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const targets = postedLog.filter((entry) => new Date(entry.postedAt).getTime() >= cutoff);

  const capturedAt = new Date().toISOString();
  let failures = 0;

  for (const entry of targets) {
    try {
      const insights = await getMediaInsights(entry.threadsPostId);
      insightsLog.push({
        productId: entry.productId,
        threadsPostId: entry.threadsPostId,
        postedAt: entry.postedAt,
        capturedAt,
        ...insights,
      });
      console.log(`Collected insights for ${entry.threadsPostId}:`, insights);
    } catch (error) {
      failures++;
      console.error(`Failed to fetch insights for ${entry.threadsPostId}:`, error);
    }
  }

  writeFileSync(INSIGHTS_LOG_PATH, JSON.stringify(insightsLog, null, 2) + "\n");

  // A single post failing (e.g. deleted, or a transient API error) shouldn't
  // fail the whole run; only fail loudly if every target failed.
  if (targets.length > 0 && failures === targets.length) {
    throw new Error("Failed to fetch insights for all targeted posts.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
