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

// Two-step publish flow required by the Threads API:
// 1. create a media container, 2. publish that container.
export async function postToThreads(text: string, imageUrl?: string): Promise<string> {
  const containerParams: Record<string, string> = imageUrl
    ? { media_type: "IMAGE", image_url: imageUrl, text }
    : { media_type: "TEXT", text };

  const container = await graphPost(`${config.threadsUserId}/threads`, containerParams);

  // Meta recommends a short pause before publishing to let the container finish processing.
  await sleep(5000);

  const published = await graphPost(`${config.threadsUserId}/threads_publish`, {
    creation_id: container.id,
  });

  return published.id;
}
