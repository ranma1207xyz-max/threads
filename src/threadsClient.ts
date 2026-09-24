import { config } from "./config.js";

const API_BASE = "https://graph.threads.net/v1.0";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function graphPost(path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("access_token", config.threadsAccessToken);

  const response = await fetch(url.toString(), { method: "POST" });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Threads API error (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function graphGet(path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("access_token", config.threadsAccessToken);

  const response = await fetch(url.toString());
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Threads API error (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function createAndPublishContainer(containerParams: Record<string, string>): Promise<string> {
  const container = await graphPost(`${config.threadsUserId}/threads`, containerParams);

  // Meta recommends a short pause before publishing to let the container finish processing.
  await sleep(5000);

  const published = await graphPost(`${config.threadsUserId}/threads_publish`, {
    creation_id: container.id,
  });

  return published.id;
}

// Two-step publish flow required by the Threads API:
// 1. create a media container, 2. publish that container.
export async function postToThreads(text: string, imageUrl?: string): Promise<string> {
  const containerParams: Record<string, string> = imageUrl
    ? { media_type: "IMAGE", image_url: imageUrl, text }
    : { media_type: "TEXT", text };

  return createAndPublishContainer(containerParams);
}

// A carousel (multiple photos swipeable in one post — e.g. a "1/2, 2/2" post,
// matching how a reference post the owner shared showed two photos together;
// 2026-09-25 owner decision). Threads' API needs each photo created as its
// own "carousel item" container first (not published individually), then a
// parent CAROUSEL container listing them via `children` in the given order,
// which is the one that actually gets published.
export async function postCarouselToThreads(text: string, imageUrls: string[]): Promise<string> {
  if (imageUrls.length < 2) {
    throw new Error(`postCarouselToThreads needs at least 2 images, got ${imageUrls.length}.`);
  }
  const itemIds: string[] = [];
  for (const imageUrl of imageUrls) {
    const item = await graphPost(`${config.threadsUserId}/threads`, {
      media_type: "IMAGE",
      image_url: imageUrl,
      is_carousel_item: "true",
    });
    itemIds.push(item.id);
  }
  return createAndPublishContainer({
    media_type: "CAROUSEL",
    children: itemIds.join(","),
    text,
  });
}

// Posts a self-reply to an existing Threads post. Uses the same two-step
// container+publish flow as postToThreads, with reply_to_id set to the
// parent post's ID (the Threads API's documented way to attach a reply).
export async function postReplyToThreads(text: string, replyToId: string): Promise<string> {
  return createAndPublishContainer({
    media_type: "TEXT",
    text,
    reply_to_id: replyToId,
  });
}

export interface ThreadsInsights {
  views?: number;
  likes?: number;
  replies?: number;
  reposts?: number;
  quotes?: number;
  shares?: number;
}

const INSIGHT_METRICS = ["views", "likes", "replies", "reposts", "quotes", "shares"];

// Fetches lifetime-to-date engagement metrics for a single Threads post via
// the Insights endpoint. Requires the threads_manage_insights scope on the
// access token.
export async function getMediaInsights(mediaId: string): Promise<ThreadsInsights> {
  const body = await graphGet(`${mediaId}/insights`, { metric: INSIGHT_METRICS.join(",") });

  const insights: ThreadsInsights = {};
  for (const item of body.data ?? []) {
    const value = item.values?.[0]?.value;
    if (typeof value === "number" && INSIGHT_METRICS.includes(item.name)) {
      insights[item.name as keyof ThreadsInsights] = value;
    }
  }
  return insights;
}
