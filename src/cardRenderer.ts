import { mkdirSync } from "fs";
import { dirname } from "path";
import { chromium } from "playwright";

export interface CheatsheetRow {
  concern: string;
  ingredient: string;
}

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1350; // 4:5 portrait, well inside Threads' image limits.
const MIN_ROWS = 4;
const MAX_ROWS = 9;

// Pulls "concern -> ingredient" pairs out of the cheat-sheet hook text, e.g.
//   くすみ→ビタミンC        ・乾燥には「セラミド」        毛穴の目立ち→「ナイアシンアミド」
export function parseCheatsheetRows(hook: string): CheatsheetRow[] {
  const rows: CheatsheetRow[] = [];
  for (const rawLine of hook.split("\n")) {
    const line = rawLine.replace(/^[\s・•●▪\-]+/, "").trim();
    const arrow = line.match(/^(.{1,16}?)\s*(?:→|➡|⇒|->)\s*[「『]?(.{1,20}?)[」』]?$/);
    const particle = line.match(/^(.{1,16}?)(?:には|なら|は)\s*[「『](.{1,20}?)[」』]/);
    const match = arrow ?? particle;
    if (match) rows.push({ concern: match[1].trim(), ingredient: match[2].trim() });
  }
  return rows.slice(0, MAX_ROWS);
}

export function hasEnoughRows(rows: CheatsheetRow[]): boolean {
  return rows.length >= MIN_ROWS;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildHtml(rows: CheatsheetRow[]): string {
  const rowHeight = Math.min(130, Math.floor(920 / rows.length));
  const rowsHtml = rows
    .map(
      (row) => `
      <div class="row" style="height:${rowHeight - 14}px">
        <div class="concern">${escapeHtml(row.concern)}</div>
        <div class="arrow">→</div>
        <div class="ingredient">${escapeHtml(row.ingredient)}</div>
      </div>`
    )
    .join("");

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@500;700;900&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { width: ${CARD_WIDTH}px; height: ${CARD_HEIGHT}px; font-family: "Noto Sans JP", "Yu Gothic", "IPAexGothic", "IPAGothic", sans-serif;
         background: linear-gradient(160deg, #fdf7f2 0%, #f6e6e3 100%); color: #3b2f2f; padding: 72px 72px 56px; }
  .title { font-size: 68px; font-weight: 900; letter-spacing: 2px; text-align: center; }
  .sub { margin: 14px 0 44px; font-size: 30px; font-weight: 500; text-align: center; color: #8a6f6b; }
  .row { display: flex; align-items: center; margin-bottom: 14px; padding: 0 36px; background: #ffffff; border-radius: 28px;
         box-shadow: 0 6px 18px rgba(120, 80, 70, 0.10); }
  .concern { flex: 1; font-size: 40px; font-weight: 700; }
  .arrow { width: 90px; text-align: center; font-size: 40px; color: #c98a86; }
  .ingredient { flex: 1.1; font-size: 42px; font-weight: 900; color: #b4525e; text-align: right; }
  .foot { position: absolute; left: 0; right: 0; bottom: 40px; text-align: center; font-size: 24px; color: #a48e8a; }
</style></head>
<body>
  <div class="title">悩み別 成分早見表</div>
  <div class="sub">気になる悩みで選びがちな成分の目安</div>
  ${rowsHtml}
  <div class="foot">※一般に言われている目安で、効果を保証するものではありません</div>
</body></html>`;
}

// Renders the cheat-sheet as a PNG card. Fonts come from Google Fonts at render
// time (the CI runner has no Japanese fonts by default), with system fallbacks.
export async function renderCheatsheetCard(rows: CheatsheetRow[], outPath: string): Promise<string> {
  mkdirSync(dirname(outPath), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: CARD_WIDTH, height: CARD_HEIGHT } });
    await page.setContent(buildHtml(rows), { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: outPath, type: "png" });
  } finally {
    await browser.close();
  }
  return outPath;
}
