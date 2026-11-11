import test from "node:test";
import assert from "node:assert/strict";
import { cleanTitle, parseSearch, merge, searchUrl } from "./fetch-reuse.mjs";

test("見出しの最後の媒体名と、全体を囲むかぎかっこを外す", () => {
  assert.equal(cleanTitle("メルカリ、越境取引の安全強化 - リユース経済新聞", "リユース経済新聞"), "メルカリ、越境取引の安全強化");
  assert.equal(cleanTitle("「小江戸ホビー本店、常連育む」 - リユース経済新聞", "リユース経済新聞"), "小江戸ホビー本店、常連育む");
  assert.equal(cleanTitle("A - B の話", "C"), "A - B の話");
});

test("検索結果の RSS から見出し・リンク・媒体・時刻を読む", () => {
  const xml = `<rss><channel><item><title>古着の回収 &amp; リユース - 北羽新報社</title><link>https://news.google.com/rss/articles/x?oc=5</link><pubDate>Tue, 10 Nov 2026 01:30:00 GMT</pubDate><source url="https://example.jp">北羽新報社</source></item><item><title>リンクなし</title></item></channel></rss>`;
  assert.deepEqual(parseSearch(xml), [{ t: "古着の回収 & リユース", u: "https://news.google.com/rss/articles/x?oc=5", s: "北羽新報社", ts: Date.UTC(2026, 10, 10, 1, 30) }]);
});

test("同じ見出しは1つにまとめ、元の媒体を残して、優先する分類を付ける", () => {
  const now = Date.UTC(2026, 10, 11);
  const h = 3600_000;
  const items = merge(
    [
      { cat: "paper", items: [{ t: "メルカリ、越境取引の安全強化", u: "https://a/1", s: "リユース経済新聞", ts: now - 5 * h }] },
      {
        cat: "industry",
        items: [
          { t: "リユースフェス2027 開催", u: "https://a/2", s: "ニコニコニュース", ts: now - 3 * h },
          { t: "「リユースフェス2027」開催", u: "https://a/3", s: "PR TIMES", ts: now - 2 * h },
          { t: "メルカリ、越境取引の安全強化", u: "https://a/4", s: "リユース経済新聞", ts: now - 5 * h },
          { t: "古い記事", u: "https://a/5", s: "X", ts: now - 8 * 24 * h },
        ],
      },
    ],
    now,
  );
  assert.deepEqual(items.map((i) => [i.t, i.s, i.c, i.n]), [
    ["「リユースフェス2027」開催", "PR TIMES", "industry", 2],
    ["メルカリ、越境取引の安全強化", "リユース経済新聞", "paper", 1],
  ]);
});

test("検索の URL は直近7日に絞る", () => {
  assert.equal(searchUrl("リユース"), "https://news.google.com/rss/search?q=%E3%83%AA%E3%83%A6%E3%83%BC%E3%82%B9%20when%3A7d&hl=ja&gl=JP&ceid=JP:ja");
});
