// リユース業界のニュースを集めて public/reuse.json を作る。
// reuse-feeds.json のキーワードごとに Google ニュースの検索 (RSS) を読み、同じ記事をまとめて新しい順に並べる。
// 業界紙 (リユース経済新聞) のサイトは自動のアクセスを受け付けないので、直接は読まず、検索に出た見出しとリンクだけを使う

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { decodeEntities } from "./feedparser.mjs";
import { fetchText } from "./fetchtext.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TIMEOUT_MS = 20_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 300;
// ほかの媒体の記事をそのまま載せているところ。同じ見出しがあれば、元の媒体のほうを出す
const AGGREGATORS = /au Webポータル|ニコニコニュース|ライブドアニュース|Yahoo!|dメニュー|goo ニュース|エキサイト|BIGLOBE|@nifty|マピオン|Infoseek|アットプレス|ドリームニュース|毎日キレイ|とれまが|STRAIGHT PRESS|iza/i;

export const searchUrl = (query) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:7d`)}&hl=ja&gl=JP&ceid=JP:ja`;

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).replace(/\s+/g, " ").trim() : "";
};

// Google ニュースの見出しは「見出し - 媒体名」。媒体名を外す
export function cleanTitle(title, source) {
  let t = title;
  if (source && t.endsWith(` - ${source}`)) t = t.slice(0, -source.length - 3);
  return t.replace(/^「(.+)」$/, "$1").trim();
}

export function parseSearch(xml) {
  const out = [];
  for (const [, block] of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const source = tag(block, "source");
    const title = cleanTitle(tag(block, "title"), source);
    const link = tag(block, "link");
    const ts = Date.parse(tag(block, "pubDate"));
    if (!title || !/^https:\/\//.test(link) || Number.isNaN(ts)) continue;
    // 媒体名に付いた説明 (「Investing.com - FX | 株式市場 …」など) は外す
    out.push({ t: title, u: link, s: source.split(/\s[|｜-]\s/)[0] || "ニュース", ts });
  }
  return out;
}

// 同じ記事かどうかを見るための見出し (記号や空白の違いを無視する)
const keyOf = (title) => title.normalize("NFKC").toLowerCase().replace(/[\s「」『』【】()\[\]、。,.!?！？・:：\-—~〜"'“”]/g, "").slice(0, 28);

// 分類ごとの記事 [{cat, items}] (優先する分類の順) をまとめる。同じ見出しは1つにして、伝えた媒体の数を n に入れる
export function merge(groups, now = Date.now()) {
  const byKey = new Map();
  for (const { cat, items } of groups) {
    for (const it of items) {
      if (now - it.ts > MAX_AGE_MS || it.ts > now + 3600_000) continue;
      const key = keyOf(it.t);
      const cur = byKey.get(key);
      if (!cur) {
        byKey.set(key, { ...it, c: cat, sources: new Set([it.s]) });
        continue;
      }
      cur.sources.add(it.s);
      // 元の媒体を優先し、同じなら早く出たほうを残す
      const better = AGGREGATORS.test(cur.s) !== AGGREGATORS.test(it.s) ? AGGREGATORS.test(cur.s) : it.ts < cur.ts;
      if (better) Object.assign(cur, { t: it.t, u: it.u, s: it.s, ts: it.ts });
    }
  }
  return [...byKey.values()]
    .map(({ sources, ...it }) => ({ ...it, n: sources.size }))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_ITEMS);
}

async function main() {
  const conf = JSON.parse(await readFile(path.join(ROOT, "reuse-feeds.json"), "utf8"));
  const groups = [];
  let ok = 0;
  let total = 0;
  for (const cat of conf.categories) {
    const items = [];
    for (const q of cat.queries) {
      total++;
      try {
        const found = parseSearch(await fetchText(searchUrl(q), TIMEOUT_MS, "application/rss+xml, application/xml, */*"));
        items.push(...found);
        ok++;
        console.log(`OK ${cat.name} [${q.slice(0, 30)}]: ${found.length}`);
      } catch (err) {
        console.error(`NG ${cat.name} [${q.slice(0, 30)}]: ${err?.message ?? err}`);
      }
    }
    const must = cat.must ? new RegExp(cat.must) : null;
    groups.push({ cat: cat.id, items: must ? items.filter((it) => must.test(it.t)) : items });
  }
  const outFile = path.join(ROOT, "public", "reuse.json");
  await mkdir(path.dirname(outFile), { recursive: true });
  let items = merge(groups);
  if (!items.length) {
    // 全部失敗したときは、前回公開した分をそのまま使う (ページが空にならないように)
    const base = process.env.PAGES_BASE;
    if (base) {
      try {
        await writeFile(outFile, await fetchText(`${base}/reuse.json`, TIMEOUT_MS));
        console.error("all queries failed; kept the previous reuse.json");
        return;
      } catch {}
    }
    console.error("all queries failed");
    process.exit(1);
  }
  const out = { updated: Date.now(), cats: conf.categories.map(({ id, name }) => ({ id, name })), items };
  await writeFile(outFile, JSON.stringify(out));
  console.log(`\n${ok}/${total} queries, ${items.length} items -> public/reuse.json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
