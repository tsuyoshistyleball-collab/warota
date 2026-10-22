// 地域判定のテスト。実行: node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./world-regions.mjs";

const regionsOf = (title, kind = "world") => classify({ title }, kind).map((r) => r.region).join(",");

test("国名・地名から地域を判定する", () => {
  const cases = [
    ["アメリカ メタ大幅増益 AIなど巨額の設備投資続ける見通し", "namerica"],
    ["北朝鮮キム・ヨジョン氏「今月中に心理戦拡声機が稼働状態」", "asia"],
    ["ロシア、日本を非難 記者をスパイ活動に利用と主張", "europe"],
    ["マクロン氏、仏暴動を自らの選挙運動に利用する外国首脳を非難", "europe"],
    ["中南米を歴訪中の外相 ブラジル入り", "latam"],
    ["パプアニューギニアで地震", "oceania"],
    ["赤道ギニアで政変", "africa"],
    ["南アフリカ 大統領が来日", "africa"],
    ["大谷翔平 ドジャースで今季50号", "namerica"],
    ["イチローさん マリナーズOBのホームラン競争でファンわかせる", "namerica"],
  ];
  for (const [title, want] of cases) assert.equal(regionsOf(title), want, title);
});

test("2つの地域にまたがる話題は両方に入れる", () => {
  assert.equal(regionsOf("米中首脳会談 関税で合意"), "namerica,asia");
  assert.equal(regionsOf("米中間選挙 共和党が優勢"), "namerica");
  assert.equal(regionsOf("米大統領 ウに露との和平合意促す"), "namerica,europe");
  assert.equal(regionsOf("ゼレンスキー氏、アメリカの情報提供は「機能している」 トランプ氏の特使と会談後"), "namerica,europe");
  assert.equal(regionsOf("英フェアフォード空軍基地事件、2人を再逮捕 イラン情報機関に協力した容疑"), "europe,mideast");
});

test("国名略称のすぐ後に社名が続く形を拾う", () => {
  assert.equal(regionsOf("米グーグル 新しいAIを発表"), "namerica");
  assert.equal(regionsOf("独フォルクスワーゲン 工場閉鎖へ"), "europe");
  assert.equal(regionsOf("韓サムスン 増益"), "asia");
});

test("紛らわしい語を外国として扱わない", () => {
  const cases = [
    "独自の調査で判明 豪雨の被害",
    "新米の価格が上昇 米どころで収穫",
    "中国地方で大雨 中国電力が停電情報",
    "日中は気温が上がる見込み",
    "英語教育の見直し 台風13号接近",
    "タイトル争い スタイル抜群 タイガース",
    "米ぬかを使った新商品",
    "海外に滞在中の邦人 毎日朝の点呼",
    "連日豪雨で川が増水",
    "日比谷公園でイベント",
  ];
  for (const title of cases) assert.equal(regionsOf(title, "mixed"), "japan", title);
});

test("フィードの種類による振り分け", () => {
  assert.equal(regionsOf("秋田 子吉川 氾濫特別警報は注意報に", "japan"), "japan");
  assert.equal(regionsOf("米大統領が声明", "japan"), "japan");
  // 海外ニュースのフィードで地域が分からないものは使わない
  assert.equal(regionsOf("国連が食料危機を警告", "world"), "");
  assert.equal(regionsOf("日本の首相が演説", "world"), "japan");
});

test("国籍だけが出てくる国内の記事は日本に入れる", () => {
  assert.equal(regionsOf("外国籍の男女３人を覚せい剤所持などの疑いで逮捕 愛知・豊川市の病院でイラン人男性が死亡し", "mixed"), "japan");
  assert.equal(regionsOf("ベトナム人技能実習生を不当に解雇か 福岡の会社を捜索", "mixed"), "japan");
  assert.equal(regionsOf("中国人観光客 京都の紅葉スポットに行列", "mixed"), "japan");
  // 国そのものの話題は今まで通り外国に入れる
  assert.equal(regionsOf("中国共産党批判の台湾コメディアン襲撃、5人起訴 中国人が犯行依頼か"), "asia");
  assert.equal(regionsOf("ロシアで拘束の北海道新聞記者 早期解放を求める", "mixed"), "europe");
  assert.equal(regionsOf("中国人権派弁護士を拘束"), "asia");
  assert.equal(regionsOf("イスラエル人質の家族が抗議"), "mideast");
});
