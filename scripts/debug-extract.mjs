// 特定の記事URLに対して抽出器の挙動を診断する (debugワークフローから実行)
// usage: node scripts/debug-extract.mjs <記事URL>

import { parseHTML } from "linkedom";
import { fetchText } from "./fetchtext.mjs";
import { extract, BODY_SELECTORS } from "./build-articles.mjs";

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/debug-extract.mjs <url>");
  process.exit(1);
}

const html = await fetchText(url, 20_000);
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
}
