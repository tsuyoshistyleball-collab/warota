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
  // 16〜: 同じ種類の別の出来事 (まとめない)
  "「コミックシーモア」 最大でおよそ420万件の個人情報流出",
  "イオングループ13社の42サイトに不正アクセス 情報流出は調査中",
  "鳥取県平井知事 知事選不出馬を表明 会見では感極まり涙を流す場面も",
  "セーリングで境港から世界へ 鳥取県に移住し練習に励むペアが全日本選手権へ",
  "プーチン氏、中国首相と会談「実務協力を拡大」 11月の首脳会談に意欲",
  "茂木外相 ＡＳＥＡＮ事務局長と会談 11月の首脳会議へ緊密連携",
  // 22〜: 同じ出来事 (まとめる)
  "武部農相 衆院選公示日の寄付“全額返金し収支報告書を訂正”",
  "武部農水相、21日に返金し政治資金収支報告書も訂正 衆院選中に公共事業請け負う企業から寄付",
  // 24〜: 漢字の熟語が1つ重なるだけの別の出来事 (まとめない)
  "新名神高速6人死亡事故 被告に拘禁刑7年の判決 津地裁",
  "女性の遺体に性行為、拘禁刑1年4カ月 イギリス",
  "《ブラジル》岐阜県人会＝画家40人、個性豊かな63作品＝日伯友情交流絵画展25日まで",
  "「どんな店になるか楽しみ」個性豊かな売り場が人気ロピアが鹿児島初進出",
  "オープンAIの数学論文「大量公開」で、若手の研究が丸ごと吹き飛んだ…ニューヨーク大教授が明かした懸念",
  "女性支持減「期待感が失望に」 申お茶の水大教授―高市政権１年",
  "【独自】上履きの中敷き窃盗事件 被害中学校「窓は施錠していた」",
  "中国で小中学校の秋休み拡大 保護者の休暇確保が課題に",
  "流出した個人情報、ダークウェブで高額取引 情報提供まで被害知らず",
  "ゼレンスキー氏、アメリカの情報提供は「機能している」 トランプ氏の特使と会談後",
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
  assert.deepEqual(groupOf(gs, 22), [22, 23], "武部農相の献金問題");
});

test("同じ種類の別の出来事 (個人情報流出・首脳会談・同じ県) はまとめない", () => {
  const gs = groups();
  for (const i of [16, 17, 18, 19, 20, 21]) assert.deepEqual(groupOf(gs, i), [i], TITLES[i]);
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

test("熟語が1つ重なるだけの別の出来事 (拘禁刑・個性豊か・大教授・中学校・情報提供) はまとめない", () => {
  const gs = groups();
  for (let i = 24; i < TITLES.length; i++) assert.deepEqual(groupOf(gs, i), [i], TITLES[i]);
});

test("数珠つなぎで大きな塊にならない", () => {
  assert.ok(groups().every((g) => g.length <= 4));
});
