import { chromium } from "playwright";

const SESSION_STATE_PATH = "data/threads-session.json";

// One-time interactive helper: opens a real (headed) browser window so you
// can log in to Threads by hand (including any 2FA / checkpoint challenge),
// then saves the logged-in session to data/threads-session.json.
//
// The browser research scripts (runResearch.ts) reuse this saved session
// instead of logging in on every run, which avoids repeated automated-login
// attempts that are far more likely to get flagged than a single manual one.
//
// Run locally: npm run research:login
// The session file is gitignored — never commit it. For GitHub Actions, base64
// it and store it as the THREADS_SESSION_STATE_B64 secret (see README).
async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ locale: "ja-JP" });
  const page = await context.newPage();
  await page.goto("https://www.threads.com/login");

  console.log("");
  console.log("ブラウザが開きます。手動でThreadsにログインしてください(2段階認証があれば完了させる)。");
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
