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
import { fetchText, fetchTextWithFallback } from "./fetchtext.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "public");
const ART_DIR = path.join(OUT, "articles");
const PAGES_BASE = (process.env.PAGES_BASE ?? "").replace(/\/+$/, "");
const MAX_NEW = 300; // 1回の実行で新規抽出する記事数の上限
const CONCURRENCY = 12;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_CHARS = 300_000; // 1記事あたりの本文サイズ上限
// 抽出フォーマットのバージョン。上げると全記事が再抽出される
// (v2: 文字コード自動判定 / v3: 関連記事リンク / v4: ツイート画像とスポンサー枠除去 /
//  v5: 関連記事を最大30件・サムネイル付きに拡大、動画リンクをプレーヤー化 /
//  v6: 画像直リンクをインライン画像に変換 / v7-9: 不思議.net系の本文セレクタ調整 /
//  v10: ツイート動画をプレーヤーとして埋め込み / v11: 元サイトの装飾・クラスを保持 /
//  v12: 痛いニュース対応 + 短すぎる抽出結果のReadabilityフォールバック)
const ART_VERSION = 12;
// X(Twitter)の埋め込みツイートの画像取得に使う公開エンドポイント
const TWEET_API = process.env.TWEET_API_BASE ?? "https://cdn.syndication.twimg.com";

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
export const BODY_SELECTORS = [
  ".article-body-inner",
  ".article-body",
  "#article-body",
  ".blogbody", // 痛いニュース等の旧livedoorテンプレート (レス群を含む)
  ".entry-content",
  ".ently_text",
  ".entry_body",
  ".post-content",
  ".post_content",
  "#article_body",
  ".article_body",
  ".main-article-body",
  ".main_content_bgColor > .article_box_upper", // 不思議.net 等 (本文前半、続きは .more_body)
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

// 元サイトの見た目を保つため、安全な装飾系プロパティだけ style 属性を引き継ぐ
const STYLE_ALLOW = new Set([
  "color", "background-color", "background", "font-size", "font-weight",
  "font-style", "text-decoration", "text-align", "line-height",
  "border", "border-left", "border-radius", "padding", "margin",
]);

function styleAttr(node) {
  const style = node.getAttribute?.("style") ?? "";
  if (!style) return "";
  const out = [];
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (!STYLE_ALLOW.has(prop)) continue;
    // 画像URLやスクリプト的な値は除外
    if (/url\s*\(|expression|javascript|import/i.test(val)) continue;
    if (val.length > 80) continue;
    if (prop === "font-size") {
      const m = val.match(/^(\d+(?:\.\d+)?)px$/);
      if (m && (+m[1] < 10 || +m[1] > 36)) continue;
    }
    out.push(`${prop}:${val}`);
  }
  return out.length > 0 ? ` style="${esc(out.join(";"))}"` : "";
}

// レス構造などのクラス名を残し、リーダー側CSSで元サイト風の見た目を再現できるようにする
function classAttr(node) {
  const cls = (node.getAttribute?.("class") ?? "").trim();
  if (!cls) return "";
  const safe = cls
    .split(/\s+/)
    .filter((c) => /^[\w-]+$/.test(c))
    .slice(0, 4)
    .join(" ");
  return safe ? ` class="${esc(safe)}"` : "";
}

// 「スポンサード リンク」等の広告見出しを含む小さなブロックを丸ごと除去する
const SPONSOR_RE = /(スポンサ[ーァ]?ド?\s*リンク|Sponsored\s*Links?)/i;

function sanitize(node, base, budget, depth = 0) {
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
  // ルート自身は除外しない (短い記事全体が消えるのを防ぐ)
  if (depth > 0) {
    const ownText = node.textContent ?? "";
    if (ownText.length < 600 && SPONSOR_RE.test(ownText)) return "";
  }

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
  for (const child of node.childNodes) inner += sanitize(child, base, budget, depth + 1);

  if (tag === "A") {
    const href = absUrl(node.getAttribute("href"), base);
    // 動画ファイルへの直リンクはその場で再生できるプレーヤーに変換する
    // (video.twimg.com などはリンクとして開くと403になるため)
    if (href && /\.(mp4|webm)([?#]|$)/i.test(href)) {
      if (budget.media.has(href)) return "";
      budget.media.add(href);
      budget.used += 200;
      const poster = absUrl(node.getAttribute("data-poster"), base);
      const posterAttr = poster ? ` poster="${esc(poster)}"` : "";
      return `<video controls playsinline preload="metadata"${posterAttr} src="${esc(href)}"></video>`;
    }
    // 画像ファイルへの直リンク (i.imgur.com/xxx.jpg 等) はその場で画像表示する
    if (href && /\.(jpe?g|png|gif|webp)([?#]|$)/i.test(href)) {
      if (budget.media.has(href)) return "";
      budget.media.add(href);
      budget.used += 150;
      return `<img src="${esc(href)}" loading="lazy" referrerpolicy="no-referrer">`;
    }
    return href
      ? `<a href="${esc(href)}" target="_blank" rel="noopener nofollow">${inner}</a>`
      : inner;
  }
  if (KEEP_TAGS.has(tag)) {
    const t = tag.toLowerCase();
    return `<${t}${classAttr(node)}${styleAttr(node)}>${inner}</${t}>`;
  }
  if (WRAP_AS_DIV.has(tag)) {
    return inner.trim() ? `<div${classAttr(node)}${styleAttr(node)}>${inner}</div>` : "";
  }
  if (tag === "SPAN") {
    return inner.trim() ? `<span${classAttr(node)}${styleAttr(node)}>${inner}</span>` : "";
  }
  return inner; // 未知のタグはタグだけ剥がして中身を残す
}

// ページ内から同一ブログの他記事へのリンク (関連記事・人気記事など) を
// サムネイル付きで集める。返り値: [title, url, thumb?] の配列 (最大30件)
function collectRelated(document, url) {
  let self;
  try {
    self = new URL(url);
  } catch {
    return [];
  }
  const selfHost = self.hostname.replace(/^www\./, "");
  const isArticleLink = (href) =>
    /\/archives?\/\d+|\/archives?\/[\w-]+\.html|\/article\/\d+|\/\d{4,}\.html|[?&]p=\d+/.test(
      href.pathname + href.search,
    );

  // サムネイルだけのリンクとタイトルだけのリンクが分かれていることが多いので、
  // 先に記事URL→サムネイル画像の対応を作っておく
  const thumbs = new Map();
  const anchors = [];
  for (const a of document.querySelectorAll("a[href]")) {
    let href;
    try {
      href = new URL(a.getAttribute("href"), url);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(href.protocol)) continue;
    if (href.hostname.replace(/^www\./, "") !== selfHost) continue;
    if (!isArticleLink(href)) continue;
    const key = href.origin + href.pathname;
    const img = a.querySelector("img");
    if (img && !thumbs.has(key)) {
      const thumb = absUrl(
        img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("src"),
        url,
      );
      if (thumb) thumbs.set(key, thumb);
    }
    anchors.push([a, href, key]);
  }

  const seen = new Set([self.origin + self.pathname]);
  const out = [];
  for (const [a, href, key] of anchors) {
    if (out.length >= 30) break;
    const text = (a.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length < 10 || text.length > 150) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = [text.slice(0, 120), href.origin + href.pathname + href.search];
    const thumb = thumbs.get(key);
    if (thumb) entry.push(thumb);
    out.push(entry);
  }
  return out;
}

// 埋め込みツイートの画像を取得して blockquote 内に <img> として差し込む。
// widgets.js (スクリプト) は使えないため、X の公開 syndication API を利用する。
function tweetToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

async function enrichTweets(document) {
  const quotes = [
    ...document.querySelectorAll("blockquote.twitter-tweet, blockquote.twitter-video"),
  ].slice(0, 6);
  for (const bq of quotes) {
    const match = [...bq.querySelectorAll("a[href]")]
      .map((a) => a.getAttribute("href") ?? "")
      .map((h) => h.match(/(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/(\d+)/))
      .find(Boolean);
    if (!match) continue;
    const id = match[1];
    try {
      const res = await fetch(
        `${TWEET_API}/tweet-result?id=${id}&lang=ja&token=${tweetToken(id)}`,
        { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) continue;
      const tweet = await res.json();
      const media = tweet.mediaDetails ?? tweet.photos ?? [];
      for (const m of media.slice(0, 4)) {
        const thumb = m.media_url_https ?? m.url;
        // 動画・GIFは最高画質のmp4を選び、リンクとして挿入する
        // (sanitizeのmp4リンク→<video>変換でプレーヤーになる)
        const variants = (m.video_info?.variants ?? [])
          .filter((v) => v.content_type === "video/mp4" && /^https:\/\//.test(v.url ?? ""));
        if ((m.type === "video" || m.type === "animated_gif") && variants.length > 0) {
          variants.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
          const a = document.createElement("a");
          a.setAttribute("href", variants[0].url);
          if (thumb && /^https:\/\//.test(thumb)) a.setAttribute("data-poster", thumb);
          a.textContent = "動画";
          bq.appendChild(a);
          continue;
        }
        if (!thumb || !/^https:\/\//.test(thumb)) continue;
        const img = document.createElement("img");
        img.setAttribute("src", thumb);
        bq.appendChild(img);
      }
    } catch {}
  }
}

// imgur 埋め込み (View post on imgur.com) を実画像の <img> に置き換える
async function enrichImgur(document) {
  const embeds = [...document.querySelectorAll("blockquote.imgur-embed-pub")].slice(0, 8);
  for (const bq of embeds) {
    let id = bq.getAttribute("data-id") ?? "";
    if (!id) {
      const a = bq.querySelector("a[href*='imgur.com']");
      id = a?.getAttribute("href")?.match(/imgur\.com\/([\w/]+)/)?.[1] ?? "";
    }
    if (!id) continue;
    try {
      let src = null;
      if (/^[A-Za-z0-9]+$/.test(id)) {
        // 単一画像はURLを直接組み立てられる
        src = `https://i.imgur.com/${id}.jpg`;
      } else {
        // アルバム等はページの og:image から取得
        const page = await fetchText(`https://imgur.com/${id}`, 8000);
        src =
          page.match(/property="og:image"[^>]*content="([^"]+)"/)?.[1] ??
          page.match(/content="([^"]+)"[^>]*property="og:image"/)?.[1];
        if (src) src = src.replace(/&amp;/g, "&");
      }
      if (src && /^https?:\/\//.test(src)) {
        const img = document.createElement("img");
        img.setAttribute("src", src);
        bq.appendChild(img);
      }
    } catch {}
  }
}

export async function extract(html, url) {
  const { document } = parseHTML(html);
  await enrichTweets(document);
  await enrichImgur(document);
  // 本文コンテナは複数に分かれていることがある (最初のレスと「続き」が別コンテナ等)
  // ため、マッチした要素はすべて連結する
  let roots = [];
  for (const sel of BODY_SELECTORS) {
    const els = [...document.querySelectorAll(sel)];
    const totalLen = els.reduce((n, el) => n + el.textContent.trim().length, 0);
    if (els.length > 0 && totalLen > 100) {
      roots = els;
      break;
    }
  }
  if (roots.length > 0) {
    // 「続きを読む」以降が別コンテナのブログに対応
    for (const sel of ["#more", "#article-more", ".article-body-more", ".article-more", ".entry-more", ".more_body"]) {
      for (const el of document.querySelectorAll(sel)) {
        if (!roots.some((r) => r.contains(el) || el.contains(r))) roots.push(el);
      }
    }
  }

  // 関連記事はReadabilityがDOMを壊す前に集めておく
  const related = collectRelated(document, url);

  const sanitizeRoots = (rootsArr) => {
    const budget = { used: 0, media: new Set() };
    return rootsArr
      .map((root) => sanitize(root, url, budget))
      .join("")
      .trim();
  };
  const textOf = (s) => s.replace(/<[^>]*>/g, "").trim();

  let out = roots.length > 0 ? sanitizeRoots(roots) : "";
  // セレクタで取れた本文が短すぎる場合は、Readabilityの本文推定と比較して
  // 明確に長い方を採用する (未知のテンプレートでレス群を取りこぼす対策)
  if (textOf(out).length < 600) {
    try {
      const article = new Readability(document, { charThreshold: 100 }).parse();
      if (article?.content) {
        const altRoot = parseHTML(`<div>${article.content}</div>`).document.querySelector("div");
        const altOut = sanitizeRoots([altRoot]);
        if (textOf(altOut).length > textOf(out).length * 1.3) out = altOut;
      }
    } catch {}
  }
  if (!out) return null;
  const text = textOf(out);
  // 文字化け (置換文字が多い) は抽出失敗として扱う
  const garbled = (text.match(/�/g) ?? []).length;
  if (garbled > 5) return null;
  // タグを除いた実質テキストが少なすぎる場合は抽出失敗扱い (画像・動画があればOK)
  if (text.length <= 100 && !out.includes("<img") && !out.includes("<video")) return null;
  return { html: out, related };
}

// ---- メイン ----

import { pathToFileURL } from "node:url";

async function main() {
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
      const html = await fetchTextWithFallback(url, FETCH_TIMEOUT_MS);
      const body = await extract(html, url);
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
