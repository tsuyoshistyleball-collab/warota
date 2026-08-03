// data.json の各記事の本文を取得し、広告・スクリプトを除去した
// クリーンな HTML を public/articles/<hash>.json として保存する。
// 前回デプロイ済みの記事は Pages から再利用し、新規分だけ抽出する。
// 依存: linkedom, @mozilla/readability (ワークフロー内で npm install する)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { fetchText } from "./fetchtext.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "public");
const ART_DIR = path.join(OUT, "articles");
const PAGES_BASE = (process.env.PAGES_BASE ?? "").replace(/\/+$/, "");
const MAX_NEW = 300; // 1回の実行で新規抽出する記事数の上限
const CONCURRENCY = 12;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_CHARS = 300_000; // 1記事あたりの本文サイズ上限
// 抽出フォーマットのバージョン。上げると全記事が再抽出される
// (v2: 文字コード自動判定 / v3: 関連記事リンクの収集を追加)
const ART_VERSION = 3;

const hashUrl = (u) => createHash("sha1").update(u).digest("hex").slice(0, 16);

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// ---- 本文抽出 ----

// まとめブログでよく使われる本文コンテナ (優先順)
const BODY_SELECTORS = [
  ".article-body-inner",
  ".article-body",
  "#article-body",
  ".entry-content",
  ".ently_text",
  ".entry_body",
  ".post-content",
  ".post_content",
  "#article_body",
  ".article_body",
  ".main-article-body",
];

const BLOCK_TAGS = new Set([
  "SCRIPT", "STYLE", "IFRAME", "INS", "FORM", "BUTTON", "INPUT", "SELECT",
  "TEXTAREA", "NOSCRIPT", "SVG", "CANVAS", "AUDIO", "VIDEO", "OBJECT",
  "EMBED", "LINK", "META", "ASIDE", "NAV", "FOOTER", "HEADER", "TEMPLATE",
]);
const KEEP_TAGS = new Set([
  "P", "BLOCKQUOTE", "B", "STRONG", "I", "EM", "U", "S", "SMALL",
  "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI",
  "TABLE", "THEAD", "TBODY", "TR", "TD", "TH",
  "FIGURE", "FIGCAPTION", "DL", "DT", "DD", "PRE", "CODE",
]);
const WRAP_AS_DIV = new Set(["DIV", "SECTION", "ARTICLE", "MAIN", "CENTER", "FONT"]);
// 広告・SNS・関連記事などのコンテナを class/id 名で除外
const AD_RE =
  /(^|[\s_-])(ad|ads|advert|adsense|admax|sponsor|banner|outbrain|taboola|popin|zucks|nend|imobile|uzou|logly|share|sns|social|relat|related|recommend|rank|ranking|comment|breadcrumb|pager|paging|widget|blogroll|rss|newsletter|cta)([\s_-]|$)/i;

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function absUrl(u, base) {
  if (!u) return null;
  try {
    const abs = new URL(u, base).href;
    return /^https?:\/\//.test(abs) ? abs : null;
  } catch {
    return null;
  }
}

// 文字色だけ style 属性から引き継ぐ (まとめ記事の色付きレスを保持)
function colorStyle(node) {
  const style = node.getAttribute?.("style") ?? "";
  const m = style.match(/(?:^|;)\s*color\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[a-zA-Z]+)/);
  return m ? ` style="color:${esc(m[1])}"` : "";
}

function sanitize(node, base, budget) {
  if (budget.used > MAX_HTML_CHARS) return "";
  if (node.nodeType === 3) {
    const text = esc(node.textContent);
    budget.used += text.length;
    return text;
  }
  if (node.nodeType !== 1) return "";
  const tag = node.tagName;
  const marker = `${node.getAttribute?.("class") ?? ""} ${node.getAttribute?.("id") ?? ""}`;
  if (BLOCK_TAGS.has(tag) || AD_RE.test(marker)) return "";

  if (tag === "IMG") {
    const src = absUrl(
      node.getAttribute("data-src") || node.getAttribute("data-original") || node.getAttribute("src"),
      base,
    );
    if (!src) return "";
    budget.used += 100;
    return `<img src="${esc(src)}" loading="lazy" referrerpolicy="no-referrer">`;
  }
  if (tag === "BR") return "<br>";
  if (tag === "HR") return "<hr>";

  let inner = "";
  for (const child of node.childNodes) inner += sanitize(child, base, budget);

  if (tag === "A") {
    const href = absUrl(node.getAttribute("href"), base);
    return href
      ? `<a href="${esc(href)}" target="_blank" rel="noopener nofollow">${inner}</a>`
      : inner;
  }
  if (KEEP_TAGS.has(tag)) {
    const t = tag.toLowerCase();
    return `<${t}${colorStyle(node)}>${inner}</${t}>`;
  }
  if (WRAP_AS_DIV.has(tag)) return inner.trim() ? `<div${colorStyle(node)}>${inner}</div>` : "";
  if (tag === "SPAN") return inner.trim() ? `<span${colorStyle(node)}>${inner}</span>` : "";
  return inner; // 未知のタグはタグだけ剥がして中身を残す
}

// ページ内から同一ブログの他記事へのリンク (関連記事・人気記事など) を集める
function collectRelated(document, url) {
  let self;
  try {
    self = new URL(url);
  } catch {
    return [];
  }
  const selfHost = self.hostname.replace(/^www\./, "");
  const seen = new Set([self.origin + self.pathname]);
  const out = [];
  for (const a of document.querySelectorAll("a[href]")) {
    if (out.length >= 10) break;
    const text = (a.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length < 10 || text.length > 150) continue;
    let href;
    try {
      href = new URL(a.getAttribute("href"), url);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(href.protocol)) continue;
    if (href.hostname.replace(/^www\./, "") !== selfHost) continue;
    // 記事URLらしいものだけ (アーカイブ/記事ID形式)
    const target = href.pathname + href.search;
    if (!/\/archives?\/\d+|\/archives?\/[\w-]+\.html|\/article\/\d+|\/\d{4,}\.html|[?&]p=\d+/.test(target)) {
      continue;
    }
    const key = href.origin + href.pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([text.slice(0, 120), href.origin + href.pathname + href.search]);
  }
  return out;
}

function extract(html, url) {
  const { document } = parseHTML(html);
  let root = null;
  for (const sel of BODY_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim().length > 100) {
      root = el;
      break;
    }
  }
  if (!root) {
    try {
      const article = new Readability(document, { charThreshold: 100 }).parse();
      if (article?.content) {
        root = parseHTML(`<div>${article.content}</div>`).document.querySelector("div");
      }
    } catch {}
  }
  if (!root) return null;
  const budget = { used: 0 };
  const out = sanitize(root, url, budget).trim();
  const text = out.replace(/<[^>]*>/g, "").trim();
  // 文字化け (置換文字が多い) は抽出失敗として扱う
  const garbled = (text.match(/�/g) ?? []).length;
  if (garbled > 5) return null;
  // タグを除いた実質テキストが少なすぎる場合は抽出失敗扱い
  if (text.length <= 100 && !out.includes("<img")) return null;
  return { html: out, related: collectRelated(document, url) };
}

// ---- メイン ----

const dataPath = path.join(OUT, "data.json");
const data = JSON.parse(await readFile(dataPath, "utf8"));
await mkdir(ART_DIR, { recursive: true });

// 1. 前回デプロイ済みの抽出結果を Pages から復元
let restored = 0;
if (PAGES_BASE) {
  await pool(data.items, 16, async (item) => {
    const h = hashUrl(item[2]);
    try {
      const res = await fetch(`${PAGES_BASE}/articles/${h}.json`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;
      const text = await res.text();
      // 旧フォーマット(文字化けの可能性あり)は捨てて再抽出させる
      if (JSON.parse(text).v !== ART_VERSION) return;
      await writeFile(path.join(ART_DIR, `${h}.json`), text);
      item[4] = h;
      restored++;
    } catch {}
  });
}

// 2. 未抽出の記事を新規に抽出
const pending = data.items.filter((item) => !item[4]).slice(0, MAX_NEW);
let extracted = 0;
let failed = 0;
await pool(pending, CONCURRENCY, async (item) => {
  const [, title, url] = item;
  try {
    const html = await fetchText(url, FETCH_TIMEOUT_MS);
    const body = extract(html, url);
    if (!body) throw new Error("no content");
    const h = hashUrl(url);
    await writeFile(
      path.join(ART_DIR, `${h}.json`),
      JSON.stringify({ v: ART_VERSION, title, url, html: body.html, related: body.related }),
    );
    item[4] = h;
    extracted++;
  } catch (err) {
    console.error(`NG article: ${url} (${err.message})`);
    failed++;
  }
});

await writeFile(dataPath, JSON.stringify(data));
const skipped = data.items.filter((item) => !item[4]).length;
console.log(
  `articles: ${restored} restored, ${extracted} extracted, ${failed} failed, ${skipped} without reader`,
);
