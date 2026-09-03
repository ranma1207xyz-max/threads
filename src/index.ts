import { readFileSync, writeFileSync } from "fs";
import { generatePostText, type Product, type StyleExample } from "./contentGenerator.js";
import { postToThreads } from "./threadsClient.js";

const PRODUCTS_PATH = "data/products.json";
const STYLE_EXAMPLES_PATH = "data/style-examples.json";
const POSTED_LOG_PATH = "data/posted-log.json";

interface PostedLogEntry {
  productId: string;
  postedAt: string;
  threadsPostId: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function pickNextProduct(products: Product[], log: PostedLogEntry[]): Product {
  const lastPostedAt = new Map<string, string>();
  for (const entry of log) {
    lastPostedAt.set(entry.productId, entry.postedAt);
  }

  const sorted = [...products].sort((a, b) => {
    const aTime = lastPostedAt.get(a.id) ?? "";
    const bTime = lastPostedAt.get(b.id) ?? "";
    return aTime.localeCompare(bTime);
  });

  return sorted[0];
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const products = readJson<Product[]>(PRODUCTS_PATH);
  const styleExamples = readJson<StyleExample[]>(STYLE_EXAMPLES_PATH);
  const log = readJson<PostedLogEntry[]>(POSTED_LOG_PATH);

  if (products.length === 0) {
    throw new Error("data/products.json is empty. Add at least one product.");
  }

  const product = pickNextProduct(products, log);
  const text = await generatePostText(product, styleExamples);

  console.log("=== Generated post ===");
  console.log(text);
  console.log("=======================");

  if (dryRun) {
    console.log("Dry run: skipping actual post to Threads.");
    return;
  }

  const threadsPostId = await postToThreads(text, product.imageUrl);
  console.log(`Posted to Threads: ${threadsPostId}`);

  log.push({
    productId: product.id,
    postedAt: new Date().toISOString(),
    threadsPostId,
  });
  writeFileSync(POSTED_LOG_PATH, JSON.stringify(log, null, 2) + "\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
