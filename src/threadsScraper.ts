import { existsSync, mkdirSync, readFileSync } from "fs";
import { chromium, type Browser, type Page } from "playwright";

// Temporary diagnostic aid: when RESEARCH_DEBUG_SCREENSHOTS=1, save a full-page
// screenshot of each keyword's search results to debug/ so a human can check
// whether the DOM-selector-based scraping (findPostContainer, like-count
// parsing, etc.) actually lines up with what a logged-in browser sees, versus
// the 4 required conditions genuinely having no matching posts that day.
const DEBUG_SCREENSHOTS = process.env.RESEARCH_DEBUG_SCREENSHOTS === "1";
const DEBUG_DIR = "debug";

const SESSION_STATE_PATH = "data/threads-session.json";
const SEARCH_URL = "https://www.threads.com/search";
const LOOKBACK_DAYS = 7;
const MIN_LIKES = 100;
const MAX_SCROLLS = 6;

export interface AffiliateDomainsConfig {
  domains: string[];
  affiliateQueryParams: string[];
}

export interface CandidatePost {
  permalink: string;
  postId: string;
  username: string;
  text: string;
  postedAt: Date;
  likes: number;
  keyword: string;
}

export interface QualifiedPost extends CandidatePost {
  replyCount: number;
  matchedReplyText: string;
  affiliateLinkRaw: string;
  affiliateLinkResolved: string;
}

interface RawPost {
  permalink: string;
  username: string;
  text: string;
  timestampLabel: string;
  likesLabel: string;
}

function loadAffiliateDomains(): AffiliateDomainsConfig {
  return JSON.parse(readFileSync("data/affiliate-domains.json", "utf-8")) as AffiliateDomainsConfig;
}

// Threads' timestamp link has no useful aria-label (always null in practice)
// — the actual timestamp is the anchor's visible text, which is relative
// ("3分", "7時間", "4日") for roughly the first week and switches to an
// absolute "2026/08/30" (date only, no time of day) after that. There's no
// reliable "◯年◯月◯日..." full-date string in the wild despite what earlier
// code assumed — that format never matched, which is why every post used to
// get silently dropped before the lookback cutoff was ever applied.
function parseThreadsTimestamp(label: string): Date | null {
  const trimmed = label.trim();

  const minuteMatch = trimmed.match(/^(\d+)分$/);
  if (minuteMatch) return new Date(Date.now() - Number(minuteMatch[1]) * 60 * 1000);

  const hourMatch = trimmed.match(/^(\d+)時間$/);
  if (hourMatch) return new Date(Date.now() - Number(hourMatch[1]) * 60 * 60 * 1000);

  const dayMatch = trimmed.match(/^(\d+)日$/);
  if (dayMatch) return new Date(Date.now() - Number(dayMatch[1]) * 24 * 60 * 60 * 1000);

  const weekMatch = trimmed.match(/^(\d+)週間?$/);
  if (weekMatch) return new Date(Date.now() - Number(weekMatch[1]) * 7 * 24 * 60 * 60 * 1000);

  // Date-only, no time of day given — use noon so it lands solidly on that
  // calendar day regardless of the reader's/cutoff's own time-of-day.
  const slashMatch = trimmed.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (slashMatch) {
    const [, y, mo, d] = slashMatch;
    return new Date(Number(y), Number(mo) - 1, Number(d), 12, 0);
  }

  // Kept in case some accounts/locales still render this full format.
  const fullMatch = trimmed.match(/(\d{4})年(\d{1,2})月(\d{1,2})日.*?(\d{1,2}):(\d{2})/);
  if (fullMatch) {
    const [, y, mo, d, h, mi] = fullMatch;
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  }

  return null;
}

// Matches any of the timestamp text formats parseThreadsTimestamp handles.
// Inlined into each page.evaluate() callback below (see the note above
// searchKeywordCandidates on why shared helpers can't be imported there).
const TIMESTAMP_LABEL_SOURCE =
  "^\\d+(分|時間|日|週間?)$|^\\d{4}/\\d{1,2}/\\d{1,2}$|\\d{4}年\\d{1,2}月\\d{1,2}日";

function extractPostIdFromPermalink(permalink: string): string {
  const match = permalink.match(/\/post\/([^/?#]+)/);
  return match ? match[1] : permalink;
}

function extractUsernameFromPermalink(permalink: string): string {
  const match = permalink.match(/\/@([^/]+)\/post\//);
  return match ? match[1] : "";
}

function parseLikeCount(raw: string): number {
  // Threads abbreviates large counts, e.g. "1.2万" (12,000) or "3,844".
  const cleaned = raw.trim();
  const manMatch = cleaned.match(/^([\d.]+)万$/);
  if (manMatch) return Math.round(Number(manMatch[1]) * 10000);
  const numeric = Number(cleaned.replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

export async function openAuthenticatedPage(browser: Browser): Promise<Page> {
  if (!existsSync(SESSION_STATE_PATH)) {
    throw new Error(
      `Missing ${SESSION_STATE_PATH}. Run "npm run research:login" once locally to create a logged-in ` +
        `Threads session, then provide its contents via the THREADS_SESSION_STATE_B64 secret in CI.`
    );
  }
  const context = await browser.newContext({
    storageState: SESSION_STATE_PATH,
    locale: "ja-JP",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  });
  return context.newPage();
}

// Searches a keyword on Threads and returns candidate root posts (not replies)
// that meet the "posted within LOOKBACK_DAYS days" and "100+ likes" conditions.
// Does NOT check the reply section yet — that requires opening each post
// individually.
//
// Everything inside the page.evaluate() callback below runs in the browser,
// not in this Node process, so any helper it needs (findPostContainer etc.)
// must be declared *inside* that callback rather than imported/shared —
// Playwright serializes only the callback's own source when sending it over.
export async function searchKeywordCandidates(page: Page, keyword: string): Promise<CandidatePost[]> {
  const url = `${SEARCH_URL}?q=${encodeURIComponent(keyword)}&serp_type=default`;
  await page.goto(url, { waitUntil: "domcontentloaded" });

  try {
    await page.waitForSelector('a[href*="/post/"]', { timeout: 15000 });
  } catch {
    console.warn(`No search results loaded for keyword "${keyword}".`);
    return [];
  }

  for (let i = 0; i < MAX_SCROLLS; i++) {
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(1200);
  }

  if (DEBUG_SCREENSHOTS) {
    mkdirSync(DEBUG_DIR, { recursive: true });
    await page.screenshot({ path: `${DEBUG_DIR}/search-${keyword}.png`, fullPage: true });
  }

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const rawPosts: RawPost[] = await page.evaluate((labelPattern) => {
    const timestampRegex = new RegExp(labelPattern);
    const results: RawPost[] = [];
    const permalinkAnchors = Array.from(document.querySelectorAll('a[href*="/post/"]')) as HTMLElement[];
    const seen = new Set<string>();

    for (const anchor of permalinkAnchors) {
      const href = anchor.getAttribute("href") || "";
      if (seen.has(href)) continue;
      const timestampLabel = (anchor.getAttribute("aria-label") || anchor.innerText || "").trim();
      if (!timestampRegex.test(timestampLabel)) continue;
      seen.add(href);

      // Inlined (rather than a named helper function) because this callback
      // is serialized to its own source text and run in the browser in
      // isolation — a separate helper would need its own definition shipped
      // along with it, which page.evaluate does not do automatically, and
      // tsx's esbuild transform additionally emits a `__name(...)` call for
      // named functions that references a module-level helper not present
      // in that serialized text, causing a ReferenceError in the browser.
      let node: HTMLElement | null = anchor.parentElement;
      let container: HTMLElement | null = node;
      for (let hops = 0; hops < 14 && node; hops++) {
        const count = node.querySelectorAll('a[href*="/post/"]').length;
        if (count > 1) break;
        container = node;
        node = node.parentElement;
      }
      if (!container) continue;

      const usernameLink = container.querySelector('a[href^="/@"]:not([href*="/post/"])') as HTMLElement | null;
      const username = usernameLink ? usernameLink.innerText.trim() : "";

      // Threads' action-bar icons (like/reply/repost/share, in that fixed
      // order) carry no aria-label or alt text at all — the count is bare
      // button text, blank when it's 0. They're reliably the last 4 buttons
      // in the post's container, after any profile/follow/media buttons.
      const actionButtons = Array.from(container.querySelectorAll('button, [role="button"]')).slice(-4) as HTMLElement[];
      const likesLabel = actionButtons[0]?.innerText.trim() || "0";

      const skipTexts = new Set([username, "もっと見る", "投稿者", timestampLabel]);
      const textNodes = Array.from(container.querySelectorAll("span"))
        .map((el) => (el as HTMLElement).innerText.trim())
        .filter((t) => t.length > 3 && !skipTexts.has(t) && !/^[\d,.]+万?$/.test(t));
      const text = Array.from(new Set(textNodes)).join("\n");

      results.push({ permalink: href, username, text, timestampLabel, likesLabel });
    }
    return results;
  }, TIMESTAMP_LABEL_SOURCE);

  const candidates: CandidatePost[] = [];
  for (const raw of rawPosts) {
    const postedAt = parseThreadsTimestamp(raw.timestampLabel);
    if (!postedAt || postedAt < cutoff) continue;
    const likes = parseLikeCount(raw.likesLabel);
    if (likes < MIN_LIKES) continue;

    const permalink = new URL(raw.permalink, "https://www.threads.com").toString();
    candidates.push({
      permalink,
      postId: extractPostIdFromPermalink(permalink),
      username: raw.username || extractUsernameFromPermalink(permalink),
      text: raw.text,
      postedAt,
      likes,
      keyword,
    });
  }
  return candidates;
}

// Resolves a URL's final redirect target and checks it against the known
// affiliate-domain list. Returns null if the URL is not a confirmed
// affiliate link (unknown domain, fetch failure, etc.) — never guesses.
async function resolveAffiliateLink(rawUrl: string, config: AffiliateDomainsConfig): Promise<string | null> {
  try {
    const response = await fetch(rawUrl, { redirect: "follow", signal: AbortSignal.timeout(10000) });
    const finalUrl = new URL(response.url);
    const host = finalUrl.hostname;

    if (host === "www.amazon.co.jp" || host === "amazon.co.jp") {
      return finalUrl.searchParams.has("tag") ? finalUrl.toString() : null;
    }

    if (config.domains.includes(host)) {
      return finalUrl.toString();
    }

    const hasAffiliateParam = config.affiliateQueryParams.some((param) => finalUrl.searchParams.has(param));
    if (hasAffiliateParam && config.domains.some((d) => host.endsWith(d))) {
      return finalUrl.toString();
    }
  } catch (error) {
    console.warn(`Failed to resolve link ${rawUrl}: ${error instanceof Error ? error.message : error}`);
  }
  return null;
}

const URL_PATTERN = /https?:\/\/[^\s　]+/g;

// Opens a candidate post's detail page (logged in, so the full reply list is
// visible) and checks whether any reply contains a confirmed affiliate link.
export async function checkRepliesForAffiliateLink(
  page: Page,
  candidate: CandidatePost
): Promise<QualifiedPost | null> {
  const affiliateDomains = loadAffiliateDomains();
  await page.goto(candidate.permalink, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // Load more of the reply thread if it lazy-loads on scroll.
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(800);
  }

  const rootPath = new URL(candidate.permalink).pathname;

  const replyTexts: string[] = await page.evaluate(({ rootPathArg, labelPattern }) => {
    const timestampRegex = new RegExp(labelPattern);
    const texts: string[] = [];
    const seen = new Set<string>();
    const anchors = Array.from(document.querySelectorAll('a[href*="/post/"]')) as HTMLElement[];

    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || "";
      if (href === rootPathArg || seen.has(href)) continue;
      const timestampLabel = (anchor.getAttribute("aria-label") || anchor.innerText || "").trim();
      if (!timestampRegex.test(timestampLabel)) continue;
      seen.add(href);

      // Inlined for the same reason as in searchKeywordCandidates above —
      // no named helper function, since it would need its own definition
      // shipped alongside this serialized callback.
      let node: HTMLElement | null = anchor.parentElement;
      let container: HTMLElement | null = node;
      for (let hops = 0; hops < 14 && node; hops++) {
        const count = node.querySelectorAll('a[href*="/post/"]').length;
        if (count > 1) break;
        container = node;
        node = node.parentElement;
      }
      if (!container) continue;
      const body = container.innerText.trim();
      if (body) texts.push(body);
    }
    return texts;
  }, { rootPathArg: rootPath, labelPattern: TIMESTAMP_LABEL_SOURCE });

  const replyCount = replyTexts.length;

  for (const replyText of replyTexts) {
    const urls = replyText.match(URL_PATTERN);
    if (!urls) continue;
    for (const rawUrl of urls) {
      const resolved = await resolveAffiliateLink(rawUrl, affiliateDomains);
      if (resolved) {
        return {
          ...candidate,
          replyCount,
          matchedReplyText: replyText,
          affiliateLinkRaw: rawUrl,
          affiliateLinkResolved: resolved,
        };
      }
    }
  }
  return null;
}
