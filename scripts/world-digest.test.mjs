// 世界ニュースの要約づくりのテスト。記事ページは手元の小さなサーバーから返し、AI は決まった答えを返す偽物を使う。
// linkedom と @mozilla/readability が必要 (ワークフローでだけ入れるので、入っていなければ飛ばす)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// 前回分の world-digest.json も手元のサーバーから読ませる (モジュールを読み込む前に決める)
const pages = new Map();
const server = createServer((req, res) => {
  const body = pages.get(req.url.split("?")[0]);
  res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  res.end(body ?? "not found");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
process.env.PAGES_BASE = BASE;

let mod = null;
try {
  mod = await import("./world-digest.mjs");
} catch {}
const skip = !mod && "linkedom / @mozilla/readability が入っていない";
test.after(() => server.close());

const article = (title, paragraphs, extra = "") =>
  `<!doctype html><html><head><title>${title}</title></head><body><header><nav><a href="/">トップ</a><a href="/world">国際</a></nav></header>
  <article><h1>${title}</h1><p>2026年10月23日 9:48 発信地：パリ/フランス</p><figure><img src="/a.jpg"><figcaption>写真の説明＝ロイター</figcaption></figure>
  ${paragraphs.map((p) => `<p>${p}</p>`).join("")}${extra}</article><aside><h2>注目の記事</h2><ul><li><a href="/x">別の記事の見出し</a></li></ul></aside></body></html>`;

const AFP = [
  "フランス保健当局は22日、主に家畜に感染するシャモンダウイルスについて、国内でヒトへの感染を初めて確認したと発表した。",
  "感染したのは東部に住む70代の男性で、高熱と意識障害で入院し、その後死亡した。",
  "当局によると、ウイルスは蚊やヌカカなどの虫を介して広がるとみられ、ヒトからヒトへの感染は確認されていない。",
  "保健当局は男性の家族や近所の住民に聞き取りを行い、ほかに同じ症状の人がいないか調べている。",
  "専門家は「一般市民が不安を抱く理由はないが、新しい感染症の監視が重要だ」と話している。(c)AFP",
];
const BBC = [
  "シャモンダウイルスは主に牛や羊に感染し、発熱や下痢、乳量の減少などを引き起こす。",
  "ヨーロッパでは今年7月下旬に初めて家畜への感染が確認され、その後アイルランドやドイツなどに広がった。",
  "フランスの農家の団体は、家畜へのワクチンの接種を急ぐよう政府に求めている。",
];

test("本文から写真の説明・日付・見出しを除き、文として書かれた段落だけを残す", { skip }, () => {
  const out = mod.cleanParagraphs([
    "2026年10月23日 9:48 発信地：パリ/フランス",
    "[",
    "中国",
    "画像提供, Getty Images",
    "フランス大統領府で会合に出席したマクロン大統領＝10月22日、パリ（AP＝共同）",
    "【ニューヨーク＝木瀬武】米マイクロソフトは21日、大規模なサイバー攻撃があったと発表した。",
    "この記事は有料記事です。残り1234文字あります。",
    "新居浜市は公共施設のウェブ予約を停止しています。システムの再開時期は未定で、窓口での手続きを呼び…",
    "サメは体長3メートルで、多くのファンを獲得した。(c)AFP",
  ]);
  assert.deepEqual(out, [
    "米マイクロソフトは21日、大規模なサイバー攻撃があったと発表した。",
    "新居浜市は公共施設のウェブ予約を停止しています。",
    "サメは体長3メートルで、多くのファンを獲得した。",
  ]);
});

test("本文を読みに行く記事は、読みやすい報道機関から1社1本ずつ (NHK と Google ニュースは読まない)", { skip }, () => {
  const list = mod.textSources({
    source: "NHK",
    url: "https://news.web.nhk/newsweb/na/nd-1",
    coverage: [
      { s: "朝日新聞", u: "https://www.asahi.com/articles/1.html" },
      { s: "毎日新聞", u: "https://news.google.com/rss/articles/CBMi" },
      { s: "BBC", u: "https://www.bbc.com/japanese/articles/1" },
      { s: "ABEMA TIMES", u: "https://news.yahoo.co.jp/articles/1" },
      { s: "AFP", u: "https://www.afpbb.com/articles/-/1" },
      { s: "AFP", u: "https://www.afpbb.com/articles/-/2" },
    ],
  });
  assert.deepEqual(list.map((s) => s.outlet), ["AFP", "BBC", "ABEMA TIMES", "朝日新聞"]);
});

test("AI の答えの形を確かめ、記事の冒頭から要約を作ることもできる", { skip }, () => {
  assert.throws(() => mod.normalizeDigest({ lead: "", points: ["a", "b"] }));
  assert.throws(() => mod.normalizeDigest({ lead: "何かが起きました。", points: ["1つだけ"] }));
  const d = mod.normalizeDigest({ lead: " 何かが\n起きました。 ", points: ["一つ目。", "", "二つ目。"], background: 3 });
  assert.deepEqual(d, { lead: "何かが 起きました。", points: ["一つ目。", "二つ目。"], background: "", next: "" });

  const lead = mod.leadDigest(AFP.join("\n"));
  assert.equal(lead.lead, AFP[0]);
  assert.ok(lead.points.length >= 1 && lead.points.length <= 3);
  assert.equal(mod.clipText(["一つ目の文です。二つ目の文です。", "次の段落です。"], 12), "一つ目の文です。");
});

test("前回の要約は記事の URL で探し、新しい話題・AI でのまとめ直し・続報を決める", { skip }, () => {
  const saved = { by: "lead", urls: ["https://a/1", "https://b/1"], outlets: 3, at: 0 };
  const byUrl = new Map(saved.urls.map((u) => [u, saved]));
  const item = { url: "https://c/9", coverage: [{ s: "B", u: "https://b/1" }], outlets: 3 };
  assert.equal(mod.findSaved(item, byUrl), saved);
  assert.equal(mod.planFor(item, null, { ai: false, now: 0 }), "new");
  assert.equal(mod.planFor(item, saved, { ai: false, now: 0 }), null);
  assert.equal(mod.planFor(item, saved, { ai: true, now: 0 }), "upgrade");
  const ai = { ...saved, by: "ai", at: 0 };
  assert.equal(mod.planFor({ ...item, outlets: 5 }, ai, { ai: true, now: 4 * 3600_000 }), null);
  assert.equal(mod.planFor({ ...item, outlets: 6 }, ai, { ai: true, now: 4 * 3600_000 }), "refresh");
  assert.equal(mod.planFor({ ...item, outlets: 6 }, ai, { ai: true, now: 3600_000 }), null);
  const none = { ...saved, by: "none", at: 0 };
  assert.equal(mod.planFor(item, none, { ai: true, now: 3600_000 }), null);
  assert.equal(mod.planFor({ ...item, outlets: 4 }, none, { ai: true, now: 3600_000 }), "new");
});

test("各社の記事を読んで AI で要約し、次の実行では前回の要約を使う (AI がないときは記事の冒頭)", { skip }, async () => {
  pages.set("/afp/1", article("シャモンダウイルスのヒト感染初確認", AFP));
  pages.set("/bbc/1", article("シャモンダウイルス、ヒト感染例を初めて確認", BBC));
  pages.set("/afp/2", article("別の話題", ["短い。"]));
  const item = (id, url, coverage, outlets) => ({ id, title: `見出し${id}`, summary: "NHKの概要文です。", url, source: "NHK", coverage, outlets });
  const world = {
    regions: [
      {
        id: "europe",
        items: [
          item("t1", "https://news.web.nhk/newsweb/na/nd-1", [{ s: "AFP", u: `${BASE}/afp/1` }, { s: "BBC", u: `${BASE}/bbc/1` }], 3),
          item("t2", `${BASE}/afp/2`, [], 1),
        ],
      },
      { id: "asia", items: [item("t1", "https://news.web.nhk/newsweb/na/nd-1", [{ s: "AFP", u: `${BASE}/afp/1` }], 3)] },
    ],
  };
  const dir = await mkdtemp(path.join(tmpdir(), "world-digest-"));
  await writeFile(path.join(dir, "world.json"), JSON.stringify(world));

  const calls = [];
  const client = {
    messages: {
      create: async (req) => {
        calls.push(req);
        const answer = { lead: "フランスでシャモンダウイルスのヒト感染が初めて確認されました。", points: ["感染した70代の男性は死亡しました。", "虫を介して広がるとみられます。"], background: "主に家畜の病気です。", next: "" };
        return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(answer) }], usage: { input_tokens: 1000, output_tokens: 200 } };
      },
    },
  };
  await mod.run({ outDir: dir, client });
  const out = JSON.parse(await readFile(path.join(dir, "world.json"), "utf8"));
  const [t1, t2] = out.regions[0].items;
  assert.equal(calls.length, 1); // 本文が短すぎる話題は AI に渡さない
  assert.equal(calls[0].model, "claude-haiku-5-5");
  const prompt = calls[0].messages[0].content;
  assert.ok(prompt.includes("70代の男性") && prompt.includes("7月下旬") && prompt.includes("NHKの概要文です。"));
  assert.ok(!prompt.includes("注目の記事") && !prompt.includes("＝ロイター") && !prompt.includes("発信地"));
  assert.equal(t1.digest.by, "ai");
  assert.deepEqual(t1.digest.sources, ["AFP", "BBC", "NHK"]);
  assert.deepEqual(out.regions[1].items[0].digest, t1.digest); // 2つの地域に入った同じ話題
  assert.equal(t2.digest, undefined);

  // 次の実行: 前回の要約を公開先から読み、AI がなくても使う (代表記事が入れ替わっても、同じ記事を含めば同じ話題)
  pages.set("/world-digest.json", await readFile(path.join(dir, "world-digest.json"), "utf8"));
  world.regions[0].items[0] = item("t1b", `${BASE}/bbc/1`, [{ s: "AFP", u: `${BASE}/afp/1` }], 3);
  world.regions[0].items.push(item("t3", "https://news.web.nhk/newsweb/na/nd-3", [{ s: "共同通信", u: `${BASE}/missing` }], 2));
  await writeFile(path.join(dir, "world.json"), JSON.stringify(world));
  await mod.run({ outDir: dir, client: null });
  const out2 = JSON.parse(await readFile(path.join(dir, "world.json"), "utf8"));
  assert.equal(out2.regions[0].items[0].digest.by, "ai");
  assert.equal(out2.regions[0].items[0].digest.lead, t1.digest.lead);
  // 本文を読めなかった話題には要約を付けず、しばらく試し直さないよう印だけ残す
  assert.equal(out2.regions[0].items[2].digest, undefined);
  const saved = JSON.parse(await readFile(path.join(dir, "world-digest.json"), "utf8")).digests;
  assert.ok(saved.some((d) => d.by === "none" && d.urls.includes(`${BASE}/missing`)));
});

test("AI がないときは、いちばん読みやすい記事の冒頭の文を要約にする", { skip }, async () => {
  pages.set("/afp/3", article("別のシャモンダウイルスの記事", AFP));
  pages.delete("/world-digest.json");
  const world = { regions: [{ id: "europe", items: [{ id: "t9", title: "見出し", url: "https://news.web.nhk/n/1", source: "NHK", coverage: [{ s: "AFP", u: `${BASE}/afp/3` }], outlets: 2 }] }] };
  const dir = await mkdtemp(path.join(tmpdir(), "world-digest-"));
  await writeFile(path.join(dir, "world.json"), JSON.stringify(world));
  await mod.run({ outDir: dir, client: null });
  const out = JSON.parse(await readFile(path.join(dir, "world.json"), "utf8"));
  const d = out.regions[0].items[0].digest;
  assert.equal(d.by, "lead");
  assert.deepEqual(d.sources, ["AFP"]);
  assert.equal(d.lead, AFP[0]);
});
