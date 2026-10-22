// まとめ記事の本文抽出のテスト。各ブログの点検で見つかった書き方を、小さなHTMLで再現している。
// linkedom と @mozilla/readability が必要 (ワークフローでだけ入れるので、入っていなければ飛ばす)
import { test } from "node:test";
import assert from "node:assert/strict";

let extract = null;
try {
  ({ extract } = await import("./build-articles.mjs"));
} catch {}
const skip = !extract && "linkedom / @mozilla/readability が入っていない";

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;
const posts = (n, from = 1, body = "本文です。これはテストのためのレスの本文です。") =>
  Array.from({ length: n }, (_, i) =>
    `<div class="t_h">${from + i}: 名無しさん 2026/10/22(木) 15:${String(i).padStart(2, "0")}:00.00 ID:abc${i}</div><div class="t_b">${body}${i}</div>`,
  ).join("");
const textOf = (html) => html.replace(/<[^>]*>/g, "");
const run = async (body, title = "テストの記事のタイトルです", url = "https://example.com/archives/1.html") =>
  (await extract(page(body), url, title))?.html ?? "";

test("不思議.net: コメント数・カテゴリ・日付・タイトル枠を本文から除く", { skip }, async () => {
  const html = await run(
    `<div class="main_content_bgColor"><div class="article_box_upper">
      <div class="come_cat clearfix"><a href="https://example.com/archives/1.html#comments" class="come_Number_kiji">0</a><ul><li><a href="https://example.com/archives/cat_1.html">芸能</a></li><li></li></ul><p>2026年10月22日：16:05</p></div>
      <section class="article_title_box1"><h1><a href="https://example.com/archives/1.html">【悲報】小倉優子さん、庶民派アピールに失敗し大炎上</a></h1></section>
      <div class="kiji_box">${posts(6)}</div></div><div class="more_body">${posts(4, 7)}</div></div>`,
    "【悲報】小倉優子さん、庶民派アピールに失敗し大炎上",
  );
  const text = textOf(html);
  assert.ok(!text.includes("芸能") && !text.includes("2026年10月22日") && !text.includes("小倉優子"), text.slice(0, 120));
  assert.ok(!/<li>\s*<\/li>/.test(html) && !/>0</.test(html));
  assert.equal((html.match(/class="ph/g) ?? []).length, 10);
});

test("VIPPERな俺: 地の文で書かれたレスの見出しを囲み、最後の記事リンクの並びを除く", { skip }, async () => {
  const head = (n) => `${n} 名前：<b><span style="color:green">名無しさん＠おーぷん</span></b>[] 投稿日：26/10/22(木) 14:55:${n}0 ID:iQp${n}<br>`;
  const promo = Array.from({ length: 5 }, (_, i) => `<a href="http://blog.livedoor.jp/news23vip/archives/45${i}.html">他の記事のタイトルその${i}です</a><br>`).join("");
  const html = await run(
    `<div class="article-body-inner">${[1, 2, 3, 4, 5, 6].map((n) => `${head(n)}<span>レスの本文${n}です。</span><br><br>`).join("")}
      <div class="article-body-more">${promo}</div></div>`,
    "ルフィとゾロのスレ",
    "https://news23vip.livedoor.blog/archives/6264510.html",
  );
  assert.equal((html.match(/<span class="ph">/g) ?? []).length, 6);
  assert.ok(!html.includes("他の記事のタイトル"));
});

test("まとめたニュース: タイトル・投稿日の行・おすすめリンク・アマゾン・コメント欄を除く", { skip }, async () => {
  const promo = Array.from({ length: 4 }, (_, i) => `<a href="https://newmofu.doorblog.jp/archives/${i}.html?url=lmth">別のまとめの記事タイトルその${i}</a><br><br>`).join("");
  const html = await run(
    `<div class="blogbody"><div class="titlebody"><h2 class="title">イーロン・マスク氏「未だにオールドメディアを信じ込む奴は馬鹿者だ」</h2></div>
      <div class="posted"><a href="http://matometanews.com/archives/cat_1.html">マスコミ</a>│<a href="http://matometanews.com/archives/cat_2.html">アメリカ</a>│17:39│<a href="http://matometanews.com/archives/2122296.html#comments">コメント(4)</a></div>
      <div class="main">${posts(3)}</div><div class="mainmore"><b><span>${promo}</span></b>${posts(5, 4)}
      <div><span>気になるAmazonの本</span><a href="https://www.amazon.co.jp/dp/123?tag=x-22"><img src="https://m.media-amazon.com/a.jpg"></a></div></div>
      <div class="posted"><a href="http://matometanews.com/archives/cat_1.html">マスコミ</a>│17:39</div>
      <div class="commentlink"><a href="#comment-form">コメントする</a> <a href="#comments">コメントを見る(4)</a></div></div>`,
    "イーロン・マスク氏「未だにオールドメディアを信じ込む奴は馬鹿者だ」",
    "http://matometanews.com/archives/2122296.html",
  );
  const text = textOf(html);
  for (const junk of ["イーロン・マスク氏", "マスコミ", "別のまとめの記事", "Amazon", "コメント"]) assert.ok(!text.includes(junk), junk);
  assert.equal((text.match(/ID:abc/g) ?? []).length, 8);
});

test("ライフハック: 「コメントする」から後ろのコメント欄を除き、<font> の名前は改行しない", { skip }, async () => {
  const html = await run(
    `<div class="blogbody"><div class="main">${Array.from({ length: 5 }, (_, i) =>
      `<span class="t_name">${i + 1} ：<font color="green">ぼうや(茸)[ﾆﾀﾞ]</font> 2026/10/22(木) 15:0${i}:00 ID:x${i}</span><blockquote>これはレスの本文です。長めに書いておきます。これはレスの本文です。${i}</blockquote>`,
    ).join("")}</div>
      <div><a href="#comment_p">コメントする</a></div><p>コメント1げっとおおおおお</p><p>誹謗中傷な投稿内容には訴訟リスクが発生します。</p><h3>みんなが見てる</h3></div>`,
  );
  assert.ok(!html.includes("げっと") && !html.includes("みんなが見てる") && !html.includes("訴訟"));
  assert.ok(html.includes('<span style="color:green">ぼうや'), "font は span に");
  assert.ok(!html.includes("<div>ぼうや"));
});

test("FC2: 本文と続きを取り、レスの日付があるコメント欄は使わない", { skip }, async () => {
  const comments = Array.from({ length: 8 }, (_, i) => `<div>名前：名無しビジネス #- | 2026/10/22(木) 1${i}:00 <p>コメント${i}</p></div>`).join("");
  const html = await run(
    `<div id="mainBlock"><div class="mainEntryBody"><p>導入の文章です。</p></div><div class="mainEntryMore"><dl class="thread">${Array.from({ length: 6 }, (_, i) =>
      `<dt>${i + 3} ：<span><b>それでも動く名無し</b></span>：2026/10/21(水) 10:4${i}:45.32 ID:I8Mz${i}</dt><dd>レスの本文${i}です。</dd>`,
    ).join("")}</dl></div><div class="mainCommentBody">${comments}</div></div>`,
    "左派漫画家のスレ",
    "http://workingnews117.com/blog-entry-22512.html",
  );
  assert.ok(html.includes("導入の文章") && html.includes("レスの本文5"));
  assert.ok(!html.includes("名無しビジネス"));
  assert.equal((html.match(/<dt class="ph">/g) ?? []).length, 6);
});

test("知らないテンプレート: レスが集まっている入れ物を本文にする (前半と続きの両方)", { skip }, async () => {
  const dl = (from, n) => `<dl>${Array.from({ length: n }, (_, i) =>
    `<dt><span>${from + i}</span><span> ：それでも動く名無し ：2026/10/22(木) 16:3${i % 10}:15.44 ID:oOr${from + i}</span></dt><dd><span>本文${from + i}です</span></dd>`,
  ).join("")}</dl>`;
  const html = await run(
    `<div id="main-column"><div class="article-wrap"><div class="first"><p><img src="https://example.com/top.png"></p>${dl(1, 3)}</div><div class="rest">${dl(4, 40)}</div></div>
      <div id="comments-list"><p>コメント一覧 (31)</p><p>1. 金ぴか名無しさん 2026年10月22日 18:00</p></div>
      <div class="side">${Array.from({ length: 20 }, (_, i) => `<li><a href="https://example.com/archives/${i}.html">人気の記事${i}</a></li>`).join("")}</div></div>`,
    "INMU KING、Youtubeから削除される",
    "https://goldennews.blog.jp/archives/52309427.html",
  );
  assert.ok(html.includes("top.png") && html.includes("本文1です") && html.includes("本文43です"));
  assert.ok(!html.includes("金ぴか") && !html.includes("人気の記事"));
});

test("body に本文用の id があっても、ページ全体を本文にしない", { skip }, async () => {
  const html = await extract(
    `<!doctype html><html><body id="article_body"><div id="sidebar">${"サイドバーの文章です。".repeat(80)}</div>
      <div class="entry"><h2>見出し</h2><div class="entrybody"><p>${"本文の文章です。".repeat(30)}</p></div></div></body></html>`,
    "https://rabitsokuhou.2chblog.jp/archives/1.html",
    "見出し",
  );
  assert.ok(html && !html.html.includes("サイドバー") && html.html.includes("本文の文章"));
});

test("レスのない記事は、上のほうの「コメント(0)」で本文を消さない", { skip }, async () => {
  const html = await run(
    `<div class="blogbody"><div class="titlebody"><h2>アニメの感想 <a href="#comments">コメント(0)</a></h2></div>
      <div class="mainmore"><p>${"ツイッターの反応を紹介します。".repeat(20)}</p><p>${"とても面白い回でした。".repeat(20)}</p></div></div>`,
    "アニメの感想",
  );
  assert.ok(textOf(html).includes("とても面白い回でした"));
  assert.ok(!textOf(html).includes("コメント(0)"));
});

test("YouTube の埋め込み・遅延読み込みの画像・計測用の画像", { skip }, async () => {
  const html = await run(
    `<div class="article-body-inner"><p>${"本文の文章です。".repeat(20)}</p>
      <iframe src="https://www.youtube.com/embed/abcdefghijk?rel=0"></iframe>
      <img src="data:image/gif;base64,R0lGOD" data-lazy-src="https://example.com/real.jpg">
      <img src="https://example.com/pixel.gif" width="1" height="1"></div>`,
  );
  assert.ok(html.includes('href="https://www.youtube.com/watch?v=abcdefghijk"') && html.includes("i.ytimg.com/vi/abcdefghijk/"));
  assert.ok(html.includes('src="https://example.com/real.jpg"'));
  assert.ok(!html.includes("pixel.gif"));
});

test("レスの本文の中の「>>12」や外部リンク・短い返事は残す", { skip }, async () => {
  const html = await run(
    `<div class="article-body-inner">${posts(5)}<div class="t_h">6: 名無しさん 2026/10/22(木) 16:00:00.00 ID:zz</div>
      <div class="t_b"><a href="https://example.com/archives/1.html#res2">&gt;&gt;2</a> <a href="https://example.com/archives/1.html#res3">&gt;&gt;3</a> <a href="https://example.com/archives/1.html#res4">&gt;&gt;4</a> そうだね</div>
      <div class="t_h">7: 名無しさん 2026/10/22(木) 16:01:00.00 ID:zy</div><div class="t_b">おすすめ</div>
      <div class="t_h">8: 名無しさん 2026/10/22(木) 16:02:00.00 ID:zx</div><div class="t_b">ソース https://news.yahoo.co.jp/articles/abc</div></div>`,
  );
  const text = textOf(html);
  assert.ok(text.includes("そうだね") && text.includes("&gt;&gt;4") && text.includes("ソース"));
  assert.ok(text.includes("おすすめ"), "「おすすめ」だけの返事も残す");
});

test("なんJスタジアム: 「1000：」のレスに見せかけたアンテナサイトのリンク集を除く", { skip }, async () => {
  const fake = `<blockquote><div>1000 ：<span style="color:green">なんじぇいスタジアム</span><span> 2014/11/30(日) 00:00:00</span><span><b><br><br>${
    ["matomeantena.com/feed/1", "nullpoantenna.com/feed/2", "matomeantena.com/feed/3"].map((h, i) =>
      `<span class="text"><a href="https://${h}">他のまとめサイトの記事のタイトル${i}</a></span><br><br>`).join("")
  }</b></span><div><b><a href="https://yakiu-antenna.net/tigers/1.html">阪神の話題の記事のタイトルです</a></b></div><b><br><a href="https://moudamepo.com/pick.cgi?code=1">来季の三冠王候補の記事のタイトル</a></b></div></blockquote><br>`;
  const html = await run(`<div class="article-body-inner">${posts(3)}<div class="article-body-more">${fake}${posts(4, 4)}</div></div>`);
  const text = textOf(html);
  assert.ok(!text.includes("なんじぇいスタジアム") && !text.includes("他のまとめサイト") && !text.includes("三冠王"), text.slice(0, 200));
  assert.equal((text.match(/ID:abc/g) ?? []).length, 7);
});

test("キニ速・暇人速報: 「★今週のおすすめ」や「◆」付きで並んだ他サイトの記事へのリンクを除く", { skip }, async () => {
  const kini = `<blockquote><span><b><span style="color:red">★今週のおすすめ<br>${[1, 2, 3, 4, 5].map((i) =>
    `<a href="//2ch-c.net/?gt=2026072111260${i}&eid=1113207${i}">【画像】よそのまとめの記事のタイトル${i}</a><br><br>`).join("")}</span></b></span></blockquote>`;
  const hima = `【おすすめ記事】<br>${[1, 2, 3, 4].map((i) => ` ◆<a href="http://himasoku.com/archives/5229040${i}.html">【悲報】ブログの他の記事のタイトル${i}</a><br>`).join("")}<br>`;
  const html = await run(
    `<div class="article-body-inner">${posts(3)}${kini}<div class="article-body-more">${hima}${posts(4, 4)}</div></div>`,
    "テストの記事のタイトルです",
    "http://himasoku.com/archives/52290409.html",
  );
  const text = textOf(html);
  assert.ok(!text.includes("今週のおすすめ") && !text.includes("よそのまとめ") && !text.includes("ブログの他の記事") && !text.includes("おすすめ記事"), text.slice(0, 300));
  assert.equal((text.match(/ID:abc/g) ?? []).length, 7);
});

test("エレファント速報: レスの集まりの前後にある投稿日・はてブ・人気記事のタブ・カテゴリの切り替えを除く", { skip }, async () => {
  const dl = Array.from({ length: 8 }, (_, i) =>
    `<dt>${i + 1}:<span style="color:#008000">それでも動く名無し</span> 2026/03/18(水) 19:09:1${i}.09 ID:lKH${i}</dt><dd><br><span>レスの本文${i}です</span></dd><br><br><br>`).join("");
  const html = await run(
    `<div id="main"><div class="article"><h2>【悲報】味噌ラーメンで行列、出来ない</h2>
      <ul class="info clearfix"><li class="iTime">2026年03月20日 11:20</li><li class="iCategory"><a href="https://elephant.2chblog.jp/archives/cat_1.html">トピック</a>、<a href="https://elephant.2chblog.jp/archives/cat_2.html">グルメ</a></li>
      <li class="iComment"><a href="https://elephant.2chblog.jp/archives/52378432.html#comments">276 コメント</a></li>
      <li class="iHtb"><a href="http://b.hatena.ne.jp/entry/https://elephant.2chblog.jp/archives/52378432.html"><img src="http://b.st-hatena.com/images/entry-button/button-only.gif"></a></li>
      <li class="iTwt"><a href="http://twitter.com/share">Tweet</a></li></ul>${dl}
      <div>元スレ 【悲報】味噌ラーメンで行列、出来ない https://nova.5ch.io/test/read.cgi/livegalileo/1773828551/</div>
      <div style="margin:10px"><div><a href="https://b.hatena.ne.jp/entry/https://elephant.2chblog.jp/archives/52378432.html"><img src="https://b.st-hatena.com/images/entry-button/button-only.gif"></a></div></div><br>
      <div class="tab_area"><p><a href="http://b.hatena.ne.jp/entry/add/https://elephant.2chblog.jp/archives/52378432.html">記事をはてブする</a></p></div>
      <ul><li>「すべて」</li><li>「不思議」</li><li>「デレマス」</li><li>「ガルパン」</li><li>「艦これ」</li></ul></div>
      <div id="side">${Array.from({ length: 10 }, (_, i) => `<p>サイドバーの文章${i}</p>`).join("")}</div></div>`,
    "【悲報】味噌ラーメンで行列、出来ない",
    "https://elephant.2chblog.jp/archives/52378432.html",
  );
  const text = textOf(html);
  for (const junk of ["2026年03月20日", "トピック", "コメント", "Tweet", "はてブ", "「すべて」", "サイドバー"]) assert.ok(!text.includes(junk), junk);
  assert.ok(!html.includes("hatena") && !html.includes("<ul") && text.includes("レスの本文7") && text.includes("元スレ"));
});

test("カラパイア: 本文の途中にある共有ボタンの「コメントを見る」で、後ろの本文を消さない", { skip }, async () => {
  const html = await run(
    `<div class="entry-content"><figure><a href="https://karapaia.com/archives/1.html/01"><img src="https://karapaia.com/a.jpg"><span class="wp-block-image__a11y-label">この画像を大きなサイズで見る</span></a><figcaption>Image credit:x</figcaption></figure>
      <p>${"前半の本文です。".repeat(30)}</p>
      <dl class="share-btns"><dt>記事をシェア</dt><dd><a href="#">みんなのポスト</a></dd><dd><a href="#comments">コメント</a><a href="#respond">コメントを書く</a><a href="#comments">コメントを見る</a></dd></dl>
      <h2>見出し</h2><p>${"後半の本文です。".repeat(30)}</p></div>`,
  );
  const text = textOf(html);
  assert.ok(text.includes("後半の本文です") && text.includes("見出し"), "後半が残る");
  assert.ok(!text.includes("この画像を大きなサイズで見る") && !text.includes("記事をシェア") && !text.includes("コメント"));
});

test("仕上げ: 空になった表・区切り文字だけの行・続きすぎる改行を整え、文中の改行は残す", { skip }, async () => {
  const html = await run(
    `<div class="article-body-inner"><br><br>${posts(5)}<br><br><br><br>
      <div class="akares"><table><tr><td> </td><td><script>ad()</script></td></tr></table></div>
      <div class="article-title-date"><table><tr><td><a href="http://b.hatena.ne.jp/entry/x"><img src="http://b.hatena.ne.jp/entry/image/x"></a></td><td>│</td><td>│</td></tr></table></div>
      <p>${"一行目の文章です。".repeat(10)}<br><br><br><br><br>二行目<b>太字<br></b>続きの文章<hr><hr><br><hr></p><hr><br></div>`,
  );
  assert.ok(!html.includes("<table") && !html.includes("│") && !html.includes("hatena"), html.slice(-400));
  assert.ok(!/(<br>\s*){3}/.test(html), "改行は2つまで");
  assert.ok(html.includes("太字<br></b>続き"), "文中の飾りの中の改行は残す");
  assert.ok(!/^<div class="article-body-inner">\s*<br>/.test(html) && !/<hr>\s*<\/div>$/.test(html), "最初と最後の改行・区切り線は消す");
  assert.ok(!/(<hr>\s*){2}/.test(html), "区切り線は1本に");
});

test("はちま起稿・パンドラの憂鬱: 前後の記事への案内・関連記事の一覧・応援のお願いを除く", { skip }, async () => {
  const nav = `<ul class="article-nav"><li class="article-nav-list"><a href="http://blog.esuteru.com/archives/2.html">次の記事のタイトルです</a></li></ul>`;
  const relate = `<dl class="relate_dl"><dt>関連記事</dt><dd><ul class="relate_ul">${[1, 2, 3].map((i) => `<li class="relate_li"><a href="https://pandora11.com/blog-entry-${i}.html">海外「関連記事のタイトル${i}」</a></li>`).join("")}</ul></dd></dl>`;
  const hachima = textOf(await run(`<div class="article-main"><div class="article-body-more" id="more"><p>${"本文の文章です。".repeat(30)}</p></div>${nav}${nav}</div>`));
  assert.ok(hachima.includes("本文の文章です") && !hachima.includes("次の記事"), hachima.slice(-100));
  const pandora = textOf(await run(`<div class="ently_text">${"海外の反応の本文です。<br>".repeat(30)}${relate}<br>↑皆様の応援が、皆様が考えている以上に励みになります。<br><br></div>`));
  assert.ok(pandora.includes("海外の反応の本文です") && !pandora.includes("関連記事のタイトル") && !pandora.includes("皆様の応援"), pandora.slice(-100));
});

test("TikTok・Instagram の埋め込みは元のサイトで見るリンクに、imgur は画像だけに", { skip }, async () => {
  const html = await run(
    `<div class="article-body-inner"><p>${"本文の文章です。".repeat(20)}</p>
      <blockquote class="tiktok-embed" cite="https://www.tiktok.com/@bbcnews/video/7698491756651875606" data-video-id="7698491756651875606"><section><a href="https://www.tiktok.com/@bbcnews">@bbcnews</a> 説明文 <a href="https://www.tiktok.com/music/x">♬ original sound</a></section></blockquote>
      <blockquote class="instagram-media" data-instgrm-permalink="https://www.instagram.com/p/AbC123/"><a href="https://www.instagram.com/p/AbC123/">View this post on Instagram</a></blockquote>
      <blockquote class="imgur-embed-pub" data-id="a1b2c3"><a href="https://imgur.com/a1b2c3">View post on imgur.com</a></blockquote></div>`,
  );
  assert.ok(html.includes('href="https://www.tiktok.com/@bbcnews/video/7698491756651875606"') && html.includes("TikTokで見る"));
  assert.ok(html.includes('href="https://www.instagram.com/p/AbC123/"') && html.includes("Instagramで見る"));
  assert.ok(!html.includes("original sound") && !html.includes("View this post") && !html.includes("View post on imgur"));
  assert.ok(html.includes('src="https://i.imgur.com/a1b2c3.jpg"') && !html.includes("imgur-embed-pub"));
});

test("流速VIP: 見出しのないレスが並ぶ .entry-main を本文にする", { skip }, async () => {
  const res = Array.from({ length: 20 }, (_, i) => `<div class="res me2 nest${i % 3}"><p>${i ? `<span class="anchor">&gt;&gt;${i}</span><br>` : ""}レスの本文その${i}です。少し長めに書いておきます。</p></div>`).join("");
  const html = await run(
    `<main id="primary"><article id="content"><h1>タイトル</h1><div class="entry-main">${res}<p><span class="topic">引用元</span><span>無題</span></p></div></article>
      <div class="primary-widget">厳選おすすめまとめ！ ${Array.from({ length: 8 }, (_, i) => `<a href="https://example.com/archives/${i}.html">他の記事${i}</a>`).join("")}</div></main>`,
  );
  const text = textOf(html);
  assert.ok(text.includes("レスの本文その0") && text.includes("レスの本文その19") && text.includes("引用元"));
  assert.ok(!text.includes("厳選おすすめ") && html.includes('class="res me2 nest1"'));
});

test("おーるじゃんる: 本文の中の「今読まれている注目ニュース」・最後のリンク集・応援登録のお願いを除く", { skip }, async () => {
  const card = `<div class="f1link-card"><div class="f1link-label"><span>🔥 今読まれている注目ニュース</span></div><ul class="linklist f1link-list">${[
    "https://moudamepo.com/pick.cgi?code=2763&cate=10",
    "https://newmofu.doorblog.jp/archives/60113341.html?url=x",
    "https://newmofu.doorblog.jp/archives/60113291.html?url=y",
  ].map((h, i) => `<li><a href="${h}"><b>注目ニュースの記事のタイトルその${i}</b></a></li>`).join("")}</ul></div>`;
  const list = `<div><ul>${Array.from({ length: 12 }, (_, i) => `<li><a href="https://newpuru.doorblog.jp/archives/6356209${i}.html?id=1">【悲報】よそのまとめブログの長い記事のタイトルその${i}です</a></li>`).join("")}<li><a href="https://crx7601.com/">トップページに戻る</a></li></ul></div>`;
  const html = await run(
    `<div class="article-body-inner"><div class="t_h">1: マックライオン(東京都) [IT] 2026/10/22(木) 13:21:25.82 ID:nkr3</div><div class="t_b">最初のレスの本文です。${card}</div>${posts(6, 2)}${list}
      <p>引用元: <a href="https://hayabusa9.5ch.io/news/1792642885">元のスレのタイトル</a></p>
      <figure><div>【応援登録のお願い】</div><a href="https://google.com/preferences/source?q=crx7601.com"><img src="https://parts.blog.livedoor.jp/img/cmn/google-ps/dark.png"></a><div>Google検索で「おーるじゃんる」を登録できます。<br>いつも読んでくださる方は、よろしければ応援登録をお願いします。</div></figure></div>`,
    "テストの記事のタイトルです",
    "https://crx7601.com/archives/63562393.html",
  );
  const text = textOf(html);
  for (const junk of ["注目ニュース", "よそのまとめブログ", "トップページ", "応援登録", "Google検索"]) assert.ok(!text.includes(junk), junk);
  assert.ok(text.includes("最初のレスの本文") && text.includes("元のスレのタイトル") && (text.match(/ID:abc/g) ?? []).length === 6);
});

test("レスの本文の中のアマゾンのリンクは、リンクだけを消して本文の文字は残す", { skip }, async () => {
  const html = await run(
    `<div class="article-body-inner">${posts(5)}<div class="t_h">6: 名無しさん 2026/10/22(木) 16:00:00.00 ID:zz</div>
      <div class="t_b"><span>これ買ったけど良かったわ <a href="https://www.amazon.co.jp/dp/B000">https://www.amazon.co.jp/dp/B000</a></span></div>
      <div><a href="https://www.amazon.co.jp/dp/B001?tag=x-22"><img src="https://m.media-amazon.com/b.jpg"></a><span>おすすめの商品</span></div>
      <p>元スレ：<a href="https://nova.5ch.io/test/read.cgi/x/1/">元のスレ</a></p><div><span>元スレ： </span></div></div>`,
  );
  const text = textOf(html);
  assert.ok(text.includes("これ買ったけど良かったわ") && !html.includes("amazon"), html.slice(-500));
  assert.ok(!text.includes("おすすめの商品"));
  assert.equal((text.match(/元スレ/g) ?? []).length, 1, "リンクの前の「元スレ：」だけ残す");
});

test("ハムスター速報・パンドラの憂鬱: アマゾンの短縮URL (link.amazon) の紹介と商品名の行を除く", { skip }, async () => {
  const html = await run(
    `<div class="article-body-inner">${posts(6)}
      <span style="color:#3300FF"><span style="font-size:150%"><b>Amazon期間限定無料マンガ一覧ページ<br><a href="https://link.amazon/B0fpt5w0T">https://link.amazon/B0fpt5w0T</a></b></span></span><br><br>
      <span style="color:#3300FF"><span style="font-size:150%"><b>To LOVEる―とらぶる― 短編集</b></span></span><br>
      <span style="font-size:150%"><b><a href="https://link.amazon/B00VbCyrP">https://link.amazon/B00VbCyrP</a><br></b></span><br><br>
      <b><a href="https://link.amazon/B00VbCyrP"><img src="https://m.media-amazon.com/images/I/71tir6TmIZL._SL500_.jpg"></a></b>
      <strong>・<a href="https://link.amazon/B07L9gE0P">なぜフランス人の僕が、日本を“天国“と呼ぶのか</a><br>・<a href="https://link.amazon/B08EGe4e0">フランス夫の愛がエグい</a></strong></div>`,
  );
  const text = textOf(html);
  for (const junk of ["Amazon", "To LOVEる", "フランス", "link.amazon"]) assert.ok(!html.includes(junk), junk);
  assert.equal((text.match(/ID:abc/g) ?? []).length, 6);
});

test("ガハろぐ・ぶる速: 「関連記事」の後の1本のリンクと、レスの本文の中の「おすすめ：」の宣伝を除く (画像は残す)", { skip }, async () => {
  const html = await run(
    `<div class="article-body-inner">${posts(2)}
      <div class="t_h">3: 名無し 2026/10/21(水) 21:44:06.97 ID:4YkKX</div><div class="t_b"><div><a href="https://livedoor.blogimg.jp/a/imgs/1/2/x.jpg"><img src="https://livedoor.blogimg.jp/a/imgs/1/2/x-s.jpg"></a><br><br>
        <span style="color:blue"><u>おすすめ：<a href="https://al.fanza.co.jp/?lurl=https%3A%2F%2Fvideo.dmm.co.jp%2Fav">【特典映像収録版】新人のデビュー作品のタイトル</a></u></span></div></div>
      <b>関連記事</b><br><span style="font-size:small"><a href="https://example.com/archives/52603609.html"><div class="arrow4">ウマ娘のアメリカ公演、中止を発表</div></a></span><br><br>
      ${posts(3, 4)}</div>`,
  );
  const text = textOf(html);
  assert.ok(!text.includes("おすすめ") && !text.includes("特典映像") && !text.includes("関連記事") && !text.includes("ウマ娘"), text);
  assert.ok(html.includes("x.jpg"), "レスの画像は残す");
  assert.equal((text.match(/ID:abc/g) ?? []).length, 5);
});

test("流速VIP・ライフハック: 「:」のない見出しや、日付が本文の後ろにある見出しも、レスの見出しとして扱う", { skip }, async () => {
  const ryusoku = await run(
    `<div class="entry-main">${Array.from({ length: 6 }, (_, i) =>
      `<div class="res me2 nest0"><div class="header"><span class="num">${i + 1}</span><span class="name">名無しさん</span><span class="date">${i ? "10/22 14:4" + i : "<span>20</span>26/10/22(木) 14:41"}</span><span class="id">ID:EUYLLa2N${i}</span></div><div class="contents">レスの本文その${i}です。</div><br><br></div>`).join("")}</div>`,
  );
  assert.equal((ryusoku.match(/class="ph header"/g) ?? []).length, 6, ryusoku.slice(0, 400));
  assert.ok(ryusoku.includes('<span class="num">1</span> <span class="name">'), "番号と名前の間を空ける");
  const lifehack = await run(
    `<div class="blogbody"><div class="mainmore">${Array.from({ length: 5 }, (_, i) =>
      `<span class="t_name">${i + 2} ：<font color="green">レンザブロー(ジパング)[ﾆﾀﾞ]</font></span> <p class="r2">本文の文章です${i}</p><br><span style="font-size:0.7em;float:right">2026/10/22(木) 10:16:35.01 ID:xgkS54s7${i}</span>`).join("")}</div></div>`,
  );
  assert.equal((lifehack.match(/class="ph t_name"/g) ?? []).length, 5, lifehack.slice(0, 300));
});

test("エレファント速報: ページの中の切り替え (javascript:) だけの短い項目の並びも、最後のレスの後ろなら除く", { skip }, async () => {
  const html = await run(
    `<div class="article">${posts(6)}<div>元スレ <a href="https://nova.5ch.io/test/read.cgi/x/1/">https://nova.5ch.io/test/read.cgi/x/1/</a></div>
      <ul>${["すべて", "不思議", "デレマス", "ガルパン", "艦これ"].map((t) => `<li><a href="javascript:void(0)">「${t}」</a></li>`).join("")}</ul></div>`,
  );
  assert.ok(!textOf(html).includes("「すべて」") && textOf(html).includes("元スレ"));
});

test("なんJスタジアム: 1本ずつ <div> に入って並んだアンテナサイトのリンクも除く", { skip }, async () => {
  const list = [
    "https://matomeantena.com/feed/30000108204433",
    "https://nullpoantenna.com/feed/30000089669073",
    "https://nullpoantenna.com/feed/30000089672592",
    "https://moudamepo.com/pick.cgi?code=1165&date=1792373035",
  ].map((h, i) => `<div><span style="font-size:125%"><b><span class="text"><a href="${h}"><span style="color:#06c">アンテナの記事のタイトルその${i}です</span></a></span></b></span></div>`).join("");
  const html = await run(`<div class="article-body-inner">${posts(4)}<div class="article-body-more">${posts(3, 5)}${list}</div></div>`);
  assert.ok(!textOf(html).includes("アンテナの記事"), textOf(html).slice(-200));
  assert.equal((textOf(html).match(/ID:abc/g) ?? []).length, 7);
});

test("なんJスタジアム: リンクが何十本も続く長い「1000：」のレスも、見出しごと除く", { skip }, async () => {
  const a = (h, i) => `<span class="text"><a href="${h}"><span style="color:#06c">アンテナの長い記事のタイトルその${i}です</span></a></span><br><br>`;
  const links = Array.from({ length: 60 }, (_, i) => a(`https://${i % 2 ? "nullpoantenna" : "matomeantena"}.com/feed/3000010820${i}`, i)).join("");
  const fake = `<blockquote><div>1000 ：<span style="color:green">なんじぇいスタジアム</span><span> 2014/11/30(日) 00:00:00</span><span><b><br><br>${links}</b></span></div></blockquote>`;
  const html = await run(`<div class="article-body-inner">${posts(4)}<div class="article-body-more">${posts(3, 5)}${fake}</div></div>`);
  const text = textOf(html);
  assert.ok(!text.includes("なんじぇいスタジアム") && !text.includes("アンテナの長い記事"), text.slice(-200));
  assert.equal((text.match(/ID:abc/g) ?? []).length, 7);
});

test("本物のレスの後ろにリンク集が続く入れ物では、リンク集だけを除いてレスは残す", { skip }, async () => {
  const list = `<ul>${Array.from({ length: 5 }, (_, i) => `<li><a href="https://matomeantena.com/feed/1${i}">よそのまとめの記事のタイトルが長いものその${i}</a></li>`).join("")}</ul>`;
  const html = await run(`<div class="article-body-inner">${posts(6)}<div>${posts(1, 7, "本物の返事です。とても大事な中身。")}${list}</div></div>`);
  const text = textOf(html);
  assert.ok(text.includes("本物の返事です") && !text.includes("よそのまとめ"), text.slice(-200));
  assert.equal((text.match(/ID:abc/g) ?? []).length, 7);
});

test("おーるじゃんる: よそのサイトへのリンクが混ざった「あわせて読みたい」「こちらもおすすめ」の一覧を丸ごと除く", { skip }, async () => {
  const hrefs = [
    "https://moudamepo.com/pick.cgi?code=2169&cate=10", "https://newmofu.doorblog.jp/archives/60113472.html?url=a",
    "https://newpuru.doorblog.jp/archives/63562090.html?id=1", "https://matomeantena.com/feed/30000106019347",
    "https://yuukoku.net/gate.cgi?1004=1792624191", "https://byo-soku.com/?archive=9062414",
    "https://newser.cc/news/20261022?ni=6137624", "https://l-o-l.net/no/34455.html",
    "https://nullpoantenna.com/feed/30000088078210", "https://yuukoku.net/gate.cgi?1048=1792624104",
  ];
  const item = (h, i) => `<li><a href="${h}" target="_blank">よそのまとめの記事のタイトルその${i}です</a></li>`;
  const list = `<div class="aoj-b"><ul class="aoj-b-list"><li class="aoj-b-head">あわせて読みたい</li>${hrefs.slice(0, 4).map(item).join("")}<li class="aoj-b-head">注目ニュース</li>${hrefs.slice(4, 9).map((h, i) => item(h, i + 4)).join("")}<li class="aoj-b-head">こちらもおすすめ</li>${item(hrefs[9], 9)}</ul></div>`;
  const html = await run(
    `<div class="article-body-inner">${posts(6)}</div><div class="article-body-more">${posts(6, 7)}${list}<p>引用元: <a href="https://lavender.5ch.io/news4plus/1792639023">元のスレのタイトル</a></p></div>`,
    "テストの記事のタイトルです",
    "https://crx7601.com/archives/63562406.html",
  );
  const text = textOf(html);
  for (const junk of ["よそのまとめ", "あわせて読みたい", "注目ニュース", "こちらもおすすめ"]) assert.ok(!text.includes(junk), junk);
  assert.ok(text.includes("元のスレのタイトル") && (text.match(/ID:abc/g) ?? []).length === 12);
});
