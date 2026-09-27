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

// Rakuten's own login session tends to expire faster (and add extra identity
// checks) than Threads' did — this is the boundary of that risk the owner
// accepted on 2026-09-27, not something to try to work around here. A failed
// re-login attempt just throws (below), which is meant to fail loudly rather
// than silently record wrong numbers.
async function assertLoggedIn(page: Page): Promise<void> {
  const loggedOutHeading = await page
    .locator("text=ログイン")
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);
  const heading = await page
    .locator("text=今月の成果情報")
    .first()
    .isVisible({ timeout: 10000 })
    .catch(() => false);
  if (!heading || loggedOutHeading) {
    throw new Error(
      "Rakuten Affiliate mypage did not show the expected 今月の成果情報 section — the saved session " +
        "has likely expired. Run \"npm run rakuten:login\" again and update RAKUTEN_SESSION_STATE_B64."
    );
  }
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

// Fetches this month's cumulative summary from the マイページ dashboard.
// Throws rather than guessing if the page layout doesn't match what's
// expected — see the note on RAKUTEN_DEBUG_SCREENSHOTS in runRakutenReport.ts
// for how to diagnose a layout change.
export async function fetchMonthlySummary(page: Page): Promise<RakutenMonthlySummary> {
  await page.goto(MYPAGE_URL, { waitUntil: "domcontentloaded" });
  await assertLoggedIn(page);

  const bodyText: string = await page.evaluate(() => document.body.innerText);
  const lines = bodyText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const salesAmountRaw = findValueAfterLabel(lines, "売上金額");
  const rewardRaw = findValueAfterLabel(lines, "成果報酬");
  const clicksRaw = findValueAfterLabel(lines, "クリック数");
  const salesCountRaw = findValueAfterLabel(lines, "売上件数");

  const missing = [
    ["売上金額", salesAmountRaw],
    ["成果報酬", rewardRaw],
    ["クリック数", clicksRaw],
    ["売上件数", salesCountRaw],
  ].filter(([, value]) => value === null);

  if (missing.length > 0) {
    throw new Error(
      `Could not find a value for: ${missing.map(([label]) => label).join(", ")}. ` +
        "Rakuten likely changed the page layout — see RAKUTEN_DEBUG_SCREENSHOTS."
    );
  }

  return {
    salesAmountYen: parseYenOrNumber(salesAmountRaw!),
    rewardYen: parseYenOrNumber(rewardRaw!),
    clicks: parseYenOrNumber(clicksRaw!),
    salesCount: parseYenOrNumber(salesCountRaw!),
  };
}
