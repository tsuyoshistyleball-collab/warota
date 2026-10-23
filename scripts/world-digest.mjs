// 世界ニュースの話題ごとに、記事の本文を読みに行き、アプリの中で読める要約を作る。
// fetch-world.mjs が書き出した public/world.json に要約を書き足す (fetch-world.mjs の後に実行)。
// 依存: linkedom, @mozilla/readability (ワークフロー内で npm install する)
//   node scripts/world-digest.mjs  … 通常実行

import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { fetchText } from "./fetchtext.mjs";

const PAGE_TIMEOUT_MS = 12_000;
const PAGES_BASE = process.env.PAGES_BASE ?? "https://tsuyoshistyleball-collab.github.io/warota";

// 本文の段落に分ける (段落・改行・箇条書きの区切りで)
function paragraphsOf(html) {
  return html
    .replace(/<(br|\/?(p|div|li|ul|ol|h[1-6]|blockquote|table|tr|section|article|figure|figcaption))\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// 記事ページから本文の段落を取り出す
export async function articleText(url) {
  const html = await fetchText(url, PAGE_TIMEOUT_MS, "text/html");
  const { document } = parseHTML(html);
  const article = new Readability(document, { charThreshold: 200 }).parse();
  return { paragraphs: article?.content ? paragraphsOf(article.content) : [], title: article?.title ?? "" };
}

// 調査用: 公開中の world.json の記事 (代表記事と、同じ話題を伝えた他社の記事) から本文が取れるかを、配信元ごとに確かめる
export async function probe(perHost = 3) {
  const world = await (await fetch(`${PAGES_BASE}/world.json?t=${Date.now()}`)).json();
  const byHost = new Map();
  for (const r of world.regions) {
    for (const it of r.items) {
      for (const [outlet, url] of [[it.source, it.url], ...(it.coverage ?? []).map((c) => [c.s, c.u])]) {
        let host = "";
        try {
          host = new URL(url).host;
        } catch {
          continue;
        }
        const list = byHost.get(host) ?? [];
        if (list.length < perHost && !list.some((x) => x.url === url)) list.push({ outlet, url });
        byHost.set(host, list);
      }
    }
  }
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
  for (const [host, list] of [...byHost].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`\n######## ${host}`);
    for (const { outlet, url } of list) {
      const started = Date.now();
      try {
        const { paragraphs } = await articleText(url);
        const chars = paragraphs.reduce((n, p) => n + p.length, 0);
        console.log(`--- ${outlet} ${url}\n    ${Date.now() - started}ms chars=${chars} paras=${paragraphs.length}`);
        for (const p of paragraphs.slice(0, 3)) console.log(`    | ${clip(p, 110)}`);
        if (paragraphs.length > 3) console.log(`    … ${clip(paragraphs.at(-1), 80)}`);
      } catch (err) {
        console.log(`--- ${outlet} ${url}\n    NG ${err.message}`);
      }
    }
  }
}
