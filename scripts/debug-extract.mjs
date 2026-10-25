// 特定の記事URLに対して抽出器の挙動を診断する (debugワークフローから実行)
// usage: node scripts/debug-extract.mjs <記事URL>

import { parseHTML } from "linkedom";
import { fetchTextWithFallback } from "./fetchtext.mjs";
import { extract, BODY_SELECTORS } from "./build-articles.mjs";

let url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/debug-extract.mjs <url | 'feed <feedURL> <キーワード>'>");
  process.exit(1);
}

// "world-probe" なら世界ニュース用フィードの取得状況を、"world" なら地域別ランキングの試算を表示する
if (url === "world-probe" || url === "world") {
  const { run } = await import("./fetch-world.mjs");
  await run(url === "world" ? { dryRun: true } : { probe: true });
  process.exit(0);
}

// "world-text" なら、世界ニュースの記事ページから本文が取れるかを配信元ごとに確かめる。
// "world-digest" なら、公開中の世界ニュースの上位の話題に付いた要約を表示する
if (url.startsWith("world-text") || url.startsWith("world-digest")) {
  const { probe, show } = await import("./world-digest.mjs");
  const n = Number(url.split(/\s+/)[1]) || 3;
  await (url.startsWith("world-text") ? probe(n) : show(n));
  process.exit(0);
}

// "audit 0-9 2" なら feeds.json の0〜9番目のサイトの最新2記事ずつ、本文抽出の結果を点検する
if (url.startsWith("audit")) {
  const { audit } = await import("./audit-articles.mjs");
  await audit(url.slice(5));
  process.exit(0);
}

// "weather-probe" なら、天気のページで使うデータの取り方 (ブラウザから読めるか・データの形) を確かめる
if (url.startsWith("weather-probe")) {
  const mod = await import("./weather-probe.mjs");
  await { "weather-probe": mod.probe, "weather-probe2": mod.probe2, "weather-probe3": mod.probe3, "weather-probe4": mod.probe4, "weather-probe5": mod.probe5, "weather-probe6": mod.probe6, "weather-probe7": mod.probe7, "weather-probe8": mod.probe8, "weather-probe9": mod.probe9, "weather-probe10": mod.probe10 }[url]?.();
  process.exit(0);
}

// "reader-samples 1" なら、公開中の記事本文をサイトごとに1件ずつ、見本としてログに出す
if (url.startsWith("reader-samples")) {
  const { samples } = await import("./audit-articles.mjs");
  await samples(url.slice(14));
  process.exit(0);
}

// "snip 29.0 なんじぇい ;; 49.0 sel:.tab_area" なら、元ページの該当箇所のHTMLと抽出結果の同じ場所を出す
if (url.startsWith("snip")) {
  const { snip } = await import("./audit-articles.mjs");
  await snip(url.slice(4));
  process.exit(0);
}

// "feed <フィードURL> <キーワード>" 形式ならフィードから記事を探す
if (url.startsWith("feed ")) {
  const [, feedUrl, ...kw] = url.split(/\s+/);
  const keyword = kw.join(" ");
  const { parseFeed } = await import("./feedparser.mjs");
  const xml = await fetchTextWithFallback(feedUrl, 20_000, "application/rss+xml, application/xml, text/xml, */*");
  const items = parseFeed(xml);
  const hit = items.find((i) => keyword && i.title.includes(keyword)) ?? items[0];
  console.log(`=== feed mode: ${items.length} items, selected: "${hit?.title}"`);
  if (!hit) process.exit(1);
  url = hit.link;
}

const html = await fetchTextWithFallback(url, 20_000);
console.log(`=== page: ${url} (${html.length} chars)`);

const { document } = parseHTML(html);

console.log("\n=== 本文セレクタのマッチ状況");
for (const sel of BODY_SELECTORS) {
  const els = [...document.querySelectorAll(sel)];
  if (els.length > 0) {
    console.log(`  ${sel}: ${els.length} matches, textLen=[${els.map((e) => e.textContent.trim().length).join(", ")}]`);
  }
}

console.log("\n=== テキスト量の多いブロック候補 (子孫に大ブロックを持たない末端)");
const seen = new Set();
for (const el of document.querySelectorAll("div, article, section, td")) {
  const len = el.textContent.trim().length;
  if (len < 500) continue;
  const hasBigChild = [...el.children].some((c) => c.textContent.trim().length > len * 0.8);
  if (hasBigChild) continue;
  const cls = (el.getAttribute("class") ?? "").trim().replace(/\s+/g, ".");
  const label = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls ? `.${cls}` : ""}`;
  if (seen.has(label)) continue;
  seen.add(label);
  const head = el.textContent.trim().slice(0, 60).replace(/\s+/g, " ");
  console.log(`  ${label}: textLen=${len} head="${head}"`);
}

const label = (el) => {
  const cls = (el.getAttribute?.("class") ?? "").trim().replace(/\s+/g, ".");
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls ? `.${cls}` : ""}`;
};

console.log("\n=== 続きコンテナ(.more_body/#more)の周辺構造");
const more = document.querySelector(".more_body, #more, .article-body-more");
if (more) {
  let anc = more;
  const chain = [];
  while (anc && chain.length < 5) {
    chain.push(label(anc));
    anc = anc.parentElement;
  }
  console.log(`  ancestor chain: ${chain.join(" < ")}`);
  const parent = more.parentElement;
  if (parent) {
    for (const c of parent.children) {
      console.log(`  sibling: ${label(c)} textLen=${c.textContent.trim().length}`);
    }
  }
} else {
  console.log("  なし");
}

console.log("\n=== ツイート埋め込み・iframeの状況");
for (const bq of document.querySelectorAll("blockquote")) {
  const cls = bq.getAttribute("class") ?? "";
  if (!/twitter|tweet|instagram|imgur|tiktok/i.test(cls)) continue;
  const links = [...bq.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
  console.log(`  blockquote[${cls}]: links=${JSON.stringify(links.slice(0, 5))}`);
}
const iframes = [...document.querySelectorAll("iframe")].map((f) =>
  (f.getAttribute("src") ?? f.getAttribute("data-src") ?? "").slice(0, 100),
);
if (iframes.length > 0) console.log(`  iframes: ${JSON.stringify(iframes.slice(0, 10))}`);

console.log("\n=== extract() の結果");
const res = await extract(html, url);
if (!res) {
  console.log("  FAILED (no content)");
} else {
  const text = res.html.replace(/<[^>]*>/g, "");
  const imgs = (res.html.match(/<img/g) ?? []).length;
  const videos = (res.html.match(/<video/g) ?? []).length;
  console.log(`  html=${res.html.length} text=${text.length} img=${imgs} video=${videos} related=${res.related.length}`);
  console.log(`  head: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
  console.log(`  tail: ${text.slice(-200).replace(/\s+/g, " ")}`);
  if (res.html.length < 6000) {
    console.log("--- full html ---");
    console.log(res.html);
    console.log("--- end html ---");
  }
}
