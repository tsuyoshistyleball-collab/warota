// world-feeds.json のニュースフィードを取得して、地域別の話題ニュース public/world.json を作る。
// GitHub Actions 上で定期実行される想定 (依存パッケージなし / Node 20+)。
//   node scripts/fetch-world.mjs            … 通常実行 (world.json を書き出す)
//   node scripts/fetch-world.mjs --dry-run  … 書き出さずに地域ごとの結果を表示 (メンテ用)
//   node scripts/fetch-world.mjs --probe    … フィードごとの取得状況だけを表示 (メンテ用)
//
// 1. 各フィードを取得し、前回までの記事 (最大4日分) と合わせる
// 2. 見出しの国名・地名から地域を判定する (world-regions.mjs)
// 3. 同じ出来事を伝える記事をまとめ、話題度を計算する (world-trend.mjs)
// 4. 地域ごとに話題度の高い順に10件を選び、要約 (配信元の概要文) と画像を付ける
// 失敗してもデプロイ全体を止めないよう、例外は握りつぶして空の結果を書き出す。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { parseFeed, decodeEntities } from "./feedparser.mjs";
import { fetchText, fetchTextWithFallback } from "./fetchtext.mjs";
import { REGIONS, classify, regionScores } from "./world-regions.mjs";
import { clusterItems, trendScore, byCentrality } from "./world-trend.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, "public");
const PAGES_BASE = process.env.PAGES_BASE; // 前回の world-cache.json を取りに行く公開URL
const FEED_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 10_000;
const KEEP_MS = 7 * 24 * 3600_000; // 記事を覚えておく期間 (報道の少ない地域を埋めるため1週間)
const TOP_N = 10;
const MIN_REGION_WEIGHT = 0.3;
const SECOND_REGION_WEIGHT = 0.5;
const MAX_PAGE_FETCHES = 60; // 1回の実行で記事ページを読みに行く上限
const PAGE_RETRY_MS = 12 * 3600_000; // 画像などが取れなかったページを再訪するまでの間隔
// 要約に使う配信元の優先順 (概要文が丁寧な順)
const OUTLET_PRIORITY = ["NHK", "BBC", "AFP", "共同通信", "時事通信", "TBS"];
// 同じ媒体の表記ゆれ (Googleニュースなどでの呼び名) をそろえる
const OUTLET_ALIASES = {
  "NHKニュース": "NHK", "NHK NEWS WEB": "NHK", "テレ朝NEWS": "テレビ朝日", "TBS NEWS DIG": "TBS",
  "日テレNEWS": "日テレ", "日テレNEWS NNN": "日テレ", "産経ニュース": "産経新聞", "CNN.jp": "CNN",
  "CNN.co.jp": "CNN", "Reuters": "ロイター", "ロイター通信": "ロイター", "FNNプライムオンライン": "FNN",
  "読売新聞オンライン": "読売新聞", "時事ドットコム": "時事通信", "日経": "日本経済新聞",
  "毎日新聞デジタル": "毎日新聞", "AFPBB News": "AFP", "BBCニュース": "BBC",
};
// 報道機関として扱う媒体。これ以外 (雑誌・個人系) だけが伝える話題は順位を下げる
const NEWS_OUTLETS = new Set([
  ...OUTLET_PRIORITY, "朝日新聞", "読売新聞", "毎日新聞", "日本経済新聞", "産経新聞", "東京新聞", "日テレ",
  "テレビ朝日", "FNN", "CNN", "ロイター", "ブルームバーグ", "Yahoo!ニュース",
]);

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

// ---- 見出し・媒体名・概要文の整理 ----

// Yahoo!ニュースの「…(共同通信)」、Googleニュースの「… - 読売新聞」から媒体名を分ける
function splitOutlet(feed, title) {
  let m = null;
  if (feed.outletFrom === "paren") m = title.match(/^(.*\S)\s*[（(]([^（()）]{1,24})[)）]$/);
  else if (feed.outletFrom === "dash") m = title.match(/^(.*\S)\s+-\s+([^-]{1,30})$/);
  const outlet = (m?.[2] ?? feed.outlet ?? feed.name).trim();
  return { title: m?.[1] ?? title, outlet: OUTLET_ALIASES[outlet] ?? outlet };
}

// 【動画】【速報】などの見出しの飾りを外す
const displayTitle = (t) => t.replace(/^(?:【[^】]{1,12}】\s*)+/, "").trim();

// 毎日決まって配信される天気予報や、時刻付きの警報の自動配信は「話題のニュース」に入れない
const ROUTINE = /の天気|天気予報|週間天気|天気情報|【天気】|気象情報|\d{1,2}:\d{2}時点|占い|運勢/;

// 配信元の概要文を要約として使えるように整える
function cleanSummary(text, title) {
  let s = (text ?? "")
    .replace(/^【[^】]{1,30}】\s*/, "") // 【10月22日 AFP】【ワシントン共同】
    .replace(/^[（(][^（()）]{1,20}[)）]\s*[:：]?\s*/, "") // （ブルームバーグ）：
    .replace(/\s*(?:≫|>>)?\s*続きを読む.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.startsWith(title)) s = s.slice(title.length).trim();
  if (s.length < 20 || title.includes(s)) return "";
  if (s.length > 220) {
    const cut = s.lastIndexOf("。", 220);
    s = cut > 80 ? s.slice(0, cut + 1) : `${s.slice(0, 200)}…`;
  }
  // 配信元が文の途中で切った概要は、最後の文末までにする (短くなりすぎるなら「…」を付ける)
  if (!/[。！？!?」』）)…]$/.test(s)) {
    const cut = s.lastIndexOf("。");
    s = cut >= 40 ? s.slice(0, cut + 1) : `${s}…`;
  }
  return s;
}

// ---- 前回までの記事 (world-cache.json) ----

async function loadCache() {
  const empty = { items: [], pages: {} };
  if (!PAGES_BASE) return empty;
  try {
    const res = await fetch(`${PAGES_BASE}/world-cache.json?t=${Date.now()}`, {
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const c = await res.json();
    return { items: Array.isArray(c.items) ? c.items : [], pages: c.pages ?? {} };
  } catch (err) {
    console.log(`world-cache: 前回分なし (${errDetail(err)})`);
    return empty;
  }
}

// 今回取得した記事と前回までの記事を合わせる。日付のない記事は最初に見た時刻を使う
function mergeItems(results, cache, feedsByName, now) {
  const byLink = new Map();
  for (const it of cache.items) {
    if (feedsByName.has(it.f) && now - it.ts <= KEEP_MS && !ROUTINE.test(it.t)) byLink.set(it.l, it);
  }
  for (const { feed, items } of results) {
    items.forEach((raw, rank) => {
      const { title, outlet } = splitOutlet(feed, raw.title);
      if (ROUTINE.test(title)) return;
      const prev = byLink.get(raw.link);
      const ts = raw.ts && raw.ts <= now + 3600_000 ? raw.ts : (prev?.ts ?? now);
      if (now - ts > KEEP_MS) return;
      byLink.set(raw.link, {
        f: feed.name,
        t: title,
        l: raw.link,
        ts,
        o: outlet,
        d: feed.role === "content" ? cleanSummary(raw.description, title) : "",
        i: raw.image ?? prev?.i ?? null,
        r: rank,
      });
    });
  }
  return [...byLink.values()];
}

// ---- 記事ページの og:image / og:description ----

function metaContent(html, names) {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${name}["']`,
      "i",
    );
    const m = html.match(re);
    if (m) return decodeEntities(m[1] ?? m[2]).trim();
  }
  return null;
}

async function enrichPages(picks, pages, now) {
  // 同じ記事が2つの地域に入ることがあるので URL で重複を除く
  const targets = [...new Map(picks.map((p) => [p.url, p])).values()]
    .filter((p) => !p.image || !p.summary)
    .filter((p) => {
      const c = pages[p.url];
      return !c || ((!c.i || !c.d) && now - c.at > PAGE_RETRY_MS);
    })
    .slice(0, MAX_PAGE_FETCHES);
  let i = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (i < targets.length) {
        const p = targets[i++];
        try {
          const html = (await fetchText(p.url, PAGE_TIMEOUT_MS, "text/html")).slice(0, 300_000);
          const image = metaContent(html, ["og:image", "twitter:image"]);
          pages[p.url] = {
            i: image && /^https?:\/\//.test(image) ? image : null,
            d: cleanSummary(metaContent(html, ["og:description", "description"]), p.title),
            at: now,
          };
        } catch {
          pages[p.url] = { i: null, d: "", at: now };
        }
      }
    }),
  );
  for (const p of picks) {
    const c = pages[p.url];
    if (!c) continue;
    p.image ??= c.i;
    if (!p.summary) p.summary = c.d;
  }
  return targets.length;
}

// ---- 地域ごとの話題ランキング ----

function buildRanking(items, feedsByName, now) {
  // 記事ごとに地域を判定する
  const enriched = items.map((it) => {
    const feed = feedsByName.get(it.f);
    return {
      ...it,
      title: it.t,
      role: feed.role,
      boost: feed.boost,
      rank: it.r,
      outlet: it.o,
      regions: classify({ title: it.t, description: it.d }, feed.kind),
      // 見出しに出てくる地域 (別の国の話題を同じ話題にまとめないために使う)
      geo: new Set(regionScores(it.t).keys()),
    };
  });

  const topics = [];
  for (const members of clusterItems(enriched)) {
    const content = members.filter((m) => m.role === "content");
    if (content.length === 0) continue; // 要約の元になる記事がない話題は使わない

    // 話題の地域 = 記事ごとの判定の平均 (どの記事でも出てくる地域ほど強い)
    const classified = members.filter((m) => m.regions.length > 0);
    if (classified.length === 0) continue;
    const weights = new Map();
    for (const m of classified) {
      for (const { region, relevance } of m.regions) weights.set(region, (weights.get(region) ?? 0) + relevance);
    }
    for (const [r, w] of weights) weights.set(r, Math.min(1, w / classified.length));
    // 一番強い地域以外は、記事の半数以上がその地域を指しているときだけ載せる
    // (ロシアの話題の記事の一部が米紙に触れているだけで北米に並ばないように)
    const top = Math.max(...weights.values());
    for (const [r, w] of weights) if (w < top && w < SECOND_REGION_WEIGHT) weights.delete(r);

    // 代表記事: 概要文が要約として使える長さか → 話題の中心的な見出しか + 配信元の優先順 → 新しさ
    const pr = (o) => {
      const i = OUTLET_PRIORITY.indexOf(o);
      return i < 0 ? OUTLET_PRIORITY.length : i;
    };
    const central = new Map(byCentrality(members).map(({ member, centrality }) => [member, centrality]));
    const maxCentral = Math.max(1, ...central.values());
    const repScore = (m) =>
      (m.d.length >= 40 ? 2 : 0) + central.get(m) / maxCentral + (OUTLET_PRIORITY.length - pr(m.outlet)) * 0.05;
    const rep = [...content].sort((a, b) => repScore(b) - repScore(a) || b.ts - a.ts)[0];

    // 同じ話題を伝えた他の媒体
    const seen = new Set([rep.outlet]);
    const coverage = [];
    for (const m of [...members].sort((a, b) => Number(b.role === "content") - Number(a.role === "content"))) {
      if (seen.has(m.outlet) || coverage.length >= 8) continue;
      seen.add(m.outlet);
      coverage.push({ s: m.outlet, t: displayTitle(m.t), u: m.l });
    }

    const trend = trendScore(members, now);
    // 報道機関が1社も伝えていない話題 (雑誌の特集など) は順位を下げる
    if (!members.some((m) => NEWS_OUTLETS.has(m.outlet))) trend.score *= 0.5;
    topics.push({ weights, trend, rep, coverage, members });
  }

  const regions = REGIONS.map(({ id, name }) => {
    const ranked = topics
      .filter((t) => (t.weights.get(id) ?? 0) >= MIN_REGION_WEIGHT)
      .map((t) => ({ t, score: t.trend.score * t.weights.get(id) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_N);
    return {
      id,
      name,
      items: ranked.map(({ t, score }) => ({
        id: createHash("sha1").update(t.rep.l).digest("hex").slice(0, 12),
        title: displayTitle(t.rep.t),
        summary: t.rep.d,
        url: t.rep.l,
        source: t.rep.outlet,
        ts: t.trend.newest,
        image: t.rep.i ?? null,
        outlets: t.trend.outlets,
        score: Math.round(score * 100) / 100,
        coverage: t.coverage,
      })),
    };
  });
  return { regions, topics };
}

// 地域の盛り上がり (地図の光り方) を 0〜1 にする: 上位3件の話題度の合計を最大の地域で割る
function addHeat(regions) {
  const sums = regions.map((r) => r.items.slice(0, 3).reduce((n, it) => n + it.score, 0));
  const max = Math.max(...sums, 0.0001);
  regions.forEach((r, i) => {
    r.heat = Math.round((sums[i] / max) * 100) / 100;
  });
}

// ---- 表示 (メンテ用) ----

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

// まとめ方の確認用: 記事数の多い話題について、まとめた見出しを並べる
function printBigTopics(topics) {
  console.log("\n==== 記事数の多い話題 (まとめ方の確認)");
  for (const t of [...topics].sort((a, b) => b.members.length - a.members.length).slice(0, 10)) {
    const regions = [...t.weights].map(([r, w]) => `${r}:${w.toFixed(2)}`).join(" ");
    console.log(`■ ${t.members.length}件 ${t.trend.outlets}社 [${regions}]`);
    for (const m of t.members.slice(0, 6)) console.log(`    ${m.outlet}: ${m.t.slice(0, 48)}`);
  }
}

function printRanking(regions) {
  for (const r of regions) {
    console.log(`\n==== ${r.name} (heat ${r.heat}) ${r.items.length}件`);
    r.items.forEach((it, i) => {
      console.log(
        `${String(i + 1).padStart(2)}. [${it.score}] ${it.title.slice(0, 44)}  — ${it.source} / ${it.outlets}社 ${fmt(it.ts)}${it.image ? " 📷" : ""}`,
      );
      console.log(`      要約: ${it.summary ? it.summary.slice(0, 60) : "(なし)"}`);
      if (it.coverage.length) console.log(`      他: ${it.coverage.map((c) => c.s).join("、")}`);
    });
  }
}

// ---- 本体 ----

export async function run({ probe = false, dryRun = false } = {}) {
  const feeds = await loadFeeds();
  const results = await fetchAllFeeds(feeds);
  if (probe) {
    printProbe(results);
    return;
  }

  const now = Date.now();
  const feedsByName = new Map(feeds.map((f) => [f.name, f]));
  for (const { feed, items, error } of results) {
    console.log(error ? `NG ${feed.name}: ${error}` : `OK ${feed.name}: ${items.length} items`);
  }
  // 1つも取れないときは通信障害なので、空のランキングで上書きせず前回分を残す (呼び出し元で処理)
  if (results.every((r) => r.error)) throw new Error("すべてのフィードの取得に失敗しました");

  const cache = await loadCache();
  const items = mergeItems(results, cache, feedsByName, now);
  const { regions, topics } = buildRanking(items, feedsByName, now);

  const picks = regions.flatMap((r) => r.items);
  const fetched = await enrichPages(picks, cache.pages, now);
  addHeat(regions);

  console.log(
    `\n${results.filter((r) => !r.error).length}/${feeds.length} feeds, ${items.length} items, ` +
      `${topics.length} topics, ${picks.length} picks (pages fetched: ${fetched})`,
  );

  if (dryRun) {
    printBigTopics(topics);
    printRanking(regions);
    return;
  }

  // 期限切れのページ情報は捨てる
  const pages = Object.fromEntries(Object.entries(cache.pages).filter(([, c]) => now - c.at <= KEEP_MS));
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "world.json"), JSON.stringify({ updated: now, regions }));
  await writeFile(path.join(OUT_DIR, "world-cache.json"), JSON.stringify({ updated: now, items, pages }));
  console.log("-> public/world.json, public/world-cache.json");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run({ probe: process.argv.includes("--probe"), dryRun: process.argv.includes("--dry-run") });
  } catch (err) {
    // 世界ニュースの失敗でまとめ記事の更新まで止めないよう、前回公開した分を載せ直して正常終了する
    // (前回分も取れなければ空の結果にする)
    console.error(`fetch-world failed: ${err?.stack ?? err}`);
    await mkdir(OUT_DIR, { recursive: true });
    for (const file of ["world.json", "world-cache.json"]) {
      try {
        if (!PAGES_BASE) throw new Error("PAGES_BASE が未設定");
        const res = await fetch(`${PAGES_BASE}/${file}?t=${Date.now()}`, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await writeFile(path.join(OUT_DIR, file), await res.text());
        console.log(`-> 前回の ${file} を載せ直しました`);
      } catch (e) {
        console.error(`前回の ${file} を取得できません (${errDetail(e)})`);
        if (file !== "world.json") continue;
        const regions = REGIONS.map(({ id, name }) => ({ id, name, heat: 0, items: [] }));
        await writeFile(path.join(OUT_DIR, file), JSON.stringify({ updated: Date.now(), regions }));
      }
    }
  }
}
