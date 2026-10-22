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
const MAX_NEW = 450; // 1回の実行で新規抽出する記事数の上限
const CONCURRENCY = 12;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_CHARS = 300_000; // 1記事あたりの本文サイズ上限
// 抽出フォーマットのバージョン。上げると全記事が再抽出される
// (v2: 文字コード自動判定 / v3: 関連記事リンク / v4: ツイート画像とスポンサー枠除去 /
//  v5: 関連記事を最大30件・サムネイル付きに拡大、動画リンクをプレーヤー化 /
//  v6: 画像直リンクをインライン画像に変換 / v7-9: 不思議.net系の本文セレクタ調整 /
//  v10: ツイート動画をプレーヤーとして埋め込み / v11: 元サイトの装飾・クラスを保持 /
//  v12: 痛いニュース対応 + 短すぎる抽出結果のReadabilityフォールバック /
//  v13: やらおん#extended対応でツイート埋め込みを保持 /
//  v14: アルファルファの.article_bodymore対応 + 画像・動画を本文量として加点 /
//  v15: 全サイト点検に基づく見直し。レスの集まりから本文を探す、記事タイトル・投稿日・コメント欄・
//       宣伝リンクの除去、レスの見出しの統一 (class="ph")、<font> を文中のまま表示、YouTube 埋め込み、遅延読み込み画像)
const ART_VERSION = 15;
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
  "#extended", // やらおん等のWordPress「続き」コンテナ (スレ本文)
  ".entry-content",
  ".ently_text",
  ".entry_body",
  ".post-content",
  ".post_content",
  "#article_body",
  ".article_body",
  ".main-article-body",
  ".main_content_bgColor > .article_box_upper", // 不思議.net 等 (本文前半、続きは .more_body)
  ".articleBody", // VIPPER速報
  ".article-main", // はちま起稿・オタコム
  ".mainEntryBody", // FC2 の標準テンプレート (続きは .mainEntryMore)
  ".entrybody", // ラビット速報
];
// 「続きを読む」以降が別の入れ物になっているブログの、続きの入れ物
const MORE_SELECTORS = [
  "#more", "#article-more", ".article-body-more", ".article-more", ".entry-more",
  ".more_body", ".article_bodymore", ".mainEntryMore",
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
const WRAP_AS_DIV = new Set(["DIV", "SECTION", "ARTICLE", "MAIN", "CENTER"]);
// 広告・SNS・関連記事などのコンテナを class/id 名で除外
const AD_RE =
  /(^|[\s_-])(ad|ads|advert|adsense|admax|sponsor|banner|outbrain|taboola|popin|zucks|nend|imobile|uzou|logly|share|sns|social|relat|related|recommend|rank|ranking|comment|breadcrumb|pager|paging|widget|blogroll|rss|newsletter|cta)([\s_-]|$)/i;
// 本文の入れ物の中にある、本文以外の小さなまとまり (アマゾン等の商品紹介・おすすめ記事・タグ・投稿日や
// カテゴリの行・記事タイトル・前後の記事への案内など) の class/id 名。各ブログの点検結果から集めたもの
const JUNK_RE =
  /(^|[\s_-])(amazon|amaquick|amz|rakuten|moshimo|affiliate|kanren|follow|tags?|category|categories|posted\w*|navigate|navigation|navi|menu|pickup|popular|ninki|osusume|engagement|portallinks|commentlink|commenthead|titlebody|article_title_box\w*|entry-title|post-title|come_cat|article-headline|article-news\w*|kotei_link|rss\w*|sns_bt|kjs|mixture|kiziad|all_article|x-embed-loading-note|article-option|yahoo-ad\w*|lq_st\w*|(?:entry|post|article)-meta)([\s_-]|$)/i;
// <font size="1〜7"> の大きさ (本文 1em を基準に、大きすぎないように抑える)
const FONT_SIZES = {
  1: ".75em", 2: ".85em", 3: "1em", 4: "1.15em", 5: "1.35em", 6: "1.6em", 7: "1.9em",
  "+1": "1.15em", "+2": "1.35em", "+3": "1.6em", "+4": "1.9em", "-1": ".85em", "-2": ".75em",
};

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

function styleAttr(node, extra = []) {
  const out = [...extra, ...styleList(node)];
  return out.length > 0 ? ` style="${esc(out.join(";"))}"` : "";
}

function styleList(node) {
  const style = node.getAttribute?.("style") ?? "";
  const out = [];
  if (!style) return out;
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
  return out;
}

// 画像のURL。遅延読み込みの画像は本物のURLが data-* や srcset に入っていて、src は仮の画像のことがある
function imgSrc(node, base) {
  const lastOf = (srcset) => srcset?.split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean).pop();
  for (const cand of [
    node.getAttribute("data-src"),
    node.getAttribute("data-original"),
    node.getAttribute("data-lazy-src"),
    node.getAttribute("data-lazy"),
    node.getAttribute("data-echo"),
    lastOf(node.getAttribute("data-srcset")),
    lastOf(node.getAttribute("srcset")),
    node.getAttribute("src"),
  ]) {
    const src = absUrl(cand?.trim(), base);
    if (src) return src;
  }
  return null;
}

// 動画の埋め込み (iframe) は再生できないので、YouTube はサムネイル付きのリンク、ニコニコ動画はリンクにする
function embedLink(node, base, budget) {
  const src = absUrl(node.getAttribute("src") || node.getAttribute("data-src") || node.getAttribute("data-lazy-src"), base) ?? "";
  const yt = src.match(/(?:youtube(?:-nocookie)?\.com\/embed\/|youtu\.be\/)([\w-]{11})/)?.[1];
  const nico = src.match(/nicovideo\.jp\/watch\/((?:sm|so|nm)\d+)/)?.[1];
  const href = yt ? `https://www.youtube.com/watch?v=${yt}` : nico ? `https://www.nicovideo.jp/watch/${nico}` : null;
  if (!href || budget.media.has(href)) return "";
  budget.media.add(href);
  budget.used += 250;
  const thumb = yt ? `<img src="https://i.ytimg.com/vi/${yt}/hqdefault.jpg" loading="lazy" referrerpolicy="no-referrer">` : "";
  return `<a class="embed-video" href="${esc(href)}" target="_blank" rel="noopener nofollow">${thumb}<span>${yt ? "YouTube" : "ニコニコ動画"}で見る</span></a>`;
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
  if (tag === "IFRAME" || tag === "LITE-YOUTUBE") {
    const id = node.getAttribute("videoid");
    if (id) node.setAttribute("src", `https://www.youtube.com/embed/${id}`);
    return embedLink(node, base, budget);
  }
  if (BLOCK_TAGS.has(tag)) return "";
  // ルート自身は除外しない (短い記事全体が消えるのを防ぐ)
  if (depth > 0) {
    const marker = `${node.getAttribute?.("class") ?? ""} ${node.getAttribute?.("id") ?? ""}`;
    if (AD_RE.test(marker)) return "";
    const ownText = node.textContent ?? "";
    if (ownText.length < 600 && SPONSOR_RE.test(ownText)) return "";
    // 宣伝・案内の入れ物は小さいものだけ (記事全体を包む入れ物に同じ名前が付いていることがあるため)
    if (JUNK_RE.test(marker) && ownText.length < Math.max(1500, budget.rootLen * 0.3)) return "";
  }

  if (tag === "IMG") {
    const src = imgSrc(node, base);
    // 1ピクセルの計測用画像は出さない
    if (!src || /^[01]$/.test(node.getAttribute("width") ?? "") || /^[01]$/.test(node.getAttribute("height") ?? "")) return "";
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
    const center = tag === "CENTER" ? ["text-align:center"] : [];
    return inner.trim() ? `<div${classAttr(node)}${styleAttr(node, center)}>${inner}</div>` : "";
  }
  // <font color="red" size="5"> はレスの文中で使われるので、改行しない span にして色と大きさを引き継ぐ
  if (tag === "FONT") {
    if (!inner.trim()) return inner;
    const css = [];
    const color = (node.getAttribute("color") ?? "").trim();
    if (/^#?[0-9a-z]{3,20}$/i.test(color)) css.push(`color:${color}`);
    const size = FONT_SIZES[(node.getAttribute("size") ?? "").trim()];
    if (size) css.push(`font-size:${size}`);
    return `<span${classAttr(node)}${styleAttr(node, css)}>${inner}</span>`;
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
    // 画像ファイルへの直リンクを既に含む埋め込みは、リンク→<img>変換に任せる (二重表示防止)
    const direct = bq.querySelector("a[href*='i.imgur.com']");
    if (direct && /\.(jpe?g|png|gif|webp)([?#]|$)/i.test(direct.getAttribute("href") ?? "")) continue;
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

// ---- スレの本文の見つけ方と、本文以外の除去 ----

// レスの見出し (番号・名前・日付・ID) に付く日付。例: 26/10/22(木)、2026/10/22(木)
const POST_DATE_RE = /\d{2,4}\/\d{1,2}\/\d{1,2}\s*[(（][月火水木金土日][)）]/;
const countPosts = (text) => (text.match(new RegExp(POST_DATE_RE.source, "g")) ?? []).length;
// レスの見出しの書き出し (「1:」「1 名前：」「◇ 1:」など) と、見出しらしさ (日付か ID がある)
const HEAD_START_RE = /^\s*[◇◆■□●○]?\s*\d{1,4}\s*(?:名前)?\s*[:：]/;
const looksLikeHead = (text) =>
  HEAD_START_RE.test(text) && (/\d{2,4}\/\d{1,2}\/\d{1,2}/.test(text) || /ID\s*[:：]/.test(text));
const isCommentBox = (el) => /comment/i.test(`${el.getAttribute?.("class") ?? ""} ${el.getAttribute?.("id") ?? ""}`);

// アフィリエイト (アマゾン・楽天など) とブログランキングのリンク。まとまりごと宣伝として除く
const AFFILIATE_RE =
  /(amazon\.(co\.jp|jp|com)\/|amzn\.(to|asia)|rakuten\.co\.jp|r10\.to|moshimo\.com|a8\.net|valuecommerce|accesstrade|linksynergy|dmm\.co\.jp|dlsite\.com|blogmura\.com|with2\.net|blogranking\.net|ranking\.fc2|mcgm\.sakura\.ne\.jp|amazon-adsystem)/i;
// まとめブログの記事・アンテナサイトへのリンク (おすすめ記事の並びの見分けに使う)
const BLOG_LINK_RE = /\/archives\/|blog-entry-\d+|\/acv\/\d+|[?&]url=http|antenna/i;
// それだけで1行になっている案内・宣伝の見出しや、共有ボタンの文字
const LABEL_RE =
  /^[\s【［\[〔(（★☆※▽▼▲△■□◆◇●○♪〓▶▷→↓]*(スポンサー?ド?\s*リンク|スポンサー|PR|広告|おすすめ記事|オススメ記事|おすすめ|関連記事|関連リンク|人気記事|注目記事|新着記事|最新記事|今一番注目されている記事.*|やんごとなき人気記事|ピックアップニュース|ピックアップ|他ブログ様新着記事|他サイト様新着記事|みんなが見てる|コメントする|コメントを書く|コメントを投稿する|コメントを見る.*|コメント一覧.*|.{0,12}の?全記事一覧|気になるAmazonの本|直近のコメント数ランキング|記事ランキング.*|人気ページランキング|月間ランキング|この記事が気に入ったら.*|Tweet|ツイート|シェア|はてブ|LINEで送る|Pocket|フォローする)[\s】］\]〕)）!！]*$/i;
// 書き出しがおすすめ記事などの案内で、リンクが多いまとまり
const PROMO_START_RE =
  /^[\s【［\[〔(（★☆※▽▼▲△■□◆◇●○♪〓▶▷→↓]*(おすすめ|オススメ|今週のおすすめ|関連記事|関連スレ|あわせて読みたい|合わせて読みたい|人気記事|注目記事|ピックアップ|PICK\s*UP|他ブログ|新着記事|最新記事|タイムセール|お気に入りブログ)/i;
// 広告の利用の表示・コメント欄の注意書き・トラックバックなど
const DISCLAIMER_RE =
  /(アフィリエイト|広告)を(利用|使用|掲載)しています|投稿されたコメントの内容|誹謗中傷な?投稿|訴訟リスク|コメントは非公開|IP由来の巻き込み規制|トラックバックURL|この記事にトラックバック|応援クリック|ランキングに参加/;
// カテゴリ・タグの一覧ページへのリンク
const CATEGORY_LINK_RE = /\/(category|categories|tag|tags)\/|\/cat_\d+|archives\/cat_/i;
// 中身が空になったら消してよい要素 (空の箇条書きの「・」などが残らないように)
const EMPTY_OK_TAGS = new Set(["LI", "UL", "OL", "DL", "DT", "DD", "P", "SPAN", "B", "STRONG", "A", "DIV", "H1", "H2", "H3", "H4", "H5", "H6"]);
// ここから後ろはコメント欄 (後ろにレスがなければ、まとめて除く)
const COMMENT_START_RE = /^(コメントする|コメントを書く|コメントを投稿する|この記事へのコメント|コメント一覧.*|コメントを見る.*|コメント\s*[(（]\d+[)）])$/;
// 記事の投稿日 (レスの日付とは書き方が違う)
const META_DATE_RE = /20\d\d\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|20\d\d[./-]\d{1,2}[./-]\d{1,2}(?!\s*[(（])/;

const flatText = (s) => (s ?? "").replace(/\s+/g, "");

// スレのまとめなら、レスの見出しの日付がいちばん集まっている入れ物を返す (コメント欄は数えない)
function threadRoot(document) {
  let node = document.body;
  if (!node) return null;
  for (let depth = 0; ; depth++) {
    const kids = [...node.children].map((el) => [
      el,
      BLOCK_TAGS.has(el.tagName) || isCommentBox(el) ? 0 : countPosts(el.textContent),
    ]);
    const total = kids.reduce((n, [, k]) => n + k, 0);
    if (total < 5) return depth === 0 ? null : node;
    const [best, n] = kids.reduce((a, b) => (b[1] > a[1] ? b : a));
    // ほぼ全部 (97% 以上) のレスを含む子があれば、その中へ進む (前半と「続き」が分かれていれば、両方を含む所で止まる)
    if (n < total * 0.97) return node;
    node = best;
  }
}

// 本文の入れ物を選ぶ。分かれていることがある (最初のレスと「続き」が別の入れ物など) ので、見つかったものはすべて使う
function pickRoots(document) {
  let roots = [];
  let via = "";
  const lengthOf = (els) => els.reduce((n, el) => n + el.textContent.trim().length, 0);
  // 「続き」の入れ物のうち、まだ含まれていないもの
  const moreOf = (els) =>
    MORE_SELECTORS.flatMap((sel) => [...document.querySelectorAll(sel)]).filter(
      (el, i, list) => list.indexOf(el) === i && !els.some((r) => r.contains(el) || el.contains(r)),
    );
  for (const sel of BODY_SELECTORS) {
    // body に本文用の id が付いているブログがある (ページ全体を本文にしない)
    const els = [...document.querySelectorAll(sel)].filter((el) => el.tagName !== "BODY" && el.tagName !== "HTML");
    if (els.length === 0) continue;
    // 文字数が少なくても画像・埋め込みがあれば本文とみなす (画像だけのレス対策)。前半が短くても続きがあればよい
    const hasMedia = els.some((el) => el.querySelector("img, blockquote, video"));
    const more = moreOf(els);
    if (lengthOf(els) > 100 || hasMedia || lengthOf(more) > 300) {
      roots = [...els, ...more];
      via = sel;
      break;
    }
  }
  // スレのまとめで、見つけた入れ物にレスの大半が入っていなければ (知らないテンプレート・別の所に一致)、
  // レスがまとまっている入れ物を使う
  const thread = threadRoot(document);
  if (thread) {
    const inRoots = roots.reduce((n, r) => n + countPosts(r.textContent), 0);
    if (inRoots < countPosts(thread.textContent) * 0.7) {
      roots = [thread];
      via = "thread";
    }
  }
  return { roots, via };
}

// 本文以外の小さなまとまりか (記事タイトルの繰り返し・投稿日やカテゴリの行・案内の見出し・宣伝の並びなど)
function isJunkBlock(el, text, ctx) {
  const flat = flatText(text);
  const tag = el.tagName;
  const marker = `${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`;
  const href = tag === "A" ? el.getAttribute("href") ?? "" : "";
  // コメント数へのリンク・カテゴリやタグの一覧へのリンク
  if (href && (/#comment/i.test(href) || CATEGORY_LINK_RE.test(href))) return true;
  if (LABEL_RE.test(text) || (text.length <= 300 && DISCLAIMER_RE.test(text))) return true;
  // 記事タイトルの繰り返し (本文の前の見出し・タイトル枠)
  const t = ctx.title;
  if (t && flat.length <= t.length + 16 && flat.includes(t.slice(0, 20))) {
    if (/^H[1-4]$/.test(tag) || /title/i.test(marker) || ctx.beforePosts(el)) return true;
  }
  const links = [...el.querySelectorAll("a[href]")];
  // 投稿日・カテゴリ・コメント数の行
  if (text.length <= 120 && !looksLikeHead(text)) {
    if (/コメント\s*[(（]?\s*\d+\s*[)）]?|\d+\s*コメント|Comments?\s*\(\d+\)/i.test(text)) return true;
    // 「マスコミ│アメリカ│17:39」のような区切りの行 (区切り文字だけのアスキーアートと区別するためリンクがあるものだけ)
    if ((text.match(/[│｜]/g) ?? []).length >= 2 && text.length <= 80 && links.length > 0) return true;
    if (META_DATE_RE.test(text) && ((text.length <= 40 && ctx.beforePosts(el)) || /カテゴリ|タグ|記事URL|Edit|posted|投稿者/i.test(text))) return true;
  }
  if (links.length === 0) return false;
  const linkText = flatText(links.map((a) => a.textContent).join(""));
  const ratio = linkText.length / Math.max(1, flat.length);
  // 他の記事・宣伝へのリンク (レスの「>>12」などの安価や、外部サイトへのリンクは数えない)
  const promo = links.filter((a) => {
    const label = flatText(a.textContent);
    if (label.startsWith(">>") || label.startsWith("＞＞")) return false;
    const h = a.getAttribute("href") ?? "";
    return BLOG_LINK_RE.test(h) || ctx.sameSite(h) || AFFILIATE_RE.test(h);
  });
  // おすすめ記事などの案内で始まり、リンクの多いまとまり
  if (PROMO_START_RE.test(text) && ratio >= 0.4 && promo.length > 0) return true;
  // 他の記事へのリンクがずらりと並んだまとまり
  const titled = promo.filter((a) => flatText(a.textContent).length >= 8);
  return titled.length >= 3 && ratio >= 0.6;
}

// 本文の入れ物から、本文以外 (宣伝・記事タイトル・投稿日やカテゴリの行・コメント欄) を取り除く
function tidy(root, ctx) {
  // 1) アフィリエイト・ブログランキングのリンクを、レスを含まない小さなまとまりごと除く
  for (const a of [...root.querySelectorAll("a[href]")]) {
    if (!root.contains(a) || !AFFILIATE_RE.test(a.getAttribute("href") ?? "")) continue;
    let box = a;
    while (box.parentElement && box.parentElement !== root) {
      const text = box.parentElement.textContent;
      if (text.length > 300 || countPosts(text) > 0) break;
      box = box.parentElement;
    }
    box.remove();
  }

  // 2) コメント欄: 「コメントする」などから後ろにレスがなければ、そこから後ろを全部除く
  const all = [...root.querySelectorAll("*")];
  const start = all.findIndex((el) => {
    const t = el.textContent.replace(/\s+/g, " ").trim();
    return t.length <= 40 && COMMENT_START_RE.test(t);
  });
  // (記事の前のほうにある「コメント(0)」などで本文が消えないよう、前に本文がある程度あるときだけ)
  const textBefore = start >= 0 ? all.slice(0, start).reduce((n, el) => n + ownText(el).trim().length, 0) : 0;
  if (start >= 0 && textBefore >= 300 && !all.slice(start + 1).some((el) => POST_DATE_RE.test(ownText(el)))) {
    let node = all[start];
    while (node && node !== root) {
      while (node.nextSibling) node.nextSibling.remove();
      const parent = node.parentNode;
      if (node === all[start]) node.remove();
      node = parent;
    }
  }

  // 3) 本文以外の小さなまとまり (内側から順に調べる)
  const rest = [...root.querySelectorAll("*")];
  const firstPost = rest.findIndex((el) => el.textContent.length < 400 && POST_DATE_RE.test(el.textContent));
  const order = new Map(rest.map((el, i) => [el, i]));
  ctx.beforePosts = (el) => firstPost < 0 ? order.get(el) < 8 : order.get(el) < firstPost;
  for (const el of rest.reverse()) {
    if (!root.contains(el)) continue;
    const text = el.textContent.replace(/\s+/g, " ").trim();
    if (!text) {
      // 画像や動画のない空の箇条書き・段落などは除く (空の「・」が残らないように)。画像だけのレスは残す
      const media = el.querySelector("img, video, iframe, lite-youtube, blockquote") || /^(IMG|VIDEO|IFRAME|HR|BR)$/.test(el.tagName);
      const isLink = el.tagName === "A" && /#comment/i.test(el.getAttribute("href") ?? "");
      if (isLink || (!media && EMPTY_OK_TAGS.has(el.tagName) && !el.querySelector("br"))) el.remove();
      continue;
    }
    if (text.length > 400 || countPosts(text) > 0) continue; // レスを含むものは触らない
    if (isJunkBlock(el, text, ctx)) el.remove();
  }
  // 入れ物に直接書かれた案内の文字 (「スポンサードリンク」など)
  for (const el of [root, ...root.querySelectorAll("*")]) {
    for (const node of [...el.childNodes]) {
      if (node.nodeType === 3 && LABEL_RE.test(node.textContent.trim()) && node.textContent.trim()) node.remove();
    }
  }
}

// 要素の直下にある文字だけ (子要素の文字は含めない)
const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("");

// 改行の区切りになる要素 (レスの見出しの文字の並びはここで終わる)
const BREAK_TAGS = new Set([
  "BR", "DIV", "P", "BLOCKQUOTE", "UL", "OL", "DL", "DT", "DD", "LI", "TABLE", "PRE", "HR",
  "H1", "H2", "H3", "H4", "H5", "H6", "FIGURE", "SECTION", "ARTICLE", "CENTER",
]);

// レスの見出しに class="ph" を付ける (ブログごとに書き方の違う見出しを、リーダーで同じ見た目にする)
function markPostHeads(root, document) {
  const mark = (el) => el.setAttribute("class", `ph ${el.getAttribute("class") ?? ""}`.trim());
  // 見出しだけの小さな要素 (いちばん内側のもの)
  const cands = [...root.querySelectorAll("div, p, dt, span, b, strong, u, li, td, font, h3, h4, h5, h6")].filter((el) => {
    const t = el.textContent.replace(/\s+/g, " ").trim();
    return t.length <= 160 && looksLikeHead(t);
  });
  const set = new Set(cands);
  for (const el of cands) {
    if (![...el.querySelectorAll("*")].some((d) => set.has(d))) mark(el);
  }
  // 入れ物に直接書かれた見出し (「1 名前：<b>名無し</b>[] 投稿日：… ID:…」の後に改行) は span で囲む
  for (const box of [root, ...root.querySelectorAll("*")]) {
    if (box.closest?.(".ph")) continue;
    let node = box.firstChild;
    while (node) {
      if (node.nodeType === 3 && HEAD_START_RE.test(node.textContent)) {
        const run = [node];
        let sib = node.nextSibling;
        while (sib && !(sib.nodeType === 1 && BREAK_TAGS.has(sib.tagName))) {
          run.push(sib);
          sib = sib.nextSibling;
        }
        const text = run.map((n) => n.textContent).join("").replace(/\s+/g, " ").trim();
        if (text.length <= 200 && looksLikeHead(text)) {
          const span = document.createElement("span");
          span.setAttribute("class", "ph");
          box.insertBefore(span, node);
          for (const n of run) span.appendChild(n);
          node = sib;
          continue;
        }
      }
      node = node.nextSibling;
    }
  }
}

export async function extract(html, url, title = "") {
  const { document } = parseHTML(html);
  await enrichTweets(document);
  await enrichImgur(document);
  // 関連記事は、本文の整理やReadabilityでリンクが消える前に集めておく
  const related = collectRelated(document, url);
  let { roots, via } = pickRoots(document);

  let selfHost = "";
  try {
    selfHost = new URL(url).hostname.replace(/^www\./, "");
  } catch {}
  const ctx = {
    title: flatText(title),
    sameSite: (href) => {
      try {
        const u = new URL(href, url);
        return u.hostname.replace(/^www\./, "") === selfHost && u.pathname !== new URL(url).pathname;
      } catch {
        return false;
      }
    },
  };

  const sanitizeRoots = (rootsArr) => {
    for (const root of rootsArr) {
      tidy(root, ctx);
      markPostHeads(root, root.ownerDocument);
    }
    const rootLen = rootsArr.reduce((n, r) => n + r.textContent.length, 0);
    const budget = { used: 0, media: new Set(), rootLen };
    return rootsArr
      .map((root) => sanitize(root, url, budget))
      .join("")
      .trim();
  };
  const textOf = (s) => s.replace(/<[^>]*>/g, "").trim();
  // 本文量の評価は文字数 + 画像/動画も加点する
  // (画像中心の記事が「短すぎる」と誤判定されて推定エンジンのゴミに負けるのを防ぐ)
  const scoreOf = (s) =>
    textOf(s).length +
    150 * ((s.match(/<img/g) ?? []).length + (s.match(/<video/g) ?? []).length);

  // レスが5つ以上ある入れ物を選べていれば、短いスレでもそのまま使う (Readability はコメント欄を混ぜやすい)
  const threadPosts = roots.reduce((n, r) => n + countPosts(r.textContent), 0);
  let out = roots.length > 0 ? sanitizeRoots(roots) : "";
  // セレクタで取れた本文が乏しい場合は、Readabilityの本文推定と比較して
  // 明確に充実している方を採用する (未知のテンプレートでレス群を取りこぼす対策)
  if (scoreOf(out) < 600 && threadPosts < 5) {
    try {
      // keepClasses: レスの見出し・本文の class (t_h / t_b など) を残して、リーダーで見た目を整えられるようにする
      const article = new Readability(document, { charThreshold: 100, keepClasses: true }).parse();
      if (article?.content) {
        const altRoot = parseHTML(`<div>${article.content}</div>`).document.querySelector("div");
        const altOut = sanitizeRoots([altRoot]);
        if (scoreOf(altOut) > scoreOf(out) * 1.3) {
          out = altOut;
          via = "readability";
        }
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
  return { html: out, related, via };
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
      const body = await extract(html, url, title);
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
