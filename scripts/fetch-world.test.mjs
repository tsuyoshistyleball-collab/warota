// 世界ニュースの見出しの整理のテスト。実行: node --test scripts/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitOutlet } from "./fetch-world.mjs";

test("Yahoo!ニュースの見出しの最後のかっこから媒体名を分ける (かっこが入れ子でも)", () => {
  const yahoo = { outletFrom: "paren", name: "Yahoo 国際" };
  assert.deepEqual(splitOutlet(yahoo, "UAE前大使が立候補 難航の国連事務総長選（共同通信）"), { title: "UAE前大使が立候補 難航の国連事務総長選", outlet: "共同通信" });
  assert.deepEqual(splitOutlet(yahoo, "パリで学生らがデモ 警察「行進」認めず(テレビ朝日系（ANN）)"), { title: "パリで学生らがデモ 警察「行進」認めず", outlet: "テレビ朝日" });
  assert.deepEqual(splitOutlet({ outletFrom: "dash", name: "Google 国際" }, "フィンランドで処分場の操業許可 - 読売新聞オンライン"), { title: "フィンランドで処分場の操業許可", outlet: "読売新聞" });
});
