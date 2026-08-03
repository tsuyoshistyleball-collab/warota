// feeds.json の各フィードを取得して public/data.json を生成する。
// GitHub Actions 上で定期実行される想定 (依存パッケージなし / Node 20+)。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseFeed } from "./feedparser.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FETCH_TIMEOUT_MS = 20_000;
const MAX_ITEMS_PER_SITE = 50;
const MAX_ITEMS_TOTAL = 1500;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function fetchFeed(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "application/rss+xml, application/xml, text/xml, */*",
      "accept-language": "ja,en;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function errDetail(err) {
  const parts = [err?.message];
  let cause = err?.cause;
  while (cause) {
    parts.push(cause.code ?? cause.message);
    cause = cause.cause;
  }
  return parts.filter(Boolean).join(" / ");
}

// https で失敗したら http(またはその逆)でも試す
async function fetchFeedWithFallback(url) {
  try {
    return await fetchFeed(url);
  } catch (err) {
    const alt = url.startsWith("https://")
      ? url.replace(/^https:/, "http:")
      : url.replace(/^http:/, "https:");
    try {
      return await fetchFeed(alt);
    } catch {
      throw new Error(errDetail(err));
    }
  }
}

const feeds = JSON.parse(await readFile(path.join(ROOT, "feeds.json"), "utf8"));
const now = Date.now();

const results = await Promise.allSettled(
  feeds.map(async (feed) => {
    const xml = await fetchFeedWithFallback(feed.url);
    const items = parseFeed(xml);
    if (items.length === 0) throw new Error("no items parsed");
    return items;
  }),
);

const sites = [];
const items = [];
const seen = new Set();

results.forEach((result, i) => {
  const feed = feeds[i];
  if (result.status === "rejected") {
    console.error(`NG ${feed.name}: ${result.reason?.message ?? result.reason}`);
    return;
  }
  const siteIndex = sites.length;
  sites.push({ name: feed.name, category: feed.category ?? "その他" });
  let count = 0;
  for (const item of result.value) {
    if (count >= MAX_ITEMS_PER_SITE) break;
    const ts = item.ts ?? now;
    if (now - ts > MAX_AGE_MS || ts > now + 60 * 60 * 1000) continue;
    if (seen.has(item.link)) continue;
    seen.add(item.link);
    items.push([siteIndex, item.title, item.link, ts]);
    count++;
  }
  console.log(`OK ${feed.name}: ${count} items`);
});

items.sort((a, b) => b[3] - a[3]);
items.length = Math.min(items.length, MAX_ITEMS_TOTAL);

const out = { updated: now, sites, items };
const outDir = path.join(ROOT, "public");
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, "data.json"), JSON.stringify(out));

console.log(`\n${sites.length}/${feeds.length} feeds, ${items.length} items -> public/data.json`);
if (sites.length === 0) {
  console.error("all feeds failed");
  process.exit(1);
}
