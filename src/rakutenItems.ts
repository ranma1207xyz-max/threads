// Rakuten Ichiba Item Search (the 2026-02 API: openapi.rakuten.co.jp, needs
// both applicationId and a pk_ accessKey, plus a Referer/Origin matching the
// app's registered site). With affiliateId set, each item comes back with its
// own affiliate link, so "trend" posts can link the exact product a trending
// post introduced (2026-10-07 owner decision) without a hand-made link.
const ENDPOINT = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601";

export interface RakutenItem {
  itemCode: string;
  name: string;
  affiliateUrl: string;
  caption: string;
  price: number;
  shopName: string;
  reviewCount: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function hasRakutenApiConfig(): boolean {
  return Boolean(process.env.RAKUTEN_APP_ID && process.env.RAKUTEN_ACCESS_KEY && process.env.RAKUTEN_AFFILIATE_ID);
}

export async function searchRakutenItems(keyword: string, hits = 10): Promise<RakutenItem[]> {
  const referer = process.env.RAKUTEN_REFERER || "https://github.com/";
  const params = new URLSearchParams({
    applicationId: requireEnv("RAKUTEN_APP_ID"),
    accessKey: requireEnv("RAKUTEN_ACCESS_KEY"),
    affiliateId: requireEnv("RAKUTEN_AFFILIATE_ID"),
    keyword,
    hits: String(hits),
    availability: "1",
    format: "json",
    formatVersion: "2",
  });
  const response = await fetch(`${ENDPOINT}?${params}`, {
    headers: { Referer: referer, Origin: new URL(referer).origin },
  });
  if (!response.ok) {
    throw new Error(`Rakuten item search failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  const data = (await response.json()) as { Items?: Record<string, unknown>[] };
  return (data.Items ?? [])
    .map((item) => ({
      itemCode: String(item.itemCode ?? ""),
      name: String(item.itemName ?? ""),
      affiliateUrl: String(item.affiliateUrl ?? ""),
      caption: String(item.itemCaption ?? ""),
      price: Number(item.itemPrice ?? 0),
      shopName: String(item.shopName ?? ""),
      reviewCount: Number(item.reviewCount ?? 0),
    }))
    // An item without an affiliate link earns nothing; never post it.
    .filter((item) => item.itemCode && item.affiliateUrl);
}
