import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fetchMonthlySummary, launchBrowser, openAuthenticatedPage, type RakutenMonthlySummary } from "./rakutenScraper.js";

const REPORT_LOG_PATH = "data/rakuten-report-log.json";
const DEBUG_DIR = "debug";
// Set RAKUTEN_DEBUG_SCREENSHOTS=1 (workflow_dispatch only, same convention as
// RESEARCH_DEBUG_SCREENSHOTS in research.yml) to save a full-page screenshot
// if the expected numbers can't be found — the fastest way to see what
// Rakuten actually rendered without a human having to log in and look.
const DEBUG_SCREENSHOTS = process.env.RAKUTEN_DEBUG_SCREENSHOTS === "1";

interface ReportLogEntry extends RakutenMonthlySummary {
  capturedAt: string; // ISO timestamp
}

function readLog(): ReportLogEntry[] {
  if (!existsSync(REPORT_LOG_PATH)) return [];
  return JSON.parse(readFileSync(REPORT_LOG_PATH, "utf-8")) as ReportLogEntry[];
}

async function main(): Promise<void> {
  const browser = await launchBrowser();
  try {
    const page = await openAuthenticatedPage(browser);
    let summary: RakutenMonthlySummary;
    try {
      summary = await fetchMonthlySummary(page);
    } catch (error) {
      if (DEBUG_SCREENSHOTS) {
        mkdirSync(DEBUG_DIR, { recursive: true });
        await page.screenshot({ path: `${DEBUG_DIR}/rakuten-mypage.png`, fullPage: true });
      }
      throw error;
    }

    console.log("=== Rakuten Affiliate 今月の成果情報 ===");
    console.log(`売上金額: ¥${summary.salesAmountYen.toLocaleString("ja-JP")}`);
    console.log(`成果報酬: ¥${summary.rewardYen.toLocaleString("ja-JP")}`);
    console.log(`クリック数: ${summary.clicks.toLocaleString("ja-JP")}`);
    console.log(`売上件数: ${summary.salesCount.toLocaleString("ja-JP")}`);
    console.log("=======================================");

    const log = readLog();
    log.push({ ...summary, capturedAt: new Date().toISOString() });
    writeFileSync(REPORT_LOG_PATH, JSON.stringify(log, null, 2) + "\n");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
