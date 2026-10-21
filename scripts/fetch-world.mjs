// world-feeds.json のニュースフィードを取得して、地域別の話題ニュース public/world.json を作る。
// GitHub Actions 上で定期実行される想定 (依存パッケージなし / Node 20+)。
//   node scripts/fetch-world.mjs          … 通常実行 (world.json を書き出す)
//   node scripts/fetch-world.mjs --probe  … フィードごとの取得状況だけを表示 (メンテ用)

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { parseFeed } from "./feedparser.mjs";
import { fetchTextWithFallback } from "./fetchtext.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FEED_TIMEOUT_MS = 20_000;

async function loadFeeds() {
  return JSON.parse(await readFile(path.join(ROOT, "world-feeds.json"), "utf8"));
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

// 全フィードを並列取得する。失敗したフィードは error を持たせて返す
async function fetchAllFeeds(feeds) {
  const results = await Promise.allSettled(
    feeds.map(async (feed) => {
      const xml = await fetchTextWithFallback(
        feed.url,
        FEED_TIMEOUT_MS,
        "application/rss+xml, application/xml, text/xml, */*",
      );
      const items = parseFeed(xml);
      if (items.length === 0) throw new Error(`no items parsed (${xml.length} chars)`);
      return items;
    }),
  );
  return results.map((r, i) =>
    r.status === "fulfilled"
      ? { feed: feeds[i], items: r.value }
      : { feed: feeds[i], items: [], error: errDetail(r.reason) },
  );
}

function fmt(ts) {
  if (!ts) return "-";
  const d = new Date(ts + 9 * 3600_000); // JST 表示
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function printProbe(results) {
  for (const { feed, items, error } of results) {
    if (error) {
      console.log(`NG  ${feed.name}: ${error}`);
      continue;
    }
    const withDesc = items.filter((it) => it.description && it.description !== it.title);
    const avgDesc = withDesc.length
      ? Math.round(withDesc.reduce((n, it) => n + it.description.length, 0) / withDesc.length)
      : 0;
    const dates = items.map((it) => it.ts).filter(Boolean);
    const hosts = new Map();
    for (const it of items) {
      const h = new URL(it.link).host;
      hosts.set(h, (hosts.get(h) ?? 0) + 1);
    }
    const topHost = [...hosts].sort((a, b) => b[1] - a[1])[0]?.[0];
    console.log(
      `OK  ${feed.name}: items=${items.length} desc=${withDesc.length}(avg ${avgDesc}) ` +
        `img=${items.filter((it) => it.image).length} dated=${dates.length} ` +
        `newest=${fmt(Math.max(...dates, 0))} oldest=${fmt(dates.length ? Math.min(...dates) : 0)} host=${topHost}`,
    );
    for (const it of items.slice(0, 2)) {
      console.log(`      - ${it.title.slice(0, 50)} | ${(it.description || "(なし)").slice(0, 70)}${it.image ? " | img" : ""}`);
    }
  }
}

export async function run({ probe = false } = {}) {
  const feeds = await loadFeeds();
  const results = await fetchAllFeeds(feeds);
  if (probe) {
    printProbe(results);
    return;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run({ probe: process.argv.includes("--probe") });
}
