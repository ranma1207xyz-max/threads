import { readFileSync, writeFileSync } from "fs";
import { generatePostText, type Product, type StyleExample } from "./contentGenerator.js";
import { postToThreads, postReplyToThreads } from "./threadsClient.js";

const PRODUCTS_PATH = "data/products.json";
const STYLE_EXAMPLES_PATH = "data/style-examples.json";
const POSTED_LOG_PATH = "data/posted-log.json";

interface PostedLogEntry {
  productId: string;
  postedAt: string;
  threadsPostId: string;
  threadsReplyId: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

// Picks a random image from among this run's style examples that have one
// (i.e. the trending posts they were scraped from had a photo attached).
// These are other users' own photos, hotlinked directly with the owner's
// informed sign-off on the copyright risk (see 経営企画/事業計画.md) rather
// than an AI-generated substitute — kept as a separate, swappable step in
// case that decision changes later.
function pickTrendImageUrl(styleExamples: StyleExample[]): string | undefined {
  const withImages = styleExamples.filter((example) => example.imageUrl);
  if (withImages.length === 0) return undefined;
  return withImages[Math.floor(Math.random() * withImages.length)].imageUrl;
}

function pickNextProduct(products: Product[], log: PostedLogEntry[]): Product {
  const lastPostedAt = new Map<string, string>();
  for (const entry of log) {
    lastPostedAt.set(entry.productId, entry.postedAt);
  }

  const sorted = [...products].sort((a, b) => {
    const aTime = lastPostedAt.get(a.id) ?? "";
    const bTime = lastPostedAt.get(b.id) ?? "";
    return aTime.localeCompare(bTime);
  });

  return sorted[0];
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const products = readJson<Product[]>(PRODUCTS_PATH);
  const styleExamples = readJson<StyleExample[]>(STYLE_EXAMPLES_PATH);
  const log = readJson<PostedLogEntry[]>(POSTED_LOG_PATH);

  if (products.length === 0) {
    throw new Error("data/products.json is empty. Add at least one product.");
  }

  const product = pickNextProduct(products, log);

  // The affiliate link must never end up in the new post itself — it is only
  // ever posted as a reply (STEP 3 below). Fail fast if a product has no
  // link, since posting a hook that can never be followed by its reply
  // would be pointless.
  if (!product.url) {
    throw new Error(`Product ${product.id} has no url (affiliate link). Aborting before posting.`);
  }

  // The new post carries only the short hook; the persuasive body text goes
  // into the self-reply alongside the affiliate link (2026-09-18 owner
  // decision), instead of the whole thing living in the new post as before.
  const { hook, body } = await generatePostText(product, styleExamples);

  // Prefer a photo from one of this run's trending-post examples (adds
  // variety and matches what's currently resonating) over the product's own
  // fixed banner image; fall back to the product image if there is no
  // trending photo, or if the trending photo's URL has since expired (these
  // are hotlinked from Threads' own CDN, whose URLs are time-limited).
  const trendImageUrl = pickTrendImageUrl(styleExamples);
  const imageUrl = trendImageUrl ?? product.imageUrl;

  // The ad disclosure required by the stealth-marketing regulation (景品表示法)
  // lives in this reply rather than the new post's body (2026-09-17 owner
  // decision, made aware of the compliance risk that a reply-only disclosure
  // may not satisfy "readily recognizable to a general consumer" — see
  // 経営企画/事業計画.md). Deliberately "[PR]", not "#PR": a leading "#"
  // gets promoted by Threads into a topic-tag badge next to the poster's
  // name (and is itself stripped from the inline text), which is exactly
  // the visual the owner asked to get rid of (2026-09-18).
  const replyText = `${body}\n\n[PR]\n${product.url}`;

  console.log("=== Generated hook (new post) ===");
  console.log(hook);
  console.log("=== Generated reply (body + affiliate link) ===");
  console.log(replyText);
  console.log("=================================================");
  console.log(`Image: ${imageUrl ?? "(none)"}${trendImageUrl ? " (from a trending-post example)" : ""}`);

  if (dryRun) {
    console.log("Dry run: skipping actual post to Threads.");
    return;
  }

  // STEP 1: post the hook as a new top-level post.
  let threadsPostId: string;
  try {
    threadsPostId = await postToThreads(hook, imageUrl);
  } catch (error) {
    if (trendImageUrl && imageUrl !== product.imageUrl) {
      console.warn(
        `Posting with the trending-post image failed (likely an expired URL), retrying with the product image instead: ${
          error instanceof Error ? error.message : error
        }`
      );
      threadsPostId = await postToThreads(hook, product.imageUrl);
    } else {
      throw error;
    }
  }
  if (!threadsPostId) {
    throw new Error("Failed to obtain the post ID of the new Threads post. Skipping the reply.");
  }
  console.log(`STEP 1 done: posted hook to Threads. threadsPostId=${threadsPostId}`);

  // STEP 2: the post we just created above (threadsPostId) IS our own post
  // to reply to — no separate lookup is needed or performed.
  // STEP 3: reply to that exact post with the body text, ad disclosure, and
  // affiliate link together.
  const threadsReplyId = await postReplyToThreads(replyText, threadsPostId);
  if (!threadsReplyId) {
    throw new Error(
      `Failed to obtain the reply ID after replying to threadsPostId=${threadsPostId}.`
    );
  }
  console.log(`STEP 3 done: posted affiliate link as a reply. threadsReplyId=${threadsReplyId}`);

  log.push({
    productId: product.id,
    postedAt: new Date().toISOString(),
    threadsPostId,
    threadsReplyId,
  });
  writeFileSync(POSTED_LOG_PATH, JSON.stringify(log, null, 2) + "\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
