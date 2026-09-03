import { config } from "./config.js";

const API_BASE = "https://graph.threads.net/v1.0";

export interface TrendingPost {
  id: string;
  text: string;
  username: string;
  permalink: string;
  timestamp: string;
}

interface KeywordSearchResponse {
  data?: Array<{
    id: string;
    text?: string;
    media_type: string;
    permalink: string;
    timestamp: string;
    username: string;
  }>;
}

const MIN_TEXT_LENGTH = 30;

async function searchKeyword(keyword: string, limit: number): Promise<TrendingPost[]> {
  const url = new URL(`${API_BASE}/keyword_search`);
  url.searchParams.set("q", keyword);
  url.searchParams.set("search_type", "TOP");
  url.searchParams.set("media_type", "TEXT");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("fields", "id,text,media_type,permalink,timestamp,username");
  url.searchParams.set("access_token", config.threadsAccessToken);

  const response = await fetch(url.toString());
  const body = (await response.json()) as KeywordSearchResponse;
  if (!response.ok) {
    throw new Error(`Threads keyword_search error (${response.status}) for "${keyword}": ${JSON.stringify(body)}`);
  }

  return (body.data ?? [])
    .filter((post) => (post.text ?? "").trim().length >= MIN_TEXT_LENGTH)
    .map((post) => ({
      id: post.id,
      text: post.text!.trim(),
      username: post.username,
      permalink: post.permalink,
      timestamp: post.timestamp,
    }));
}

// Threads keyword_search allows up to 2,200 queries per rolling 24h; a handful of
// keywords run once a day stays far under that, so no extra throttling here.
export async function researchTrendingPosts(
  keywords: string[],
  limitPerKeyword: number
): Promise<TrendingPost[]> {
  const results: TrendingPost[] = [];
  const seenIds = new Set<string>();

  for (const keyword of keywords) {
    const posts = await searchKeyword(keyword, limitPerKeyword);
    for (const post of posts) {
      if (!seenIds.has(post.id)) {
        seenIds.add(post.id);
        results.push(post);
      }
    }
  }

  return results;
}
