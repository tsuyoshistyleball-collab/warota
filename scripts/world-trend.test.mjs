// 話題のまとめ方のテスト。実行: node --test scripts/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterItems } from "./world-trend.mjs";
import { regionScores } from "./world-regions.mjs";

// 実際のニュースの見出し (2026-10-22 取得分) を中心にしたサンプル
const TITLES = [
  "プログラミング言語「ＰＨＰ」に脆弱性 世界のサイト７割が危険に",
  "“PHPでぜい弱性確認 速やかな対応を”情報処理推進機構",
  "プログラム言語「PHP」欠陥発覚、一部の金融機関でウェブサービス停止",
  "欧州で政府系サイトが停止 FBIも注意喚起 PHP脆弱性めぐり",
  "秋田・子吉川 氾濫注意報に切替",
  "秋田 子吉川 氾濫特別警報は注意報に 危険な場所に近づかない",
  "【速報中】秋田・子吉川で氾濫発生 由利本荘市の一部に警戒レベル5緊急安全確保",
  "米刑務所で性別適合医療を許可 最高裁、トランプ政権方針を停止",
  "「トランプ党」相次ぐトランプ隠し 大統領は不支持、でも理念は支持",
  "米政権の「腐敗」争点に トランプ一族 資産拡大に批判 不当な個人的利益 見方",
  "フランス10年もの国債利回り5％に 24年ぶりの高水準",
  "韓国の国債利回り 5％台に上昇",
  "北朝鮮、南北軍事境界線沿いに地雷や鉄柵設置し「要塞化」…韓国との武力衝突懸念高まる",
  "北、軍事境界沿い「要塞化」 道路造成、地雷や鉄柵設置 武力衝突懸念高まる",
  "台風30号が沖縄に接近 週末は広範囲で大雨のおそれ",
  "自民 衆院定数の削減幅を31で調整",
];

// 本番は1回に千件以上を比べるので、「トランプ」「政府」のようなよく出る語の重みは小さくなる。
// それを再現するため、よく出る語と1回限りの地名だけでできた見出しを混ぜる
function fillers(n) {
  const kana = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモラリルレロ";
  let seed = 7;
  const rand = () => (seed = (seed * 48271) % 2147483647);
  const word = () => Array.from({ length: 5 }, () => kana[rand() % kana.length]).join("");
  const forms = [
    (w) => `トランプ大統領 ${w}を訪問`,
    (w) => `政府 ${w}への支援を表明`,
    (w) => `首相 ${w}と会談`,
    (w) => `${w}政権を批判`,
    (w) => `韓国 ${w}で事故`,
  ];
  return Array.from({ length: n }, (_, i) => forms[i % forms.length](word()));
}

function groups() {
  const now = Date.now();
  const titles = [...TITLES, ...fillers(120)];
  const items = titles.map((title, i) => ({ title, ts: now - i * 60_000, geo: new Set(regionScores(title).keys()) }));
  return clusterItems(items)
    .map((c) => c.map((m) => TITLES.indexOf(m.title)).filter((i) => i >= 0).sort((a, b) => a - b))
    .filter((g) => g.length > 0);
}
const groupOf = (gs, i) => gs.find((g) => g.includes(i));

test("同じ出来事を伝える記事は1つの話題にまとまる", () => {
  const gs = groups();
  assert.deepEqual(groupOf(gs, 0), [0, 1, 2, 3], "PHPの脆弱性");
  assert.deepEqual(groupOf(gs, 4), [4, 5, 6], "子吉川の氾濫");
  assert.deepEqual(groupOf(gs, 12), [12, 13], "北朝鮮の要塞化");
});

test("同じ人物が出てくるだけの別の話題はまとめない", () => {
  const gs = groups();
  for (const i of [7, 8, 9]) assert.deepEqual(groupOf(gs, i), [i], TITLES[i]);
});

test("別の国の似た話題 (国債利回り) はまとめない", () => {
  const gs = groups();
  assert.deepEqual(groupOf(gs, 10), [10]);
  assert.deepEqual(groupOf(gs, 11), [11]);
});

test("数珠つなぎで大きな塊にならない", () => {
  assert.ok(groups().every((g) => g.length <= 4));
});
