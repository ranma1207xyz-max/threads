import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  threadsAccessToken: requireEnv("THREADS_ACCESS_TOKEN"),
  threadsUserId: requireEnv("THREADS_USER_ID"),
  anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
  maxPostLength: 500,
};
