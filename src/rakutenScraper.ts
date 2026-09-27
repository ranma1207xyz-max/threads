import { existsSync } from "fs";
import { chromium, type Browser, type Page } from "playwright";

const SESSION_STATE_PATH = "data/rakuten-session.json";
const MYPAGE_URL = "https://affiliate.rakuten.co.jp/";

// The 4 numbers shown on Rakuten Affiliate's マイページ under "今月の成果情報"
// (2026-09-27 owner decision to automate this reading, after the owner shared
// a screenshot of that section). All 4 are month-to-date cumulative figures
// that keep growing through the month, not a single day's numbers.
export interface RakutenMonthlySummary {
  salesAmountYen: number; // 売上金額
  rewardYen: number; // 成果報酬 (commission — this is the actual revenue line)
  clicks: number; // クリック数
  salesCount: number; // 売上件数
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

export async function openAuthenticatedPage(browser: Browser): Promise<Page> {
  if (!existsSync(SESSION_STATE_PATH)) {
    throw new Error(
      `Missing ${SESSION_STATE_PATH}. Run "npm run rakuten:login" once locally to create a logged-in ` +
        `Rakuten Affiliate session, then provide its contents via the RAKUTEN_SESSION_STATE_B64 secret in CI.`
    );
  }
  const context = await browser.newContext({
    storageState: SESSION_STATE_PATH,
    locale: "ja-JP",
  });
  return context.newPage();
}

// Reads a value line following a label line in the page's plain visible text
// (not a specific CSS selector — nothing about this page's DOM structure was
// available while writing this, only a screenshot of the rendered result, so
// this is intentionally layout-tolerant). Scans forward a bounded number of
// lines after the label so an unrelated card's own label doesn't get matched.
function findValueAfterLabel(lines: string[], label: string, maxLookahead = 6): string | null {
  const labelIndex = lines.findIndex((line) => line === label);
  if (labelIndex === -1) return null;
  for (let i = labelIndex + 1; i < Math.min(lines.length, labelIndex + 1 + maxLookahead); i++) {
    if (/^[¥￥]?\s?[\d,]+$/.test(lines[i])) return lines[i];
  }
  return null;
}

function parseYenOrNumber(raw: string): number {
  const numeric = raw.replace(/[¥￥\s,]/g, "");
  const value = Number(numeric);
  if (!Number.isFinite(value)) {
    throw new Error(`Could not parse a number out of "${raw}".`);
  }
  return value;
}

interface ExtractionAttempt {
  sawHeading: boolean;
  values: Record<"売上金額" | "成果報酬" | "クリック数" | "売上件数", string | null>;
}

function attemptExtraction(bodyText: string): ExtractionAttempt {
  const lines = bodyText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return {
    sawHeading: lines.includes("今月の成果情報"),
    values: {
      売上金額: findValueAfterLabel(lines, "売上金額"),
      成果報酬: findValueAfterLabel(lines, "成果報酬"),
      クリック数: findValueAfterLabel(lines, "クリック数"),
      売上件数: findValueAfterLabel(lines, "売上件数"),
    },
  };
}

// Fetches this month's cumulative summary from the マイページ dashboard.
// The 4 numbers under "今月の成果情報" render as loading spinners at first
// and are filled in a moment later by a client-side API call the page makes
// after its own initial load — a single read right after page.goto() can
// land in that gap and see the heading but no digits yet (hit on
// 2026-09-27's first real run, before RAKUTEN_SESSION_STATE_B64 was even
// wrong — the session itself was fine). So this polls, re-reading the body
// text every few seconds, instead of reading once.
export async function fetchMonthlySummary(page: Page): Promise<RakutenMonthlySummary> {
  await page.goto(MYPAGE_URL, { waitUntil: "domcontentloaded" });

  const maxAttempts = 15; // 15 x 3s = up to 45s.
  let lastAttempt: ExtractionAttempt | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const bodyText: string = await page.evaluate(() => document.body.innerText);
    lastAttempt = attemptExtraction(bodyText);
    const allFound = Object.values(lastAttempt.values).every((v) => v !== null);
    if (allFound) break;
    await page.waitForTimeout(3000);
  }

  if (!lastAttempt || !lastAttempt.sawHeading) {
    throw new Error(
      "Rakuten Affiliate mypage never showed the expected 今月の成果情報 heading — the saved session " +
        "has likely expired. Run \"npm run rakuten:login\" again and update RAKUTEN_SESSION_STATE_B64."
    );
  }

  const missingLabels = (Object.keys(lastAttempt.values) as (keyof typeof lastAttempt.values)[]).filter(
    (label) => lastAttempt!.values[label] === null
  );
  if (missingLabels.length > 0) {
    throw new Error(
      `Could not find a value for: ${missingLabels.join(", ")} after ${maxAttempts * 3}s of waiting. ` +
        "Either Rakuten changed the page layout, or the numbers took unusually long to load — see RAKUTEN_DEBUG_SCREENSHOTS."
    );
  }

  return {
    salesAmountYen: parseYenOrNumber(lastAttempt.values.売上金額!),
    rewardYen: parseYenOrNumber(lastAttempt.values.成果報酬!),
    clicks: parseYenOrNumber(lastAttempt.values.クリック数!),
    salesCount: parseYenOrNumber(lastAttempt.values.売上件数!),
  };
}
