// まとめ記事の本文抽出を全サイトまとめて点検する (debugワークフローから実行するメンテ用)。
// 各サイトの最新記事を実際に取得して extract() にかけ、どこを本文として使ったか・先頭と末尾に
// 本文以外 (タイトル・日付・カテゴリ・共有ボタン・コメント数など) が混ざっていないかをログに出す。
// usage: node scripts/debug-extract.mjs "audit <最初のサイト番号>-<最後のサイト番号> [1サイトあたりの記事数]"

import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";
import { parseFeed } from "./feedparser.mjs";
import { fetchTextWithFallback } from "./fetchtext.mjs";
import { extract } from "./build-articles.mjs";

const clip = (s, n) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const label = (el) => {
  const cls = (el.getAttribute?.("class") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".");
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls ? `.${cls}` : ""}`;
};

// 抽出したHTMLの並び (1つだけの入れ物は中へ降りる)。本文の前後に何が混ざったかを見る
function outline(html) {
  const { document } = parseHTML(`<div id="root">${html}</div>`);
  let box = document.getElementById("root");
  while (box.children.length === 1 && box.firstElementChild.textContent.trim().length > box.textContent.trim().length * 0.9) {
    box = box.firstElementChild;
  }
  const rows = [];
  for (const node of box.childNodes) {
    if (node.nodeType === 3) {
      const t = clip(node.textContent, 50);
      if (t) rows.push(`"${t}"`);
    } else if (node.nodeType === 1) {
      const media = node.tagName === "IMG" ? "[img]" : node.tagName === "VIDEO" ? "[video]" : "";
      const imgs = node.querySelectorAll?.("img").length ?? 0;
      rows.push(`<${label(node)}>${media} "${clip(node.textContent, 50)}"${imgs ? ` +${imgs}img` : ""}`);
    }
  }
  return { rows, total: rows.length };
}

// 本文以外が混ざっている疑いのある文字列
const FLAGS = [
  ["date", /20\d\d\s*[年/.-]\s*\d{1,2}\s*[月/.-]\s*\d{1,2}/],
  ["share", /ツイート|シェア|はてブ|はてなブックマーク|Pocket|LINEで送る|Tweet|Facebook|このエントリー/],
  ["comment", /コメント\s*[(（]?\s*\d+|コメント数|コメントする|コメントを書く|コメント一覧|\d+\s*コメント/],
  ["category", /カテゴリ|タグ\s*[:：]|Category|Tags?\s*:/i],
  ["more", /続きを読む|続きを見る|全文を表示|続きはこちら/],
  ["promo", /スポンサー|おすすめ記事|オススメ記事|人気記事|関連記事|ランキング|アンテナ|新着記事|あわせて読みたい|合わせて読みたい|PICK UP|ピックアップ/i],
];

function flagsOf(text, title) {
  const out = [];
  const t = title.replace(/\s+/g, "").slice(0, 14);
  const flat = text.replace(/\s+/g, "");
  const pos = t ? flat.indexOf(t) : -1;
  if (pos >= 0 && pos < 400) out.push(`title@${pos}`);
  const head = flat.slice(0, 400);
  const tail = flat.slice(-400);
  for (const [name, re] of FLAGS) {
    if (re.test(head)) out.push(`${name}:head`);
    if (re.test(tail)) out.push(`${name}:tail`);
  }
  return out;
}

// 抽出結果で使われている class の多い順 (レスの見た目の手がかり)
function classStats(html) {
  const counts = new Map();
  for (const [, cls] of html.matchAll(/class="([^"]+)"/g)) {
    for (const c of cls.split(/\s+/)) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, n]) => `${c}×${n}`).join(" ");
}

// 本文の入れ物の手前にある要素 (見出し・日付など) の並び
function context(html, via) {
  if (!via || via === "readability") return "";
  const { document } = parseHTML(html);
  const root = document.querySelector(via);
  if (!root) return "";
  const chain = [];
  for (let el = root; el && chain.length < 4; el = el.parentElement) chain.push(label(el));
  const inside = [...root.children].slice(0, 6).map((c) => `${label(c)}"${clip(c.textContent, 24)}"`);
  return `root: ${chain.join(" < ")}\n    first children: ${inside.join(" | ")}`;
}

// スレのレスの見出しに付く日付 (26/10/22(木) など) の数
const POST_DATE_RE = /\d{2,4}\/\d{1,2}\/\d{1,2}\s*[(（][月火水木金土日][)）]/g;
const postDates = (s) => (s.match(POST_DATE_RE) ?? []).length;

// ページの中で文字の多いまとまり (本文の入れ物の候補) と、そこに含まれるレスの数
function candidates(html) {
  const { document } = parseHTML(html);
  const rows = [];
  for (const el of document.querySelectorAll("div, article, section, main, td, dl, ul")) {
    const len = el.textContent.trim().length;
    if (len < 400) continue;
    if ([...el.children].some((c) => c.textContent.trim().length > len * 0.85)) continue;
    rows.push([len, `${label(el)} text=${len} posts=${postDates(el.textContent)} "${clip(el.textContent, 40)}"`]);
  }
  return rows.sort((a, b) => b[0] - a[0]).slice(0, 8).map(([, r]) => r);
}

export async function auditArticle(site, item, showHtml = false) {
  const lines = [`--- [${site.name}] ${clip(item.title, 60)}`, `    ${item.link}`];
  let html;
  try {
    html = await fetchTextWithFallback(item.link, 20_000);
  } catch (err) {
    lines.push(`    FETCH NG: ${err.message}`);
    return lines;
  }
  if (showHtml) {
    lines.push(`    page posts=${postDates(parseHTML(html).document.body?.textContent ?? "")}`);
    for (const c of candidates(html)) lines.push(`    cand: ${c}`);
  }
  const res = await extract(html, item.link, item.title).catch((err) => ({ error: err.message }));
  if (!res || res.error) {
    lines.push(`    EXTRACT NG: ${res?.error ?? "no content"}`);
    return lines;
  }
  const text = res.html.replace(/<[^>]*>/g, "").replace(/&[a-z]+;/g, " ");
  const imgs = (res.html.match(/<img/g) ?? []).length;
  const vids = (res.html.match(/<video/g) ?? []).length;
  const links = [...res.html.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1].replace(/<[^>]*>/g, "")).join("").length;
  lines.push(`    via=${res.via} text=${text.trim().length} img=${imgs} video=${vids} linkText=${links} related=${res.related.length}`);
  lines.push(`    flags: ${flagsOf(text, item.title).join(" ") || "-"}`);
  const ctx = context(html, res.via);
  if (ctx) lines.push(`    ${ctx}`);
  const { rows, total } = outline(res.html);
  const show = total <= 16 ? rows : [...rows.slice(0, 10), `… (${total - 16} more)`, ...rows.slice(-6)];
  for (const r of show) lines.push(`      ${r}`);
  lines.push(`    classes: ${classStats(res.html) || "-"}`);
  if (showHtml) {
    const flat = res.html.replace(/\s+/g, " ");
    lines.push(`    html head: ${flat.slice(0, 1500)}`);
    if (flat.length > 1500) lines.push(`    html tail: ${flat.slice(-700)}`);
  }
  return lines;
}

// spec: "<範囲 0-9 か番号の並び 2,4,6> [1サイトあたりの記事数] [html]"
export async function audit(spec = "") {
  const feeds = JSON.parse(await readFile(new URL("../feeds.json", import.meta.url), "utf8"));
  const [range = `0-${feeds.length - 1}`, per = "2", mode = ""] = spec.trim().split(/\s+/);
  const perSite = Number(per) || 2;
  const showHtml = mode === "html";
  const pick = range.includes(",")
    ? new Set(range.split(",").map(Number))
    : (() => {
        const [from, to = from] = range.split("-").map(Number);
        return new Set(feeds.map((_, i) => i).filter((i) => i >= from && i <= to));
      })();
  const targets = feeds.map((f, i) => [i, f]).filter(([i]) => pick.has(i));
  const reports = new Map();
  let next = 0;
  // 6サイトずつ並行して調べ、結果はサイトの順に出す
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (next < targets.length) {
        const [i, feed] = targets[next++];
        const lines = [`\n######## ${i}: ${feed.name} (${feed.url})`];
        try {
          const xml = await fetchTextWithFallback(feed.url, 20_000, "application/rss+xml, application/xml, text/xml, */*");
          for (const item of parseFeed(xml).slice(0, perSite)) lines.push(...(await auditArticle(feed, item, showHtml)));
        } catch (err) {
          lines.push(`  FEED NG: ${err.message}`);
        }
        reports.set(i, lines);
      }
    }),
  );
  for (const [i] of targets) console.log(reports.get(i).join("\n"));
}
