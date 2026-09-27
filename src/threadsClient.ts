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

// error_subcode 4279009 ("Media Not Found") is a known Threads-side race
// condition, not a real problem with the container: threads_publish can
// 400 for a few seconds even after the container's own status already
// reports FINISHED, because the publish step hasn't caught up with it yet
// internally. waitForContainerFinished alone wasn't enough to prevent this
// — confirmed 2026-09-27, when it hit the 21:00 carousel post: the publish
// failed this way, the code's existing fallback silently retried as a
// text-only post (no image at all), and the owner had to point out the
// missing image before this was noticed. Retrying the publish itself a few
// times fixes it (same approach other Threads client libraries use for
// this exact error code).
function isMediaNotReadyError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('"error_subcode":4279009');
}

async function publishWithRetry(creationId: string): Promise<any> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await graphPost(`${config.threadsUserId}/threads_publish`, { creation_id: creationId });
    } catch (error) {
      if (!isMediaNotReadyError(error) || attempt === maxAttempts) throw error;
      console.warn(`threads_publish reported "Media Not Found" (attempt ${attempt}/${maxAttempts}), retrying...`);
      await sleep(3000);
    }
  }
  // Unreachable (the loop above always returns or throws), but keeps TypeScript happy.
  throw new Error("publishWithRetry: exhausted attempts without returning or throwing.");
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

// Polls a media container's processing status until Threads reports it
// FINISHED (ready to publish/reference), instead of assuming a fixed delay is
// always enough. A single image container was usually done well within the
// old blind 5s sleep, but a carousel's per-item containers had no wait at
// all before being referenced as `children` — on 2026-09-25's first real
// carousel post, this meant the parent container (and the post it produced)
// went out with the images still not attached, even though the API reported
// success throughout (bug found 2026-09-27, owner confirmed on Threads that
// the images never appeared).
// Docs: https://developers.facebook.com/docs/threads/threads-media/overview
async function waitForContainerFinished(containerId: string): Promise<void> {
  const maxAttempts = 20; // 20 x 3s = up to 60s, generous for an image download+validate.
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // The Threads API's field for this is `status` (values: IN_PROGRESS,
    // FINISHED, ERROR, EXPIRED, PUBLISHED) plus `error_message` on failure.
    // An earlier version of this function queried `status_code`, which does
    // not exist on this API (that name is from Instagram's similarly-shaped
    // container status field, not Threads') and made every post fail with
    // "Tried accessing nonexisting field (status_code)" -- caught after it
    // broke 2026-09-27's 8:00 post (fixed same day).
    const result = await graphGet(containerId, { fields: "status,error_message" });
    if (result.status === "FINISHED") return;
    if (result.status === "ERROR" || result.status === "EXPIRED") {
      throw new Error(
        `Container ${containerId} failed to process: status=${result.status}${
          result.error_message ? ` (${result.error_message})` : ""
        }`
      );
    }
    await sleep(3000);
  }
  throw new Error(`Container ${containerId} did not finish processing within ${maxAttempts * 3}s.`);
}

async function createAndPublishContainer(containerParams: Record<string, string>): Promise<string> {
  const container = await graphPost(`${config.threadsUserId}/threads`, containerParams);

  await waitForContainerFinished(container.id);

  const published = await publishWithRetry(container.id);

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
    // Each item must finish downloading/validating its image before the
    // parent CAROUSEL container is allowed to reference it as a child —
    // this wait was missing entirely, which is what let 2026-09-25's
    // carousel post go out with no images attached (see the note above
    // createAndPublishContainer).
    await waitForContainerFinished(item.id);
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
