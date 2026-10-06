import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import {
  generatePostText,
  generateQuestionPost,
  generateRemixPost,
  generateTrendPost,
  identifyFeaturedProducts,
  isConcernProductImage,
  pickSameRakutenItem,
  type FeaturedProduct,
  type PostStyle,
  type Product,
  type StyleExample,
} from "./contentGenerator.js";
import { hostCardOnGitHub } from "./cardHosting.js";
import {
  hasEnoughPanels,
  hasEnoughRows,
  parseCheatsheetRows,
  parseComboPanels,
  renderCheatsheetCard,
  renderComboCard,
} from "./cardRenderer.js";
import { postToThreads, postCarouselToThreads, postReplyToThreads } from "./threadsClient.js";
import { hasRakutenApiConfig, searchRakutenItems, type RakutenItem } from "./rakutenItems.js";

const PRODUCTS_PATH = "data/products.json";
const STYLE_EXAMPLES_PATH = "data/style-examples.json";
const POSTED_LOG_PATH = "data/posted-log.json";
const RESEARCH_SETTINGS_PATH = "data/research-settings.json";
const OWN_IMAGES_DIR = "images";

interface PostedLogEntry {
  productId: string;
  postedAt: string;
  threadsPostId: string;
  // Absent for question-only posts, which have no reply.
  threadsReplyId?: string;
  // File name(s) (inside images/) of the owner-supplied image(s) attached, if
  // any — more than one when it was posted as a carousel.
  ownImageFiles?: string[];
  // "remix" posts: the researched post whose image(s) and comments were used,
  // so the same one is never remixed twice.
  sourcePermalink?: string;
  researchImages?: string[];
  // The self-made cheat-sheet card's public URL, when one was attached — so
  // card posts can be told apart from image-free ones when comparing views.
  cardImage?: string;
  // The scheduled slot (JST date + hour) this post filled, so a backup run of
  // the same slot can see it is already done (scripts/slot-guard.mjs).
  slotDate?: string;
  slotHour?: number;
  // "trend" posts: the Rakuten listing that was linked.
  rakutenItemCode?: string;
}

type Slot = PostStyle | "question" | "trend";

// 2026-09-26 owner decision: all 5 daily posts now use the cheat-sheet style.
// Insight data from 9/21 onward showed it far ahead of every other style
// (avg views: 8:00=491, 18:00=1,579 vs. the "feed" style's 19:00=220,
// 20:00=395, 21:00=142 — see リサーチ・投稿分析/変更ログ.md), so the owner
// asked to lean into it everywhere instead of splitting the evening by type.
// The earlier morning / decisive / steps / feed / question styles are kept in
// the code but not scheduled; e.g. set 20 back to "question" to bring the
// question-only post back, or back to "feed" etc. per the pre-9/26 mapping.
// "remix" (2026-10-01): a trending post's own image(s) + our own rewritten
// wording aimed at selling our product (see contentGenerator.ts). A remix hour
// with no usable researched post falls back to cheatsheet.
// 2026-10-01 owner decision on images per hour: 8:00 unchanged (cheatsheet,
// no image); 18:00/22:00 our own image (the self-made cheat-sheet card, see
// cheatsheetCardHours in data/research-settings.json); 20:00/21:00 a quoted
// image from a trending post, written as "remix". The 20:00/21:00 A/B test
// (recurringStorySlots, planned through 10/3) was ended early for this.
// 19:00 moved to 22:00 the same day: its median views at ~24h were 109, about
// a quarter of 18:00/20:00 (see .github/workflows/post.yml for the schedule).
// 2026-10-03 owner decision: 6 posts a day. Four "concern" posts (8/18/20/22 —
// 10/2 20:00's remix of an Anua by-concern photo grid hit 2,909 views in ~3h)
// plus two other trending types, one each: 12:00 (new) "translate", 21:00
// "surprise" (21:00's remixes of person photos had drawn 182/254 views).
// 20:00's remix only uses researched posts whose images are skincare products
// or a by-concern chart (pickRemixExample), else falls back to the card.
// 2026-10-07 owner decision: only two types stay — "remix" (the one type with
// repeat hits: 35,625 / 18,588 views) and "cheatsheet". "translate" (12:00),
// "combo" (18:00) and "surprise" (21:00) had no post above ~650 views and are
// off the timetable for now; their code is kept so they can come back.
const SLOT_BY_JST_HOUR: Record<number, Slot> = {
  8: "cheatsheet",
  12: "cheatsheet",
  18: "cheatsheet",
  20: "remix",
  21: "cheatsheet",
  22: "cheatsheet",
};

// The JST hour of the slot this run belongs to. Scheduled runs get it from
// scripts/slot-guard.mjs (SLOT_JST_HOUR, taken from the cron line that fired
// the run), so a run GitHub delayed past the hour still posts its own slot's
// type (2026-10-07). Manual runs fall back to the clock.
function currentJstHour(): number {
  if (process.env.SLOT_JST_HOUR) return Number(process.env.SLOT_JST_HOUR);
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hourCycle: "h23" }).format(new Date())
  );
}
const KNOWN_SLOTS = new Set<string>([
  "morning",
  "cheatsheet",
  "decisive",
  "question",
  "steps",
  "feed",
  "clone",
  "remix",
  "translate",
  "surprise",
  "combo",
  "trend",
]);

// Which post shape to use, decided by the Japan-time hour the run happens in
// (2026-09-19 owner decision: split the evening posts by type so they don't
// all read alike). GitHub Actions can delay runs by hours, so the hour comes
// from the schedule that fired the run (see currentJstHour). `--slot=<name>`
// overrides it for dry runs; any other hour (e.g. a manual run) gets no
// forced type.
function pickSlot(): Slot | undefined {
  const override = process.argv.find((arg) => arg.startsWith("--slot="))?.slice("--slot=".length);
  if (override) {
    if (!KNOWN_SLOTS.has(override)) throw new Error(`Unknown --slot value: ${override}`);
    return override as Slot;
  }
  return SLOT_BY_JST_HOUR[currentJstHour()];
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

// Shared by the one-time overrides below (owner-supplied image, owner-fixed
// text): true only during the specific JST date+hour the owner configured for
// that override in data/research-settings.json, so each is scoped to one
// specific post rather than a standing behavior for every future run. The
// window naturally stops matching once that hour has passed, so no cleanup is
// needed afterward; to use it again later, the owner sets a new date/hour.
function isJstMoment(config: { date: string; hour: number }): boolean {
  const now = new Date();
  const jstDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(now);
  const jstHour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hourCycle: "h23" }).format(now)
  );
  return jstDate === config.date && jstHour === config.hour;
}

// A/B test (2026-09-27 owner decision, revised several times same day before
// it ever ran: originally alternate-by-day-parity at 21:00 only; then split
// into 20:00 [normal cheat-sheet, no config needed] vs. 21:00 [fixed "story"
// template] for one week; then pinned to a single product for the whole
// window so only the post *type* is being tested, not the product too; then
// the owner asked for 7 distinct day-by-day wordings instead of repeating the
// exact same post all week, worried that would look stale to followers
// checking daily — each keeps the same proven structure/tone, only the
// opening situation and the closing feeling-word differ). `productId`
// overrides the normal rotation for this one slot only — the other 4 daily
// slots keep alternating normally, unaffected. `images` (2+ = carousel) is
// shared across every day in the window; only the wording varies by date.
interface RecurringStoryVariant {
  date: string; // JST calendar date, YYYY-MM-DD — the one day this wording is used
  hook: string;
  body: string;
}
interface RecurringStorySlotConfig {
  hour: number;
  startDate: string; // JST calendar date, YYYY-MM-DD, inclusive
  endDate: string; // JST calendar date, YYYY-MM-DD, inclusive
  productId: string; // fixed product for every post in this window (overrides pickNextProduct)
  variants: RecurringStoryVariant[]; // one entry per date in [startDate, endDate]
  // File name(s) inside images/ to attach, in order (2+ = carousel).
  images?: string[];
}
function isRecurringStoryMoment(config: RecurringStorySlotConfig): boolean {
  const now = new Date();
  const jstHour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hourCycle: "h23" }).format(now)
  );
  if (jstHour !== config.hour) return false;
  const jstDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(now);
  return jstDate >= config.startDate && jstDate <= config.endDate;
}
// Today's specific wording within the window. Separate from
// isRecurringStoryMoment (which only checks the hour/date range) so a missing
// variant for today is its own clear error rather than silently falling
// through to AI generation, which would defeat the point of the test.
function todaysRecurringStoryVariant(config: RecurringStorySlotConfig): RecurringStoryVariant {
  const jstDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
  const variant = config.variants.find((v) => v.date === jstDate);
  if (!variant) {
    throw new Error(`recurringStorySlot has no variant for today (${jstDate}). Add one to data/research-settings.json.`);
  }
  return variant;
}

// Each override is a list so more than one specific post (e.g. today's 20:00
// AND 21:00) can each have their own one-time setup at the same time, without
// one overwriting the other. Returns the entry whose date+hour matches right
// now, if any — normally at most one ever matches.
function findJstMoment<T extends { date: string; hour: number }>(entries?: T[]): T | undefined {
  return entries?.find(isJstMoment);
}

// One week's trial (2026-09-28 owner decision) of the "clone" style (see
// contentGenerator.ts) at specific hours, without touching SLOT_BY_JST_HOUR's
// normal cheatsheet mapping directly — the window closing on its own (like
// recurringStorySlots) needs no cleanup step. Scoped to hours *not* already
// claimed by recurringStorySlots' 20:00/21:00 A/B test running the same week,
// so the two experiments don't collide.
interface CloneStyleWindowConfig {
  startDate: string; // JST calendar date, YYYY-MM-DD, inclusive
  endDate: string; // JST calendar date, YYYY-MM-DD, inclusive
  hours: number[];
  // 2026-09-29 owner decision: pin one specific researched post (by its
  // permalink) as the priority pick for "clone" instead of a random one —
  // see contentGenerator.ts's pickExampleToFollow for the soft-preference
  // fallback if it's since rotated out of style-examples.json.
  preferredPermalink?: string;
}
function isCloneStyleMoment(config: CloneStyleWindowConfig): boolean {
  const now = new Date();
  const jstHour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hourCycle: "h23" }).format(now)
  );
  if (!config.hours.includes(jstHour)) return false;
  const jstDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(now);
  return jstDate >= config.startDate && jstDate <= config.endDate;
}

interface OwnImageConfig {
  date: string;
  hour: number;
  // Exact file for a single-image post. Ignored if `files` is also set.
  file?: string;
  // Exact files, in order, for a carousel (multi-photo) post — e.g. a
  // reference post's own "1/2, 2/2" layout (2026-09-25 owner decision).
  files?: string[];
}

// Owner-supplied images (2026-09-21 owner decision: made with the owner's own
// AI image tool and dropped into images/, instead of reusing other users'
// photos). They are committed to this public repo, so the raw.githubusercontent
// URL works as the public image URL Threads requires.
//
// `files` / `file` (2026-09-25 owner decision) pick exact file(s) instead of
// a random one from the whole folder — needed once images/ can hold pictures
// for more than one distinct one-time post at once (each must only ever be
// attached to its own post, never accidentally swapped with another). With
// neither set, falls back to a random pick from the folder, avoiding the
// image used by the previous post when there is more than one.
function pickOwnImages(log: PostedLogEntry[], config: OwnImageConfig): { files: string[]; urls: string[] } | undefined {
  if (!existsSync(OWN_IMAGES_DIR)) return undefined;
  const repository = process.env.GITHUB_REPOSITORY;
  const branch = process.env.GITHUB_REF_NAME;
  if (!repository || !branch) {
    console.log("Own images exist, but not running inside GitHub Actions: no public URL to use.");
    return undefined;
  }
  const toUrl = (file: string) =>
    `https://raw.githubusercontent.com/${repository}/${branch}/${OWN_IMAGES_DIR}/${encodeURIComponent(file)}`;

  if (config.files && config.files.length > 0) {
    const missing = config.files.filter((name) => !existsSync(`${OWN_IMAGES_DIR}/${name}`));
    if (missing.length > 0) {
      console.warn(`Configured own images not found: ${missing.join(", ")}. Skipping the whole set.`);
      return undefined;
    }
    return { files: config.files, urls: config.files.map(toUrl) };
  }
  if (config.file) {
    if (!existsSync(`${OWN_IMAGES_DIR}/${config.file}`)) {
      console.warn(`Configured own image "${config.file}" was not found in ${OWN_IMAGES_DIR}/. Skipping it.`);
      return undefined;
    }
    return { files: [config.file], urls: [toUrl(config.file)] };
  }

  const files = readdirSync(OWN_IMAGES_DIR).filter((name) => /\.(jpe?g|png)$/i.test(name));
  if (files.length === 0) return undefined;
  const lastUsed = [...log].reverse().find((entry) => entry.ownImageFiles?.length === 1)?.ownImageFiles?.[0];
  const candidates = files.length > 1 ? files.filter((name) => name !== lastUsed) : files;
  const file = candidates[Math.floor(Math.random() * candidates.length)];
  return { files: [file], urls: [toUrl(file)] };
}

// The best-scoring researched post that has its images saved in the repo, has
// not been remixed before, and whose images show skincare products or a
// by-concern chart (2026-10-03 owner decision, checked by Claude — see
// isConcernProductImage). Only the top few candidates are checked, to keep
// the extra API calls small. Read straight from style-examples.json,
// independent of useStyleExamples (which only governs the text references).
const REMIX_CANDIDATES_TO_CHECK = 5;

async function pickRemixExample(log: PostedLogEntry[]): Promise<StyleExample | undefined> {
  const used = new Set(log.map((entry) => entry.sourcePermalink).filter(Boolean));
  const candidates = readJson<StyleExample[]>(STYLE_EXAMPLES_PATH)
    .filter(
      (example) =>
        example.source === "threads_browser_research" &&
        example.genre !== "other" &&
        example.permalink &&
        !used.has(example.permalink) &&
        example.localImages &&
        example.localImages.length > 0 &&
        example.localImages.every((path) => existsSync(path))
    )
    .sort((a, b) => (b.score ?? b.likes ?? 0) - (a.score ?? a.likes ?? 0))
    .slice(0, REMIX_CANDIDATES_TO_CHECK);
  for (const candidate of candidates) {
    if (await isConcernProductImage(candidate)) return candidate;
    console.log(`Remix: skipped ${candidate.permalink} (images are not skincare products / a by-concern chart).`);
  }
  return undefined;
}

// "trend" (2026-10-07 owner decision): a trending post's own images, the very
// product it introduces (found on Rakuten, our affiliate link), and our own
// wording following its structure — see contentGenerator.ts. Posts whose
// images are mainly people (faces etc.) are still skipped, as with remix.
const TREND_CANDIDATES_TO_CHECK = 6;
const THREADS_MAX_LENGTH = 500;
const TREND_MIN_BODY = 150;

interface TrendPick {
  example: StyleExample;
  products: { target: FeaturedProduct; item: RakutenItem }[];
}

async function pickTrendSource(log: PostedLogEntry[]): Promise<TrendPick | undefined> {
  if (!hasRakutenApiConfig()) {
    console.log("Trend: Rakuten API keys are not set (RAKUTEN_APP_ID / RAKUTEN_ACCESS_KEY / RAKUTEN_AFFILIATE_ID).");
    return undefined;
  }
  const used = new Set(log.map((entry) => entry.sourcePermalink).filter(Boolean));
  const candidates = readJson<StyleExample[]>(STYLE_EXAMPLES_PATH)
    .filter(
      (example) =>
        example.source === "threads_browser_research" &&
        example.genre !== "other" &&
        example.permalink &&
        !used.has(example.permalink) &&
        example.localImages &&
        example.localImages.length > 0 &&
        example.localImages.every((path) => existsSync(path))
    )
    .sort((a, b) => (b.score ?? b.likes ?? 0) - (a.score ?? a.likes ?? 0))
    .slice(0, TREND_CANDIDATES_TO_CHECK);
  for (const candidate of candidates) {
    if (!(await isConcernProductImage(candidate))) {
      console.log(`Trend: skipped ${candidate.permalink} (images are not skincare products / a by-concern chart).`);
      continue;
    }
    const targets = await identifyFeaturedProducts(candidate);
    if (targets.length === 0) {
      console.log(`Trend: skipped ${candidate.permalink} (no specific product named).`);
      continue;
    }
    const products: TrendPick["products"] = [];
    for (const target of targets) {
      const items = await searchRakutenItems(target.keyword);
      const index = await pickSameRakutenItem(target, items);
      if (index === undefined) {
        console.log(`Trend: "${target.brand} ${target.name}" not found on Rakuten as the same product.`);
        continue;
      }
      products.push({ target, item: items[index] });
    }
    if (products.length > 0) return { example: candidate, products };
    console.log(`Trend: skipped ${candidate.permalink} (none of its products are on Rakuten).`);
  }
  return undefined;
}

function trendLinkBlock(products: TrendPick["products"]): string {
  const lines =
    products.length === 1
      ? [products[0].item.affiliateUrl]
      : products.map(({ target, item }) => `▶︎${target.brand} ${target.name}\n${item.affiliateUrl}`);
  // Same disclosure as every other post: plain "pr" after the link.
  return `${lines.join("\n")} pr`;
}

// Returns false when there is nothing usable today, so the caller can post
// the cheat-sheet type instead.
async function runTrendPost(dryRun: boolean, log: PostedLogEntry[]): Promise<boolean> {
  let pick: TrendPick | undefined;
  try {
    pick = await pickTrendSource(log);
  } catch (error) {
    console.warn(`Trend: search failed, falling back: ${error instanceof Error ? error.message : error}`);
    return false;
  }
  if (!pick) return false;

  // Affiliate links are long; drop the least central products until the
  // reply still has room for a real body under Threads' 500-character limit.
  const products = [...pick.products];
  while (products.length > 1 && THREADS_MAX_LENGTH - trendLinkBlock(products).length - 2 < TREND_MIN_BODY) products.pop();
  const linkBlock = trendLinkBlock(products);
  const bodyMax = Math.min(400, THREADS_MAX_LENGTH - linkBlock.length - 2);
  console.log(`Trend source: ${pick.example.permalink} (score ${pick.example.score ?? pick.example.likes})`);
  for (const { target, item } of products) console.log(`Trend product: ${target.brand} ${target.name} -> ${item.name} (${item.shopName})`);

  const generated = await generateTrendPost(pick.example, products, bodyMax);
  let body = generated.body;
  if (body.length > bodyMax) {
    const cut = body.slice(0, bodyMax);
    body = cut.slice(0, Math.max(cut.lastIndexOf("\n"), Math.floor(bodyMax * 0.6))).trim();
  }
  const replyText = `${body}\n\n${linkBlock}`;
  const localImages = pick.example.localImages!;
  const imageUrls = localImages.map(repoFileUrl).filter((url): url is string => Boolean(url)).slice(0, 10);

  console.log("=== Generated hook (new post) ===");
  console.log(generated.hook);
  console.log("=== Generated reply (body + affiliate link) ===");
  console.log(replyText);
  console.log("=================================================");
  console.log(`Image: ${imageUrls.length > 0 ? imageUrls.join(" | ") : localImages.join(", ") + " (local only)"} (from ${pick.example.permalink})`);

  if (dryRun) {
    console.log("Dry run: skipping actual post to Threads.");
    return true;
  }
  if (imageUrls.length === 0) throw new Error("Trend: no public URL for the source images (not running on GitHub Actions?).");

  const threadsPostId =
    imageUrls.length > 1 ? await postCarouselToThreads(generated.hook, imageUrls) : await postToThreads(generated.hook, imageUrls[0]);
  if (!threadsPostId) throw new Error("Failed to obtain the post ID of the new Threads post. Skipping the reply.");
  console.log(`STEP 1 done: posted hook to Threads. threadsPostId=${threadsPostId}`);
  const threadsReplyId = await postReplyToThreads(replyText, threadsPostId);
  console.log(`STEP 3 done: posted affiliate link as a reply. threadsReplyId=${threadsReplyId}`);

  log.push({
    productId: `trend:${products[0].item.itemCode}`,
    postedAt: new Date().toISOString(),
    threadsPostId,
    threadsReplyId,
    sourcePermalink: pick.example.permalink,
    researchImages: localImages,
    rakutenItemCode: products.map(({ item }) => item.itemCode).join(","),
    ...(process.env.SLOT_JST_DATE ? { slotDate: process.env.SLOT_JST_DATE, slotHour: Number(process.env.SLOT_JST_HOUR) } : {}),
  });
  writeFileSync(POSTED_LOG_PATH, JSON.stringify(log, null, 2) + "\n");
  return true;
}

function repoFileUrl(path: string): string | undefined {
  const repository = process.env.GITHUB_REPOSITORY;
  const branch = process.env.GITHUB_REF_NAME;
  if (!repository || !branch) return undefined;
  return `https://raw.githubusercontent.com/${repository}/${branch}/${path.split("/").map(encodeURIComponent).join("/")}`;
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
  const researchSettings = readJson<{
    // false (2026-09-30 owner decision) pauses every style example — manual
    // and researched alike — while the research approach is reviewed.
    useStyleExamples?: boolean;
    includeOtherGenreStyles: boolean;
    attachCheatsheetCard?: boolean;
    // JST hours whose cheat-sheet posts get the card (2026-10-01 owner
    // decision: 18 and 19 only, 8:00 stays image-free). Unset = every hour.
    cheatsheetCardHours?: number[];
    oneTimeOwnImage?: OwnImageConfig[];
    // url/productId (2026-09-25 owner decision): lets a one-time post advertise
    // something outside data/products.json (e.g. a single guest product) —
    // the reply link uses `url` instead of the rotated product's, and the
    // posted-log entry uses `productId` instead of the rotated product's id,
    // so it never gets mixed into the normal rotation's own history.
    oneTimeText?: { date: string; hour: number; hook: string; body: string; url?: string; productId?: string }[];
    // A list (2026-09-27 owner decision) so more than one hour can each run
    // its own fixed A/B arm at the same time — e.g. 20:00's cheat-sheet arm
    // and 21:00's photo+story arm for the same test week.
    recurringStorySlots?: RecurringStorySlotConfig[];
    cloneStyleWindow?: CloneStyleWindowConfig;
  }>(RESEARCH_SETTINGS_PATH);
  const styleExamples =
    researchSettings.useStyleExamples === false
      ? []
      : readJson<StyleExample[]>(STYLE_EXAMPLES_PATH).filter(
          (example) => example.genre !== "other" || researchSettings.includeOtherGenreStyles
        );
  const log = readJson<PostedLogEntry[]>(POSTED_LOG_PATH);

  if (products.length === 0) {
    throw new Error("data/products.json is empty. Add at least one product.");
  }

  // The clone-style window (see isCloneStyleMoment above) overrides
  // SLOT_BY_JST_HOUR's normal mapping for its specific hours only, without a
  // --slot= override and without touching a moment already claimed by
  // recurringStorySlots below.
  const rawSlot = pickSlot();
  const slot: Slot | undefined =
    !process.argv.some((arg) => arg.startsWith("--slot=")) &&
    researchSettings.cloneStyleWindow &&
    isCloneStyleMoment(researchSettings.cloneStyleWindow)
      ? "clone"
      : rawSlot;
  console.log(`Post slot: ${slot ?? "(none - no forced style)"}`);
  if (slot === "question") {
    await runQuestionPost(dryRun, log);
    return;
  }
  if (slot === "trend") {
    if (await runTrendPost(dryRun, log)) return;
    console.log("Trend: no usable trending post, posting cheatsheet instead.");
  }

  // The recurring A/B story slot (2026-09-27 owner decision) fixes the
  // product for its whole window, overriding the normal rotation for this
  // run only — so the test compares just the post *type*, not the product
  // too. Checked before the normal pick so that override can actually apply.
  const oneTimeText = findJstMoment(researchSettings.oneTimeText);
  const recurringStoryConfig = oneTimeText
    ? undefined
    : researchSettings.recurringStorySlots?.find(isRecurringStoryMoment);
  const isStoryMoment = Boolean(recurringStoryConfig);
  const product = isStoryMoment
    ? products.find((p) => p.id === recurringStoryConfig!.productId) ??
      (() => {
        throw new Error(
          `recurringStorySlots: productId "${recurringStoryConfig!.productId}" not found in data/products.json.`
        );
      })()
    : pickNextProduct(products, log);

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
  // oneTimeText (2026-09-25 owner decision) lets the owner fix the exact hook
  // and body for one specific post — e.g. to match a reference post's tone —
  // instead of the usual AI generation, during its configured JST window only.
  const recurringStory = isStoryMoment ? todaysRecurringStoryVariant(recurringStoryConfig!) : undefined;
  const remixExample = slot === "remix" && !oneTimeText && !isStoryMoment ? await pickRemixExample(log) : undefined;
  if (slot === "remix" && !remixExample) console.log("Remix: no unused researched post with saved images, using cheatsheet instead.");
  if (remixExample) console.log(`Remix source: ${remixExample.permalink} (score ${remixExample.score ?? remixExample.likes})`);
  const effectiveSlot: Slot | undefined = (slot === "remix" && !remixExample) || slot === "trend" ? "cheatsheet" : slot;
  const generated =
    oneTimeText ??
    recurringStory ??
    (remixExample
      ? await generateRemixPost(product, remixExample)
      : await generatePostText(
          product,
          styleExamples,
          effectiveSlot as PostStyle | undefined,
          researchSettings.cloneStyleWindow?.preferredPermalink
        ));
  const { hook, body } = generated;
  // Only ever set for style "clone" (2026-09-28 owner decision, one week's
  // trial): the same trending post's own photo, paired with hook/body text
  // that closely mirrors that post's actual wording rather than just its
  // structure — see contentGenerator.ts's STYLE_INSTRUCTIONS.clone for the
  // risk this accepts (much closer to a straight copy than "feed" style,
  // which only borrows structure and writes new wording).
  const cloneImageUrl = "cloneImageUrl" in generated ? generated.cloneImageUrl : undefined;

  // A one-time override (oneTimeText and/or oneTimeOwnImage matching this
  // exact date/hour) replaces the slot's usual content for this one post —
  // it must win over the slot's default type entirely, including which
  // image gets attached. Without this, forcing every slot to "cheatsheet"
  // (2026-09-26 owner decision) silently broke oneTimeOwnImage: it only ever
  // applied to non-cheatsheet slots, so a one-off image+story post like
  // 9/25's would attach no image at all once every hour became cheatsheet
  // (bug found 2026-09-27, ahead of trying this style again). The recurring
  // story slot needs the exact same override for the exact same reason.
  const oneTimeOwnImageConfig = findJstMoment(researchSettings.oneTimeOwnImage);
  const ownImageConfig: OwnImageConfig | undefined =
    oneTimeOwnImageConfig ??
    (isStoryMoment && recurringStoryConfig!.images && recurringStoryConfig!.images.length > 0
      ? { date: "", hour: 0, files: recurringStoryConfig!.images }
      : undefined);
  const isOneTimeOverrideMoment = Boolean(oneTimeText) || Boolean(oneTimeOwnImageConfig) || isStoryMoment;

  // Prefer a photo from one of this run's trending-post examples (adds
  // variety and matches what's currently resonating) over the product's own
  // fixed banner image; fall back to the product image if there is no
  // trending photo, or if the trending photo's URL has since expired (these
  // are hotlinked from Threads' own CDN, whose URLs are time-limited).
  // Cheat-sheet posts get a self-made card image of the table (2026-09-21 owner
  // decision). A failure to render or host it must never block the post: it
  // simply goes out without the card.
  let cardUrl: string | undefined;
  // attachCheatsheetCard in data/research-settings.json is the on/off switch;
  // cheatsheetCardHours limits it to specific hours. A --slot= dry run counts
  // as a card hour so the card can be previewed at any time.
  const isCardHour =
    !researchSettings.cheatsheetCardHours ||
    researchSettings.cheatsheetCardHours.includes(currentJstHour()) ||
    (dryRun && process.argv.some((arg) => arg.startsWith("--slot=")));
  // "combo" always gets its own card: the card is the point of that type.
  const isCardSlot = effectiveSlot === "cheatsheet" || effectiveSlot === "combo";
  if (
    isCardSlot &&
    !isOneTimeOverrideMoment &&
    researchSettings.attachCheatsheetCard !== false &&
    (isCardHour || effectiveSlot === "combo")
  ) {
    try {
      let render: ((outPath: string) => Promise<string>) | undefined;
      if (effectiveSlot === "combo") {
        const panels = parseComboPanels(hook);
        if (hasEnoughPanels(panels)) render = (outPath) => renderComboCard(panels, outPath);
        else console.log(`Card skipped: only ${panels.length} combination row(s) found in the hook.`);
      } else {
        const rows = parseCheatsheetRows(hook);
        if (hasEnoughRows(rows)) render = (outPath) => renderCheatsheetCard(rows, outPath);
        else console.log(`Card skipped: only ${rows.length} table row(s) found in the hook.`);
      }
      if (render && dryRun) {
        const previewPath = await render(`cards/preview-${Date.now()}.png`);
        console.log(`Card preview rendered: ${previewPath}`);
      } else if (render) {
        const cardPath = await render(`cards/card-${Date.now()}.png`);
        cardUrl = await hostCardOnGitHub(cardPath);
        console.log(`Card hosted: ${cardUrl}`);
      }
    } catch (error) {
      console.warn(`Card skipped, posting without it: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Cheat-sheet posts keep their card (or the old fallbacks), unless this
  // moment is a one-time override, in which case its own image always wins.
  const ownImages =
    (effectiveSlot === "cheatsheet" && !isOneTimeOverrideMoment) || cardUrl || !ownImageConfig
      ? undefined
      : pickOwnImages(log, ownImageConfig);
  // Remix images: the researched post's own photos, committed to the repo by
  // the research run. Locally (no GitHub env) there is no public URL, so a dry
  // run just reports the files.
  const remixImageUrls = remixExample?.localImages?.map(repoFileUrl).filter((url): url is string => Boolean(url));
  const remixUrls = remixImageUrls && remixImageUrls.length > 0 ? remixImageUrls.slice(0, 10) : undefined;
  if (remixExample && !remixUrls) console.log(`Remix images (local only, no public URL here): ${remixExample.localImages!.join(", ")}`);
  const trendImageUrl = cardUrl || ownImages || remixUrls ? undefined : cloneImageUrl ?? pickTrendImageUrl(styleExamples);
  // attachedImageUrls may hold more than one URL only for an owner-supplied
  // carousel (see OwnImageConfig.files above); every other source is a single
  // image. `imageUrl` (its first/only entry) is what the single-image posting
  // path and its own-product-image fallback below use.
  const attachedImageUrls = cardUrl
    ? [cardUrl]
    : ownImages
    ? ownImages.urls
    : remixUrls
    ? remixUrls
    : trendImageUrl
    ? [trendImageUrl]
    : undefined;
  const imageUrl = attachedImageUrls?.[0] ?? product.imageUrl;

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
  const linkUrl = oneTimeText?.url ?? product.url;
  const replyText = `${body}\n\n${linkUrl} pr`;

  console.log("=== Generated hook (new post) ===");
  console.log(hook);
  console.log("=== Generated reply (body + affiliate link) ===");
  console.log(replyText);
  console.log("=================================================");
  console.log(
    `Image: ${attachedImageUrls ? attachedImageUrls.join(" | ") : imageUrl ?? "(none)"}${
      cardUrl
        ? " (self-made cheat-sheet card)"
        : ownImages
        ? ownImages.files.length > 1
          ? ` (owner-supplied carousel: ${ownImages.files.join(" -> ")})`
          : " (owner-supplied image)"
        : remixUrls
        ? ` (remix of ${remixExample!.permalink})`
        : trendImageUrl
        ? " (from a trending-post example)"
        : ""
    }`
  );

  if (dryRun) {
    console.log("Dry run: skipping actual post to Threads.");
    return;
  }

  // STEP 1: post the hook as a new top-level post. A carousel (2+ owner
  // images) uses its own dedicated posting call; everything else is the
  // existing single-image-or-text path.
  // Tracks whether the fallback path below actually ran, so the posted-log
  // entry can reflect what was truly posted rather than what was merely
  // attempted — previously ownImageFiles was recorded whenever ownImages was
  // set, even on a run that fell back to postToThreads(hook, product.imageUrl)
  // (or, with no product.imageUrl configured, a plain text-only post) after
  // the attached-image attempt failed. That made the log claim an image was
  // used on posts that went out with none (caught 2026-09-27, when the
  // owner noticed the 21:00 carousel post had no photo despite the log —
  // and code — saying otherwise).
  let usedFallbackImage = false;
  let threadsPostId: string;
  try {
    threadsPostId =
      attachedImageUrls && attachedImageUrls.length > 1
        ? await postCarouselToThreads(hook, attachedImageUrls)
        : await postToThreads(hook, imageUrl);
  } catch (error) {
    if (attachedImageUrls && imageUrl !== product.imageUrl) {
      console.warn(
        `Posting with the attached image(s) failed (e.g. an expired or unreachable URL), retrying with the product image instead: ${
          error instanceof Error ? error.message : error
        }`
      );
      usedFallbackImage = true;
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
    productId: oneTimeText?.productId ?? product.id,
    postedAt: new Date().toISOString(),
    threadsPostId,
    threadsReplyId,
    ...(ownImages && !usedFallbackImage ? { ownImageFiles: ownImages.files } : {}),
    ...(remixExample ? { sourcePermalink: remixExample.permalink } : {}),
    ...(remixUrls && !usedFallbackImage ? { researchImages: remixExample!.localImages } : {}),
    ...(cardUrl && !usedFallbackImage ? { cardImage: cardUrl } : {}),
    ...(process.env.SLOT_JST_DATE
      ? { slotDate: process.env.SLOT_JST_DATE, slotHour: Number(process.env.SLOT_JST_HOUR) }
      : {}),
  });
  writeFileSync(POSTED_LOG_PATH, JSON.stringify(log, null, 2) + "\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
