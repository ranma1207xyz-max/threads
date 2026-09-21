import { execFileSync } from "child_process";

const POLL_ATTEMPTS = 12;
const POLL_INTERVAL_MS = 2500;

function git(...args: string[]): void {
  execFileSync("git", args, { stdio: "inherit" });
}

// Threads only accepts a publicly reachable image URL, so a rendered card is
// committed and pushed to this (public) GitHub repository and served from
// raw.githubusercontent.com. Only meaningful inside GitHub Actions, where the
// checkout has push rights and a git identity configured.
export async function hostCardOnGitHub(localPath: string): Promise<string> {
  const repository = process.env.GITHUB_REPOSITORY;
  const branch = process.env.GITHUB_REF_NAME;
  if (process.env.GITHUB_ACTIONS !== "true" || !repository || !branch) {
    throw new Error("Card hosting only runs inside GitHub Actions.");
  }

  git("add", "-f", localPath);
  git("commit", "-m", `chore: add cheat-sheet card ${localPath} [skip ci]`);
  git("pull", "--rebase", "origin", branch);
  git("push", "origin", `HEAD:${branch}`);

  const url = `https://raw.githubusercontent.com/${repository}/${branch}/${localPath}`;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { method: "HEAD" });
      if (response.ok) return url;
    } catch {
      // Not reachable yet; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Card was pushed but never became reachable at ${url}`);
}
