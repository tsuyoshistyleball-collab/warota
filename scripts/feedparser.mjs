// RSS 1.0 (RDF) / RSS 2.0 / Atom を依存ライブラリなしでパースする軽量パーサー。
// title / link / 日付に加え、ニュース用に概要文 (description) とサムネイル画像も拾う。

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "'", rsquo: "'",
  ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™",
};

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

function safeCodePoint(cp) {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

function stripCdata(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function tagContent(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  return m ? decodeEntities(stripCdata(m[1]).trim()) : null;
}

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[2] ?? m[3]) : null;
}

// Atom の <link href="..."/> 形式。rel="alternate" か rel なしを優先する。
function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)];
  let fallback = null;
  for (const [, attrs] of links) {
    const href = attr(attrs, "href");
    if (!href) continue;
    const rel = attr(attrs, "rel");
    if (!rel || rel === "alternate") return decodeEntities(href);
    if (!fallback) fallback = decodeEntities(href);
  }
  return fallback;
}

function parseDate(block) {
  for (const tag of ["pubDate", "dc:date", "published", "updated", "date"]) {
    const v = tagContent(block, tag);
    if (v) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

// HTML断片をプレーンテキストにする。二重エスケープ (&amp;lt;p&amp;gt;) のフィードもあるため2回処理する。
// 段落などの区切りだけ空白にし、<b> などの装飾タグは詰める (日本語の文中に空白を入れない)
export function htmlToText(html) {
  let s = html;
  for (let i = 0; i < 2; i++) {
    s = decodeEntities(
      s
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<(br|\/?(p|div|li|ul|ol|h\d|tr|td|blockquote))\b[^>]*>/gi, " ")
        .replace(/<[^>]+>/g, ""),
    );
  }
  return s.replace(/\s+/g, " ").trim();
}

// media:thumbnail / media:content / enclosure / 本文中の最初の <img> から画像URLを拾う
function itemImage(block) {
  for (const [, tag, attrs] of block.matchAll(/<(media:thumbnail|media:content|enclosure)\b([^>]*)>/gi)) {
    const url = attr(attrs, "url");
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const isImage =
      tag.toLowerCase() === "media:thumbnail" ||
      attr(attrs, "medium") === "image" ||
      (attr(attrs, "type") ?? "").startsWith("image/") ||
      /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url);
    if (isImage) return decodeEntities(url);
  }
  const html = decodeEntities(stripCdata(block));
  const img = html.match(/<img\b[^>]*?\ssrc\s*=\s*["'](https?:\/\/[^"']+)["']/i);
  return img ? img[1] : null;
}

// フィード XML から記事の配列 [{title, link, ts, description, image}] を返す。
export function parseFeed(xml) {
  const items = [];
  // RSS 1.0/2.0 の <item>、Atom の <entry> の両方を拾う
  const blocks = [
    ...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ];
  for (const [, block] of blocks) {
    const title = tagContent(block, "title");
    let link = tagContent(block, "link");
    if (!link || !/^https?:\/\//i.test(link)) {
      link = atomLink(block);
    }
    if (!title || !link || !/^https?:\/\//i.test(link)) continue;
    const desc = tagContent(block, "description") ?? tagContent(block, "summary");
    items.push({
      title: title.replace(/\s+/g, " ").trim(),
      link: link.trim(),
      ts: parseDate(block),
      description: desc ? htmlToText(desc) : "",
      image: itemImage(block),
    });
  }
  return items;
}
