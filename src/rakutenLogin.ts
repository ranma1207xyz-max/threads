import { chromium } from "playwright";

const SESSION_STATE_PATH = "data/rakuten-session.json";

// One-time interactive helper: opens a real (headed) browser window so you
// can log in to Rakuten Affiliate by hand (including any 2FA / checkpoint
// challenge), then saves the logged-in session to data/rakuten-session.json.
// Mirrors threadsLogin.ts — same reasoning: a saved session lets the
// scheduled report script (runRakutenReport.ts) reuse a single manual login
// instead of the automation ever touching the owner's Rakuten password.
//
// Run locally: npm run rakuten:login
// The session file is gitignored — never commit it. For GitHub Actions,
// base64 it and store it as the RAKUTEN_SESSION_STATE_B64 secret (see README).
async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ locale: "ja-JP" });
  const page = await context.newPage();
  await page.goto("https://affiliate.rakuten.co.jp/");

  console.log("");
  console.log("ブラウザが開きます。手動で楽天アフィリエイトにログインしてください(2段階認証があれば完了させる)。");
  console.log("「今月の成果情報」のページ(マイページ)が表示されるところまで進めてください。");
  console.log("ログインが完了したら、このターミナルに戻って Enter キーを押してください。");
  console.log("");

  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });

  await context.storageState({ path: SESSION_STATE_PATH });
  console.log(`セッションを ${SESSION_STATE_PATH} に保存しました。`);

  await browser.close();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
