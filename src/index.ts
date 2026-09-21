import { readFileSync, writeFileSync } from "fs";
import {
  generatePostText,
  generateQuestionPost,
  type PostStyle,
  type Product,
  type StyleExample,
} from "./contentGenerator.js";
import { hostCardOnGitHub } from "./cardHosting.js";
import { hasEnoughRows, parseCheatsheetRows, renderCheatsheetCard } from "./cardRenderer.js";
import { postToThreads, postReplyToThreads } from "./threadsClient.js";

const PRODUCTS_PATH = "data/products.json";
const STYLE_EXAMPLES_PATH = "data/style-examples.json";
const POSTED_LOG_PATH = "data/posted-log.json";
const RESEARCH_SETTINGS_PATH = "data/research-settings.json";

interface PostedLogEntry {
  productId: string;
  postedAt: string;
  threadsPostId: string;
  // Absent for question-only posts, which have no reply.
  threadsReplyId?: string;
}

type Slot = PostStyle | "question";

// 2026-09-21 owner decision: the first two posts of the day (8:00, 18:00) use
// the cheat-sheet style, which performed best; the rest follow a style picked
// from what the research found in the recommended feed. The earlier morning /
// decisive / steps / question styles are kept in the code but not scheduled;
// e.g. set 20 back to "question" to bring the question-only post back.
const SLOT_BY_JST_HOUR: Record<number, Slot> = {
  8: "cheatsheet",
  18: "cheatsheet",
  19: "feed",
  20: "feed",
  21: "feed",
};
const KNOWN_SLOTS = new Set<string>(["morning", "cheatsheet", "decisive", "question", "steps", "feed"]);

// Which post shape to use, decided by the Japan-time hour the run happens in
// (2026-09-19 owner decision: split the evening posts by type so they don't
// all read alike). Runs are often delayed 10-15 minutes by GitHub Actions,
// so the hour is a reliable key. `--slot=<name>` overrides it for dry runs;
// any other hour (e.g. a manual run) gets no forced type.
function pickSlot(): Slot | undefined {
  const override = process.argv.find((arg) => arg.startsWith("--slot="))?.slice("--slot=".length);
  if (override) {
    if (!KNOWN_SLOTS.has(override)) throw new Error(`Unknown --slot value: ${override}`);
    return override as Slot;
  }
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hourCycle: "h23" }).format(new Date())
  );
  return SLOT_BY_JST_HOUR[hour];
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

// A question-only post: no product, no link, no reply, no ad disclosure
// (nothing is being advertised). Meant to invite comments from followers.
async function runQuestionPost(dryRun: boolean, log: PostedLogEntry[]): Promise<void> {
  const text = await generateQuestionPost();
  console.log("=== Generated question post (no product, no link) ===");
  console.log(text);
  console.log("=================================================");

  if (dryRun) {
    console.log("Dry run: skipping actual post to Threads.");
    return;
  }

  const threadsPostId = await postToThreads(text);
  if (!threadsPostId) {
    throw new Error("Failed to obtain the post ID of the question post.");
  }
  console.log(`Posted question. threadsPostId=${threadsPostId}`);

  log.push({ productId: "engagement-question", postedAt: new Date().toISOString(), threadsPostId });
  writeFileSync(POSTED_LOG_PATH, JSON.stringify(log, null, 2) + "\n");
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const products = readJson<Product[]>(PRODUCTS_PATH);
  // Other-genre "structure only" examples can be switched off instantly here,
  // without waiting for the next research run (see data/research-settings.json).
  const researchSettings = readJson<{ includeOtherGenreStyles: boolean }>(RESEARCH_SETTINGS_PATH);
  const styleExamples = readJson<StyleExample[]>(STYLE_EXAMPLES_PATH).filter(
    (example) => example.genre !== "other" || researchSettings.includeOtherGenreStyles
  );
  const log = readJson<PostedLogEntry[]>(POSTED_LOG_PATH);

  if (products.length === 0) {
    throw new Error("data/products.json is empty. Add at least one product.");
  }

  const slot = pickSlot();
  console.log(`Post slot: ${slot ?? "(none - no forced style)"}`);
  if (slot === "question") {
    await runQuestionPost(dryRun, log);
    return;
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
  const { hook, body } = await generatePostText(product, styleExamples, slot);

  // Prefer a photo from one of this run's trending-post examples (adds
  // variety and matches what's currently resonating) over the product's own
  // fixed banner image; fall back to the product image if there is no
  // trending photo, or if the trending photo's URL has since expired (these
  // are hotlinked from Threads' own CDN, whose URLs are time-limited).
  // Cheat-sheet posts get a self-made card image of the table (2026-09-21 owner
  // decision). A failure to render or host it must never block the post: it
  // simply goes out without the card.
  let cardUrl: string | undefined;
  if (slot === "cheatsheet") {
    try {
      const rows = parseCheatsheetRows(hook);
      if (!hasEnoughRows(rows)) {
        console.log(`Card skipped: only ${rows.length} table row(s) found in the hook.`);
      } else if (dryRun) {
        const previewPath = await renderCheatsheetCard(rows, `cards/preview-${Date.now()}.png`);
        console.log(`Card preview rendered: ${previewPath}`);
      } else {
        const cardPath = await renderCheatsheetCard(rows, `cards/card-${Date.now()}.png`);
        cardUrl = await hostCardOnGitHub(cardPath);
        console.log(`Card hosted: ${cardUrl}`);
      }
    } catch (error) {
      console.warn(`Card skipped, posting without it: ${error instanceof Error ? error.message : error}`);
    }
  }

  const trendImageUrl = cardUrl ? undefined : pickTrendImageUrl(styleExamples);
  const attachedImageUrl = cardUrl ?? trendImageUrl;
  const imageUrl = attachedImageUrl ?? product.imageUrl;

  // The ad disclosure required by the stealth-marketing regulation (景品表示法)
  // lives in this reply rather than the new post's body (2026-09-17 owner
  // decision, made aware of the compliance risk that a reply-only disclosure
  // may not satisfy "readily recognizable to a general consumer" — see
  // 経営企画/事業計画.md). Plain lowercase "pr" trailing the link on the same
  // line, no "#" and no brackets: matches the convention observed on a real,
  // high-performing account in the same niche (2026-09-18 owner decision).
  // A leading "#" specifically must be avoided — Threads promotes it into a
  // topic-tag badge next to the poster's name, which is what motivated this
  // whole change in the first place. Full removal of any disclosure was
  // considered and rejected — that would be a clear-cut stealth-marketing
  // violation, not just a borderline one, so this is the floor.
  const replyText = `${body}\n\n${product.url} pr`;

  console.log("=== Generated hook (new post) ===");
  console.log(hook);
  console.log("=== Generated reply (body + affiliate link) ===");
  console.log(replyText);
  console.log("=================================================");
  console.log(
    `Image: ${imageUrl ?? "(none)"}${cardUrl ? " (self-made cheat-sheet card)" : trendImageUrl ? " (from a trending-post example)" : ""}`
  );

  if (dryRun) {
    console.log("Dry run: skipping actual post to Threads.");
    return;
  }

  // STEP 1: post the hook as a new top-level post.
  let threadsPostId: string;
  try {
    threadsPostId = await postToThreads(hook, imageUrl);
  } catch (error) {
    if (attachedImageUrl && imageUrl !== product.imageUrl) {
      console.warn(
        `Posting with the attached image failed (e.g. an expired or unreachable URL), retrying with the product image instead: ${
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
