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
         background: linear-gradient(160deg, #fdf7f2 0%, #f6e6e3 100%); color: #3b2f2f; padding: 72px 72px 120px; display: flex; flex-direction: column; }
  .title { font-size: 68px; font-weight: 900; letter-spacing: 2px; text-align: center; }
  .sub { margin: 14px 0 44px; font-size: 30px; font-weight: 500; text-align: center; color: #8a6f6b; }
  .rows { flex: 1; display: flex; flex-direction: column; justify-content: center; }
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
  <div class="rows">${rowsHtml}</div>
  <div class="foot">※一般に言われている目安で、効果を保証するものではありません</div>
</body></html>`;
}

// Renders the cheat-sheet as a PNG card. Fonts come from Google Fonts at render
// time (the CI runner has no Japanese fonts by default), with system fallbacks.
export async function renderCheatsheetCard(rows: CheatsheetRow[], outPath: string): Promise<string> {
  return renderHtml(buildHtml(rows), outPath);
}

async function renderHtml(html: string, outPath: string): Promise<string> {
  mkdirSync(dirname(outPath), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: CARD_WIDTH, height: CARD_HEIGHT } });
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: outPath, type: "png" });
  } finally {
    await browser.close();
  }
  return outPath;
}

// --- "悩み別の組み合わせ表" card (2026-10-03 owner decision) ---
// Our own take on the by-concern photo grid that drew 2,909 views on 10/2
// 20:00 (Anua serums photographed two by two under each concern): a 2-column
// grid of panels, each with the concern in large type and two illustrated
// dropper bottles labeled with ingredient names. The bottles are drawn in
// CSS and carry no brand, so no one else's photo or trademark is used.
export interface ComboPanel {
  concern: string;
  ingredients: string[]; // exactly 2 ingredient names
  timing?: "朝" | "夜" | "朝夜";
}

const MIN_PANELS = 4;
const MAX_PANELS = 6;

// Pulls lines like these out of the "combo" hook:
//   シミ・くすみ → ナイアシンアミド+ビタミンC(夜)
//   ・毛穴 → レチノール ＋ ナイアシンアミド【夜】
export function parseComboPanels(hook: string): ComboPanel[] {
  const panels: ComboPanel[] = [];
  for (const rawLine of hook.split("\n")) {
    const line = rawLine.replace(/^[\s・•●▪\-]+/, "").trim();
    const match = line.match(/^(.{1,12}?)\s*(?:→|➡|⇒|->)\s*(.+)$/);
    if (!match) continue;
    let rest = match[2].trim();
    let timing: ComboPanel["timing"];
    const timingMatch = rest.match(/[（(【\[]\s*(朝夜|朝・夜|朝も夜も|朝|夜)\s*[）)】\]]\s*$/);
    if (timingMatch) {
      timing = timingMatch[1] === "朝" ? "朝" : timingMatch[1] === "夜" ? "夜" : "朝夜";
      rest = rest.slice(0, timingMatch.index).trim();
    }
    const ingredients = rest
      .split(/\s*[+＋×]\s*/)
      .map((name) => name.replace(/[「」『』]/g, "").trim())
      .filter((name) => name.length > 0 && name.length <= 12);
    if (ingredients.length === 2) {
      panels.push({ concern: match[1].trim(), ingredients, timing });
    }
  }
  // The grid has 2 columns, so an odd count would leave an empty square.
  const kept = panels.slice(0, MAX_PANELS);
  return kept.slice(0, kept.length - (kept.length % 2));
}

export function hasEnoughPanels(panels: ComboPanel[]): boolean {
  return panels.length >= MIN_PANELS;
}

// Liquid colors for the bottles, picked per ingredient so the same ingredient
// always looks the same across posts.
const BOTTLE_COLORS = ["#f2a7a0", "#9fd6cf", "#f6d58b", "#c8b6e8", "#a9cfa0", "#f4b9cf", "#9ec4ea"];
function colorFor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return BOTTLE_COLORS[hash % BOTTLE_COLORS.length];
}

// The two bottles in one panel never share a color, so they read as two items.
function bottleColors(names: string[]): string[] {
  const colors = names.map(colorFor);
  if (colors.length === 2 && colors[0] === colors[1]) {
    colors[1] = BOTTLE_COLORS[(BOTTLE_COLORS.indexOf(colors[1]) + 1) % BOTTLE_COLORS.length];
  }
  return colors;
}

function bottleHtml(name: string, height: number, color: string): string {
  // The name sits on one line under the bottle; long names get smaller type
  // so even "ナイアシンアミド" fits the column without breaking mid-word.
  const fontSize = Math.min(34, Math.floor(214 / name.length));
  return `
    <div class="item">
      <div class="bottle" style="height:${height}px">
        <div class="bulb"></div><div class="collar"></div>
        <div class="body"><div class="liquid" style="background:${color}"></div></div>
      </div>
      <div class="name" style="font-size:${fontSize}px">${escapeHtml(name)}</div>
    </div>`;
}

function buildComboHtml(panels: ComboPanel[]): string {
  const rowsCount = Math.ceil(panels.length / 2);
  const panelHeight = Math.floor((CARD_HEIGHT - 190 - 70 - (rowsCount - 1) * 18) / rowsCount);
  // With only 2 rows the panels are much taller, so the bottles are drawn
  // larger (CSS zoom) instead of leaving the upper half empty.
  const bottleZoom = rowsCount <= 2 ? 1.6 : 1;
  const bottleHeight = Math.floor(Math.min(200, (panelHeight - 170) / bottleZoom));
  const panelsHtml = panels
    .map(
      (panel) => `
      <div class="panel" style="height:${panelHeight}px">
        <div class="concern">${escapeHtml(panel.concern)}</div>
        ${panel.timing ? `<div class="timing">${panel.timing === "朝夜" ? "朝・夜" : panel.timing}</div>` : ""}
        <div class="bottles">${panel.ingredients.map((name, i) => bottleHtml(name, bottleHeight, bottleColors(panel.ingredients)[i])).join("")}</div>
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
         background: #efe9e4; color: #2f2a2a; padding: 40px 36px 0; position: relative; }
  .title { font-size: 64px; font-weight: 900; letter-spacing: 3px; text-align: center; }
  .sub { margin: 6px 0 26px; font-size: 26px; font-weight: 500; text-align: center; color: #8a7a74; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  .panel { position: relative; border-radius: 26px; overflow: hidden;
           background: linear-gradient(180deg, #5e5856 0%, #8c8580 52%, #f4f1ee 52%, #ffffff 100%);
           display: flex; flex-direction: column; align-items: center; padding-top: 18px; }
  .concern { font-size: 50px; font-weight: 900; color: #ffffff; letter-spacing: 2px; text-shadow: 0 2px 8px rgba(0,0,0,0.35);
             white-space: nowrap; }
  .timing { position: absolute; top: 20px; right: 18px; font-size: 22px; font-weight: 700; color: #5e5856;
            background: #fff6d6; border-radius: 999px; padding: 4px 14px; }
  .bottles { flex: 1; display: flex; align-items: flex-end; justify-content: center; gap: 12px; padding-bottom: 16px; }
  .item { width: 228px; display: flex; flex-direction: column; align-items: center; }
  .name { margin-top: 10px; height: 44px; display: flex; align-items: center; font-weight: 900; color: #3a3333; white-space: nowrap; }
  .bottle { zoom: ${bottleZoom}; width: 104px; display: flex; flex-direction: column; align-items: center; filter: drop-shadow(10px 12px 10px rgba(0,0,0,0.22)); }
  .bulb { width: 36px; height: 36px; background: #fbfbfb; border-radius: 18px 18px 8px 8px; }
  .collar { width: 50px; height: 24px; margin-top: -4px; border-radius: 6px;
            background: repeating-linear-gradient(180deg, #d9d9d9 0 4px, #b9b9b9 4px 7px); }
  .body { position: relative; flex: 1; width: 104px; border-radius: 22px 22px 18px 18px; overflow: hidden;
          background: rgba(255,255,255,0.75); border: 2px solid rgba(255,255,255,0.9); }
  .liquid { position: absolute; left: 0; right: 0; bottom: 0; height: 62%; opacity: 0.85; }
  .foot { position: absolute; left: 0; right: 0; bottom: 22px; text-align: center; font-size: 22px; color: #9b8b85; }
</style></head>
<body>
  <div class="title">悩み別 組み合わせ表</div>
  <div class="sub">気になる悩みで選びがちな成分の組み合わせの目安</div>
  <div class="grid">${panelsHtml}</div>
  <div class="foot">※一般に言われている目安で、効果を保証するものではありません</div>
</body></html>`;
}

export async function renderComboCard(panels: ComboPanel[], outPath: string): Promise<string> {
  return renderHtml(buildComboHtml(panels), outPath);
}
