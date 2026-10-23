// 世界ニュースの話題ごとに各社の記事の本文を読み、アプリの中で読める要約 (digest) を作って
// fetch-world.mjs が書き出した public/world.json の各記事に書き足す (fetch-world.mjs の後に実行)。
// ANTHROPIC_API_KEY があれば Claude で分かりやすくまとめ、なければ (または失敗したら) 記事の冒頭の文を使う。
// 作った要約は public/world-digest.json に残し、次回からは新しい話題だけを要約する。
// 依存: linkedom, @mozilla/readability, @anthropic-ai/sdk (ワークフロー内で npm install する)
//   node scripts/world-digest.mjs  … 通常実行

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { fetchText } from "./fetchtext.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, "public");
const PAGES_BASE = (process.env.PAGES_BASE ?? "https://tsuyoshistyleball-collab.github.io/warota").replace(/\/+$/, "");
const MODEL = "claude-haiku-5-5";
const MAX_AI_PER_RUN = 40; // 1回の実行で AI に要約させる話題の上限 (料金と実行時間の歯止め)
const MAX_PAGES_PER_RUN = 150; // 1回の実行で記事ページを読みに行く上限
const TEXTS_PER_TOPIC = 3; // 1つの話題で読む記事の数 (別々の報道機関から)
const TEXT_CHARS = 1600; // 1記事あたり AI に渡す本文の文字数
const PAGE_TIMEOUT_MS = 12_000;
const KEEP_MS = 3 * 24 * 3600_000; // 要約を覚えておく期間
const REFRESH_MS = 3 * 3600_000; // 続報で伝える社が増えた話題を要約し直すまでの間隔
// 要約の作り方の版。上げると前回までの要約を使わずに作り直す (v2: 別の出来事の記事を使わない)
const DIGEST_VERSION = 2;
// Claude Haiku 5.5 の料金 (100万トークンあたりのドル。ログに目安を出すため)
const PRICE = { input: 0.1, output: 0.5 };

// 本文を読めないページ (NHK は利用確認の画面だけ、Google ニュースは転送用のページ)
const SKIP_HOST_RE = /(^|\.)(web\.nhk|nhk\.or\.jp|news\.google\.com)$/;
// 本文を読みに行く報道機関の優先順 (本文がページにそのまま載っていて、取り出しやすい順)。
// ここにない報道機関はこの後、会員限定で冒頭しか読めないことの多い社は最後に回す
const TEXT_PRIORITY = ["AFP", "BBC", "時事通信", "共同通信", "日テレ", "TBS", "産経新聞", "ロイター", "CNN", "FNN", "テレビ朝日"];
const TEXT_LAST = ["読売新聞", "毎日新聞", "日本経済新聞", "朝日新聞"];

// ---- 記事ページの本文 ----

// 本文の段落に分ける (段落・改行・箇条書きの区切りで)
function paragraphsOf(html) {
  return html
    .replace(/<(br|\/?(p|div|li|ul|ol|h[1-6]|blockquote|table|tr|section|article|figure|figcaption))\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// 写真の説明・見出し・日付・著者名・共有ボタンなどを除き、文として書かれた段落だけを残す
const JUNK_LINE_RE = /^(画像提供|画像説明|動画説明|Published|この記事は約|関連コンテンツ|印刷する|はてなブックマーク|©|【(映像|画像|動画|写真)】|※画像)/;
// 会員限定の記事の案内 (「この記事は有料記事です。残り1234文字」)・写真の注意書き・メールマガジンの案内など
const NOTICE_RE =
  /(有料|会員限定)記事|有料会員|残り\s*[\d,，]+\s*文字|続きを読む|(ログイン|会員登録|購読)(すると|して)(続き|全文|お読み|読め)|ショッキングな表現|年齢制限の対象|ご了承の上、クリック|ニュースレター|配信解除|ご登録いただいた/;
export function cleanParagraphs(paragraphs) {
  const out = [];
  for (let p of paragraphs) {
    if (JUNK_LINE_RE.test(p) || NOTICE_RE.test(p)) continue;
    p = p
      .replace(/^【[^】]{1,30}】\s*/, "") // 【ニューヨーク＝木瀬武】などの発信地
      .replace(/\s*[（(]c[)）]\s*AFP\s*$/i, "")
      .replace(/\s*[（(]共同[)）]\s*$/, "");
    // 途中で切れた文 (「…」で終わる) は、最後の文末までにする
    if (/(…|\.\.\.)$/.test(p)) p = p.slice(0, p.lastIndexOf("。") + 1);
    // 文が1つもない行 (写真の説明「〜＝ロイター」、見出し、日付、著者名) は除く
    if (p.length < 20 || !p.includes("。")) continue;
    out.push(p);
  }
  return out;
}

// 記事ページから本文の段落を取り出す
export async function articleText(url) {
  let target = url;
  let selector = null;
  // TBS NEWS DIG は1ページ目に冒頭しか載らないので、全文を1ページに出すURLを読む
  if (/^https?:\/\/newsdig\.tbs\.co\.jp\//.test(url)) {
    target = `${url.split("?")[0]}?display=1`;
    selector = ".article-body";
  }
  const html = await fetchText(target, PAGE_TIMEOUT_MS, "text/html");
  const { document } = parseHTML(html);
  const box = selector && document.querySelector(selector);
  const content = box ? box.innerHTML : new Readability(document, { charThreshold: 200 }).parse()?.content;
  return cleanParagraphs(content ? paragraphsOf(content) : []);
}

// 段落をつないで、文の切れ目で max 文字までにする
export function clipText(paragraphs, max) {
  let text = "";
  for (const p of paragraphs) {
    if (text.length + p.length + 1 <= max) {
      text += (text ? "\n" : "") + p;
      continue;
    }
    const room = max - text.length - 1;
    const cut = p.lastIndexOf("。", room);
    if (cut > 0) text += (text ? "\n" : "") + p.slice(0, cut + 1);
    break;
  }
  return text;
}

// 見出しどうしの近さ (2文字ずつの重なりの割合 0〜1)。同じ出来事を伝える記事を選ぶ目安にする
const bigrams = (s) => {
  const t = (s ?? "").normalize("NFKC").replace(/【[^】]*】/g, "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
};
export function titleSimilarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return (2 * n) / (A.size + B.size);
}
// 同じ話題にまとめた記事には、別の出来事の記事が混ざることがある。見出しがこれより遠い記事は読まない
const MIN_SIMILARITY = 0.12;
// AI を使わないときは、代表記事か、見出しがかなり近い記事 (同じ出来事とみてよいもの) だけを使う
const LEAD_SIMILARITY = 0.3;

// 本文を読みに行く記事を並べる: 代表記事 (話題の見出しの記事) を最初に、他社の記事は見出しが近い順に (1社1本)
export function textSources(item) {
  const rank = (outlet) => {
    const i = TEXT_PRIORITY.indexOf(outlet);
    if (i >= 0) return i;
    return TEXT_LAST.includes(outlet) ? 100 + TEXT_LAST.indexOf(outlet) : 50;
  };
  const seen = new Set();
  const list = [];
  for (const [i, { s, u, t }] of [{ s: item.source, u: item.url }, ...(item.coverage ?? [])].entries()) {
    let host;
    try {
      host = new URL(u).hostname;
    } catch {
      continue;
    }
    if (SKIP_HOST_RE.test(host) || seen.has(s)) continue;
    const similarity = i === 0 ? 1 : titleSimilarity(item.title, t);
    if (similarity < MIN_SIMILARITY) continue;
    seen.add(s);
    list.push({ outlet: s, url: u, similarity });
  }
  // 代表記事 → 見出しが近い記事 → 少し遠い記事。それぞれの中では本文を取り出しやすい報道機関から
  const tier = (x) => (x.similarity === 1 ? 0 : x.similarity >= 0.2 ? 1 : 2);
  return list.sort((a, b) => tier(a) - tier(b) || rank(a.outlet) - rank(b.outlet) || b.similarity - a.similarity);
}

// ---- 要約 ----

const SYSTEM_PROMPT = `あなたはニュースを分かりやすく伝える編集者です。
ニュースの見出しと、その出来事を伝える報道機関の記事 (本文の抜粋や概要) を読み、スマートフォンのニュースアプリに載せる要約を日本語で書いてください。
読んだ人が元の記事を開かなくても、何が起きたのか・なぜ大事なのかが分かることが目標です。

- 記事の中には、見出しとは別の出来事を伝えるものが混ざっていることがあります。見出しと同じ出来事を伝えている記事だけを使い、使った記事の番号を used に入れてください。見出しと同じ出来事を伝える記事が1つもなければ、lead を空にしてください。
- 記事に書かれている事実だけを使ってください。記事にない出来事・数字・発言を補ったり推測したりしないでください。
- 報道機関によって内容が食い違うときは、確かなほうだけを書くか、「〜と伝えられています」のように書いてください。
- 専門用語や略語は、ニュースに詳しくない人にも分かる言葉で短く言い換えてください。
- 数字・日付・人名・地名・組織名は記事のとおりに書いてください。
- 「です・ます」で、1文を短く書いてください。

項目ごとの書き方:
- lead: 何が起きたかを1〜2文で (100字程度まで)
- points: 知っておきたいポイントを3〜5個。1つにつき1〜2文 (80字程度まで)。lead の言い換えではなく、詳しい中身・数字・関係者の発言や反応などを書く
- background: 出来事の背景や、分かりにくい言葉の説明を1〜2文。記事から分かることと、一般によく知られた言葉の意味の範囲で書く。書くことがなければ空にする
- next: 今後の予定や見通し。記事に書かれているときだけ1文。なければ空にする`;

const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    lead: { type: "string", description: "何が起きたかを1〜2文で" },
    points: { type: "array", items: { type: "string" }, description: "知っておきたいポイント (3〜5個)" },
    background: { type: "string", description: "背景・用語の説明 (なければ空文字)" },
    next: { type: "string", description: "今後の予定・見通し (なければ空文字)" },
    used: { type: "array", items: { type: "integer" }, description: "要約に使った記事の番号" },
  },
  required: ["lead", "points", "background", "next", "used"],
  additionalProperties: false,
};

// 見出しと同じ出来事の記事がなかったとき (AI の答えの lead が空)
export class NoMatchingArticle extends Error {}

// AI の答えを確かめて整える (形がおかしければ例外にして、記事の冒頭の文を使う)
export function normalizeDigest(raw) {
  const str = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const lead = str(raw?.lead, 240);
  if (!lead) throw new NoMatchingArticle("見出しと同じ出来事を伝える記事がありません");
  const points = (Array.isArray(raw?.points) ? raw.points : []).map((p) => str(p, 200)).filter(Boolean).slice(0, 6);
  if (points.length < 2) throw new Error("要約の形が正しくありません");
  const used = (Array.isArray(raw?.used) ? raw.used : []).filter(Number.isInteger);
  return { lead, points, background: str(raw?.background, 300), next: str(raw?.next, 200), used };
}

// Claude に要約させる。docs は本文の抜粋や概要 ({ outlet, text })
async function aiDigest(client, item, docs) {
  const body = docs.map((d, i) => `<記事 番号="${i + 1}" 報道機関="${d.outlet}">\n${d.text}\n</記事>`);
  const response = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      output_config: { effort: "low", format: { type: "json_schema", schema: DIGEST_SCHEMA } },
      messages: [{ role: "user", content: `見出し: ${item.title}\n\n${body.join("\n\n")}` }],
    },
    { timeout: 60_000 },
  );
  if (response.stop_reason !== "end_turn") throw new Error(`stop_reason: ${response.stop_reason}`);
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  const { used, ...digest } = normalizeDigest(JSON.parse(text));
  // 使った記事の報道機関 (答えに番号がなければ、渡したものすべて)
  const picked = used.map((n) => docs[n - 1]?.outlet).filter(Boolean);
  const sources = [...new Set(picked.length ? picked : docs.map((d) => d.outlet))];
  return { digest, sources, usage: response.usage };
}

// 文に分ける (「。」などで区切る。かぎかっこの中の「。」では区切らない)
export function sentencesOf(text) {
  const out = [];
  let cur = "";
  let depth = 0;
  for (const ch of text) {
    if (ch === "\n") {
      // 段落の終わり。文の終わりの記号がない切れ端 (写真の説明など) は捨てる
      if (/[。！？!?」』]$/.test(cur.trim())) out.push(cur.trim());
      cur = "";
      depth = 0;
      continue;
    }
    cur += ch;
    if (ch === "「" || ch === "『") depth++;
    else if ((ch === "」" || ch === "』") && depth > 0) depth--;
    else if (depth === 0 && /[。！？!?]/.test(ch)) {
      out.push(cur.trim());
      cur = "";
    }
  }
  if (/[。！？!?」』]$/.test(cur.trim())) out.push(cur.trim());
  return out.filter((s) => s.length >= 10);
}

// AI を使わないときの要約: 記事の冒頭の文をそのまま使う
export function leadDigest(text) {
  const sentences = sentencesOf(text);
  if (sentences.length === 0) return null;
  const picked = [];
  let length = 0;
  for (const s of sentences) {
    if (picked.length >= 4 || (picked.length >= 2 && length + s.length > 320)) break;
    picked.push(s);
    length += s.length;
  }
  return { lead: picked[0], points: picked.slice(1), background: "", next: "" };
}

// ---- 前回までの要約 (world-digest.json) ----

async function loadSaved() {
  try {
    const res = await fetch(`${PAGES_BASE}/world-digest.json?t=${Date.now()}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const saved = await res.json();
    return Array.isArray(saved.digests) ? saved.digests : [];
  } catch (err) {
    console.log(`world-digest: 前回分なし (${err.message})`);
    return [];
  }
}

const urlsOf = (item) => [item.url, ...(item.coverage ?? []).map((c) => c.u)].filter(Boolean);

// 話題に使える前回までの要約を探す (代表記事が入れ替わっても、同じ記事を含む要約なら同じ話題)
export function findSaved(item, byUrl) {
  let best = null;
  for (const u of urlsOf(item)) {
    const d = byUrl.get(u);
    if (d && (!best || d.at > best.at)) best = d;
  }
  return best;
}

// 今回やること: new (要約がない) / upgrade (記事の冒頭だけの要約を AI でまとめ直す) / refresh (続報で伝える社が増えた)
export function planFor(item, saved, { ai, now }) {
  if (!saved) return "new";
  // 本文を読めなかった話題は、伝える社が増えたか、しばらくたったときにもう一度試す
  if (saved.by === "none") return item.outlets > (saved.outlets ?? 0) || now - saved.at >= REFRESH_MS ? "new" : null;
  if (ai && saved.by !== "ai") return "upgrade";
  if (ai && item.outlets >= (saved.outlets ?? 0) + 3 && now - saved.at >= REFRESH_MS) return "refresh";
  return null;
}

// ---- 本体 ----

let Anthropic = null; // @anthropic-ai/sdk (APIキーがあるときだけ読み込む)

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

// outDir と client は試験用 (ふだんは public/ と、APIキーがあれば Claude のクライアント)
export async function run({ outDir = OUT_DIR, client = undefined } = {}) {
  const worldPath = path.join(outDir, "world.json");
  const world = JSON.parse(await readFile(worldPath, "utf8"));
  const now = Date.now();

  // 同じ話題が2つの地域に入ることがあるので、記事の id でまとめる。上位の話題から順に要約する
  const byId = new Map();
  const maxLen = Math.max(0, ...world.regions.map((r) => r.items.length));
  for (let rank = 0; rank < maxLen; rank++) {
    for (const r of world.regions) {
      const it = r.items[rank];
      if (it && !byId.has(it.id)) byId.set(it.id, it);
    }
  }
  const items = [...byId.values()];

  const savedList = (await loadSaved()).filter((d) => d.v === DIGEST_VERSION && now - d.at <= KEEP_MS);
  const byUrl = new Map();
  for (const d of [...savedList].sort((a, b) => a.at - b.at)) for (const u of d.urls ?? []) byUrl.set(u, d);

  if (client === undefined) {
    client = null;
    if (process.env.ANTHROPIC_API_KEY) {
      ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
      client = new Anthropic();
    } else {
      console.log("world-digest: ANTHROPIC_API_KEY がないので、AI を使わずに記事の冒頭の文で要約します");
    }
  }

  // やることの多い順 (新しい話題 → まとめ直し → 続報) に、上位の話題から
  const order = { new: 0, upgrade: 1, refresh: 2 };
  const tasks = items
    .map((item) => {
      const saved = findSaved(item, byUrl);
      return { item, saved, plan: planFor(item, saved, { ai: !!client, now }) };
    })
    .filter((t) => t.plan)
    .sort((a, b) => order[a.plan] - order[b.plan]);

  const stats = { ai: 0, lead: 0, failed: 0, pages: 0, input: 0, output: 0 };
  let aiLeft = client ? MAX_AI_PER_RUN : 0;
  let aiErrors = 0;
  const made = new Map(); // item.id → 今回作った要約

  await pool(tasks, 4, async ({ item, saved, plan }) => {
    const useAi = aiLeft > 0;
    // AI の上限を超えた分は、要約がまだない話題だけ記事の冒頭で作っておく (次の実行で AI がまとめ直す)
    if (!useAi && plan !== "new") return;
    if (useAi) aiLeft--;

    // 本文を読む (別々の報道機関から最大3本。AI を使わないときは、代表記事か見出しのかなり近い記事を1本)
    const texts = [];
    for (const src of textSources(item)) {
      if (texts.length >= (useAi ? TEXTS_PER_TOPIC : 1) || stats.pages >= MAX_PAGES_PER_RUN) break;
      if (!useAi && src.similarity < LEAD_SIMILARITY) break;
      stats.pages++;
      try {
        const text = clipText(await articleText(src.url), TEXT_CHARS);
        if (text.length >= 120) texts.push({ outlet: src.outlet, text, similarity: src.similarity });
      } catch {}
    }
    const textChars = texts.reduce((n, t) => n + t.text.length, 0);

    let digest = null;
    let by = "lead";
    let sources = texts.slice(0, 1).map((t) => t.outlet);
    let noMatch = false;
    if (useAi && textChars >= 200 && aiErrors < 3) {
      // 本文を読めなかった代表記事 (NHK など) は、配信元の概要文を添える (どの出来事の話題かの手がかりにもなる)
      const docs = texts.map(({ outlet, text }) => ({ outlet, text }));
      if (item.summary && !texts.some((t) => t.outlet === item.source)) docs.push({ outlet: item.source, text: item.summary });
      try {
        const res = await aiDigest(client, item, docs);
        digest = res.digest;
        by = "ai";
        sources = res.sources;
        stats.input += res.usage.input_tokens;
        stats.output += res.usage.output_tokens;
        aiErrors = 0;
      } catch (err) {
        if (err instanceof NoMatchingArticle) {
          noMatch = true;
        } else {
          aiErrors++;
          // APIキーの誤りや使いすぎの制限は、続けても同じなので今回は AI を使うのをやめる
          if (Anthropic && err instanceof Anthropic.AuthenticationError) {
            aiErrors = 3;
            console.log("world-digest: APIキーが正しくありません (GitHub の Secrets の ANTHROPIC_API_KEY を確認してください)");
          } else if (Anthropic && err instanceof Anthropic.RateLimitError) {
            aiErrors = 3;
            console.log("world-digest: API の利用制限に達したので、今回は AI での要約を止めます");
          } else {
            console.log(`world-digest: AI 要約に失敗 (${item.title.slice(0, 30)}): ${err.message}`);
          }
        }
      }
    }
    // AI を使わなかった・失敗したときは記事の冒頭の文で (代表記事か、見出しのかなり近い記事だけ。
    // AI が「同じ出来事の記事がない」と答えたときや、前回 AI で作った要約があるときは作らない)
    const lead = texts.find((t) => t.similarity >= LEAD_SIMILARITY);
    if (!digest && lead && !noMatch && saved?.by !== "ai") {
      digest = leadDigest(lead.text);
      sources = [lead.outlet];
    }
    if (!digest) {
      // 要約を作れなかった新しい話題は、しばらく試し直さないよう印を残す
      if (plan === "new") {
        stats.failed++;
        made.set(item.id, { by: "none", urls: urlsOf(item), outlets: item.outlets, at: now, v: DIGEST_VERSION });
      }
      return;
    }
    stats[by]++;
    made.set(item.id, {
      ...digest,
      by,
      sources,
      urls: urlsOf(item),
      outlets: item.outlets,
      at: now,
      v: DIGEST_VERSION,
    });
  });

  // 記事に要約を書き足す (今回作ったもの、なければ前回までのもの)
  const used = new Map();
  for (const item of items) {
    const d = made.get(item.id) ?? findSaved(item, byUrl);
    if (!d) continue;
    // 前回までの要約に、今の話題の記事 URL を足しておく (次回も同じ話題として見つかるように)
    const merged = { ...d, urls: [...new Set([...(d.urls ?? []), ...urlsOf(item)])] };
    used.set(item.id, merged);
  }
  for (const r of world.regions) {
    for (const it of r.items) {
      const d = used.get(it.id);
      if (!d || d.by === "none") continue;
      const { lead, points, background, next, by, sources, at } = d;
      it.digest = { lead, points, background, next, by, sources, at };
    }
  }

  // 今回使ったものと、覚えておく期間内のものを保存する
  const keep = [...used.values()];
  const keptUrls = new Set(keep.flatMap((d) => d.urls));
  for (const d of savedList) if (!(d.urls ?? []).some((u) => keptUrls.has(u))) keep.push(d);
  await writeFile(worldPath, JSON.stringify(world));
  await writeFile(path.join(outDir, "world-digest.json"), JSON.stringify({ updated: now, digests: keep }));

  const cost = (stats.input * PRICE.input + stats.output * PRICE.output) / 1e6;
  console.log(
    `world-digest: ${items.length} topics, ${[...used.values()].filter((d) => d.by !== "none").length} with digest ` +
      `(this run: ${stats.ai} by AI, ${stats.lead} from lead, ${stats.failed} without text), ` +
      `pages ${stats.pages}, tokens ${stats.input}/${stats.output} (約 $${cost.toFixed(4)})`,
  );
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
        const paragraphs = await articleText(url);
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

// 調査用: 公開中の world.json で、地域ごとの上位の話題にどんな要約が付いているかを表示する
export async function show(perRegion = 3) {
  const world = await (await fetch(`${PAGES_BASE}/world.json?t=${Date.now()}`)).json();
  for (const r of world.regions) {
    console.log(`\n######## ${r.name}`);
    for (const it of r.items.slice(0, perRegion)) {
      const d = it.digest;
      console.log(`--- ${it.title} (${it.source}・${it.outlets}社)`);
      if (!d) {
        console.log(`    要約なし (概要文: ${it.summary || "なし"})`);
        continue;
      }
      console.log(`    [${d.by}] ${d.sources.join("・")}\n    ${d.lead}`);
      for (const p of d.points) console.log(`    ・${p}`);
      if (d.background) console.log(`    背景: ${d.background}`);
      if (d.next) console.log(`    今後: ${d.next}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run();
  } catch (err) {
    // 要約に失敗しても、ランキングと配信元の概要文はそのまま表示できるので正常終了する
    console.error(`world-digest failed: ${err?.stack ?? err}`);
  }
}
