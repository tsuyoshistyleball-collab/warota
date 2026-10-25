"use strict";

// まとめ記事 (スレ) の見た目。アプリ内リーダーと、設定の見本の両方で使う。
// 抽出した記事の HTML は、まとめブログごとにレスの書き方が違うので、
// 開くときに「見出し (番号・名前・日付・ID) + 本文」の組 (.post > .hd + .pb) にそろえてから見た目を付ける
(() => {
  // ---- 設定 (localStorage) ----
  const KEY = "threadLook";
  const CHOICES = {
    style: ["simple", "card", "chat", "board"],
    size: ["s", "m", "l", "xl"],
    color: ["orig", "plain", "op"],
    theme: ["white", "sepia", "night"],
    head: ["full", "short"],
    img: ["big", "small"],
  };
  const look = { style: "simple", size: "m", color: "orig", theme: "white", head: "full", img: "big" };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    for (const k of Object.keys(CHOICES)) if (CHOICES[k].includes(saved[k])) look[k] = saved[k];
  } catch {}
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(look));
    } catch {}
  };

  // 見た目は look-* の class で切り替える (style.css)。暗い背景の色直しと、AA の大きさ合わせだけは JS で行う
  function applyLook(root) {
    for (const c of [...root.classList]) if (/^look-(st|fs|c|th|h|i)-/.test(c)) root.classList.remove(c);
    root.classList.add(
      `look-st-${look.style}`, `look-fs-${look.size}`, `look-c-${look.color}`,
      `look-th-${look.theme}`, `look-h-${look.head}`, `look-i-${look.img}`,
    );
    tuneColors(root, look.theme === "night" && look.color === "orig");
    fitAA(root);
  }

  // ---- レスの組み立て ----

  // 番号は先頭 (「◇ 1:」のような飾りの後ろも可)。日付の「26/10/20」や時刻「12:34」の数字は番号にしない
  const NUM_RE = /^[^\d\p{L}]{0,3}?(\d{1,5})(?![\d/])(?!\.\d)(?![:：]\d{2}(?:\D|$))/u;
  const DATE_RE =
    /(?:\d{1,4}\s*[/年.-]\s*)?\d{1,2}\s*[/月.-]\s*\d{1,2}\s*日?\s*(?:[(（]\s*[^)）\s]{1,3}\s*[)）])?\s*\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?/;
  const ID_RE = /ID\s*[:：]\s*(?:ID\s*[:：]\s*)?([0-9A-Za-z+/.?]{2,20})/;

  function parseHead(text) {
    const t = text.replace(/\s+/g, " ").trim();
    const out = { no: null, name: "", date: "", id: "" };
    let rest = t;
    const m = t.match(NUM_RE);
    if (m) {
      out.no = Number(m[1]);
      rest = t.slice(m.index + m[0].length);
    }
    const idm = rest.match(ID_RE);
    if (idm) out.id = idm[1].replace(/\.net$/, "");
    const dm = rest.match(DATE_RE);
    if (dm) out.date = dm[0].trim();
    const end = Math.min(dm ? dm.index : rest.length, idm ? idm.index : rest.length);
    out.name = rest
      .slice(0, end)
      .replace(/^[\s:：.．]+/, "")
      .replace(/^名前\s*[:：]\s*/, "")
      .replace(/\s*投稿日\s*[:：]?\s*$/, "")
      .replace(/\[\]\s*$/, "")
      .replace(/[\s:：]+$/, "")
      .trim();
    return out;
  }
  // スレ主かどうかを比べられる ID (「???」や数字1つのような見分けのつかないものは使わない)
  const realId = (id) => /^[0-9A-Za-z+/.]{4,}$/.test(id) && !/^\?+$/.test(id);

  const BLOCK = new Set(["DIV", "P", "DL", "DT", "DD", "UL", "OL", "LI", "TABLE", "BLOCKQUOTE", "PRE", "IMG", "VIDEO", "BR", "HR", "FIGURE"]);
  const LIST_PARENT = new Set(["DL", "UL", "OL", "TABLE", "TBODY", "THEAD", "TR"]);

  // 見出しの塊: class="ph" の要素から、見出しの文字だけを持つ入れ物まで上がる。
  // (ハムスター速報のように「1:」「名無し」が ph の前に別の要素で並んでいる見出しも1つの塊にする。
  //  見出しの前に置かれた画像 (ニュー速クオリティ) も塊に入れ、見出しを作り直すときにレスの前へ出す)
  function headUnit(ph, box) {
    let unit = ph;
    for (let i = 0; i < 3; i++) {
      const parent = unit.parentElement;
      if (!parent || parent === box || LIST_PARENT.has(parent.tagName)) break;
      const kids = [...parent.childNodes].filter(
        (n) => n !== unit && (n.textContent.trim() || (n.nodeType === 1 && (n.matches("img, video") || n.querySelector("img, video")))),
      );
      const before = kids.every((n) => unit.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING);
      const inline = kids.every(
        (n) => n.nodeType === 3 || n.tagName === "IMG" || (!BLOCK.has(n.tagName) && !n.querySelector("img, video, br, div, p")),
      );
      const extra = kids.reduce((s, n) => s + n.textContent.trim().length, 0);
      if (!before || !inline || extra > 40) break;
      unit = parent;
    }
    return unit;
  }

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // 見出しを「番号・名前・日付・ID」の決まった形で作り直す (見た目の切り替えで出し分けるため)
  function headElement(info, idStyle) {
    const hd = el("div", "hd");
    hd.append(el("span", "no", String(info.no)));
    if (info.name) hd.append(" ", el("span", "nm", info.name));
    if (info.date || info.id) {
      const meta = el("span", "meta");
      if (info.date) meta.append(el("span", "dt", info.date));
      if (info.id) {
        const idt = el("span", "idt", `ID:${info.id}`);
        if (idStyle) idt.setAttribute("style", idStyle);
        if (info.date) meta.append(" ");
        meta.append(idt);
      }
      hd.append(" ", meta);
    }
    return hd;
  }
  // 元の見出しで ID に付いていた飾り (スレ主の ID を赤くするブログなど)
  function idStyleOf(unit, id) {
    if (!id) return "";
    const hit = [...unit.querySelectorAll("[style]")].reverse().find((e) => e.textContent.includes(id));
    return hit?.getAttribute("style") ?? "";
  }

  // 記事の中のレスを .post にまとめ、番号からレスを引ける表を返す
  function groupPosts(box) {
    const units = [];
    for (const ph of box.querySelectorAll(".ph")) {
      if (ph.parentElement.closest(".ph")) continue;
      const u = headUnit(ph, box);
      if (!units.some((x) => x === u || x.contains(u))) units.push(u);
    }
    const holders = new Set(units);
    for (const u of units) for (let p = u.parentElement; p && p !== box; p = p.parentElement) holders.add(p);

    const posts = [];
    for (const unit of units) {
      const parent = unit.parentElement;
      if (!parent || /^(TBODY|THEAD|TR|TABLE)$/.test(parent.tagName)) continue;
      const info = parseHead(unit.textContent);
      const prev = posts[posts.length - 1];
      // 日付と ID だけの見出しが本文の後ろにある書き方 (ライフハックちゃんねる弐式) は、前のレスの見出しに入れる
      if (info.no == null && (info.date || info.id) && prev && !prev.date && !prev.id && prev.el.parentElement === parent) {
        let n = prev.el.nextSibling;
        while (n && n !== unit && !n.textContent.trim()) n = n.nextSibling;
        if (n === unit) {
          Object.assign(prev, { date: info.date, id: info.id });
          prev.hd.replaceWith((prev.hd = headElement(prev, idStyleOf(unit, info.id))));
          unit.remove();
          continue;
        }
      }
      const post = el("div", "post");
      const pb = el("div", "pb");
      parent.insertBefore(post, unit);
      let n = unit.nextSibling;
      while (n && !(n.nodeType === 1 && holders.has(n))) {
        const next = n.nextSibling;
        pb.appendChild(n);
        n = next;
      }
      // 見出しが読み取れたものだけ作り直す (読み取れない見出しは元のまま見せる)
      let hd = unit;
      if (info.no != null) {
        hd = headElement(info, idStyleOf(unit, info.id));
        for (const m of unit.querySelectorAll("img, video")) if (!m.closest(".ph")) post.before(m);
        unit.remove();
      } else {
        unit.classList.add("hd", "hd-raw");
      }
      post.append(hd, pb);
      trimBreaks(pb);
      posts.push({ el: post, hd, pb, ...info });
    }

    // スレ主: 1番のレスと同じ ID のレス (ID がなければ1番だけ)
    const first = posts.find((p) => p.no === 1);
    const opId = first && realId(first.id) ? first.id : "";
    const byNo = new Map();
    for (const p of posts) {
      if (opId ? p.id === opId : p.no === 1) {
        p.el.classList.add("is-op");
        p.hd.append(" ", el("span", "badge", "スレ主"));
      }
      if (p.no != null && !byNo.has(p.no)) byNo.set(p.no, p.el);
    }
    return byNo;
  }

  // 本文の最初と最後の改行・空白は除く
  function trimBreaks(pb) {
    const blank = (n) => n && ((n.nodeType === 3 && !n.textContent.trim()) || n.nodeName === "BR");
    while (blank(pb.firstChild)) pb.firstChild.remove();
    while (blank(pb.lastChild)) pb.lastChild.remove();
  }

  // ---- アンカー (>>5 を押すとそのレスを表示) ----
  const ANCHOR_RE = /(?:>>|＞＞|≫)\s?(\d{1,4})(?:\s?[-ー－〜~]\s?(\d{1,4}))?/g;

  function markAnchors(box) {
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement.closest(".pb") && !n.parentElement.closest("a, button, .hd") && /(>>|＞＞|≫)\s?\d/.test(n.textContent)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.textContent;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of text.matchAll(ANCHOR_RE)) {
        frag.append(text.slice(last, m.index));
        const b = el("button", "anc", m[0]);
        b.type = "button";
        b.dataset.from = m[1];
        b.dataset.to = m[2] ?? m[1];
        frag.append(b);
        last = m.index + m[0].length;
      }
      frag.append(text.slice(last));
      node.replaceWith(frag);
    }
  }

  // ---- AA (アスキーアート) ----
  // 罫線・記号・半角カナ・全角空白などが多い行が続く本文を AA とみなす
  const AA_CHAR = /[─-╿｡-ﾟ　|｜/／\\＼￣＿_´｀`'"ヽノ丶〃ミ彡从∀ωДд∩∪⊂⊃()（）ﾟ゜・:：;；,，.．…‥~～^＾<>＜＞=＝*＊+＋−‐∧∨○●◎◯∴∵⌒]/;
  // 本文を表示どおりの行に分ける (改行の要素とブロック要素で区切る)
  function linesOf(pb) {
    let s = "";
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) s += c.textContent.replace(/\n/g, " ");
        else if (c.nodeName === "BR") s += "\n";
        else if (c.nodeType === 1) {
          const block = BLOCK.has(c.tagName);
          if (block) s += "\n";
          walk(c);
          if (block) s += "\n";
        }
      }
    };
    walk(pb);
    return s.split("\n");
  }
  function isAA(pb) {
    const lines = linesOf(pb).map((l) => l.replace(/[ \t]+$/, "")).filter((l) => l.trim());
    if (lines.length < 4) return false;
    const aaLines = lines.filter((l) => {
      const chars = [...l.replace(/ /g, "")];
      if (chars.length < 4) return false;
      const sym = chars.filter((c) => AA_CHAR.test(c)).length;
      return sym / chars.length >= 0.45 || (/　{3,}/.test(l) && sym >= 3);
    });
    return aaLines.length >= 4 && aaLines.length >= lines.length * 0.5;
  }
  function markAA(box) {
    for (const pb of box.querySelectorAll(".pb")) {
      if (!isAA(pb)) continue;
      pb.classList.add("aa");
      const fit = el("div", "aa-fit");
      fit.append(...pb.childNodes);
      pb.append(fit);
    }
  }
  // 横に長い AA は、折り返さずに画面の幅まで文字を小さくする
  function fitAA(root) {
    for (const fit of root.querySelectorAll(".aa-fit")) {
      fit.style.fontSize = "";
      const box = fit.parentElement;
      const cs = getComputedStyle(box);
      const avail = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const w = fit.scrollWidth;
      if (avail > 0 && w > avail) {
        const size = parseFloat(getComputedStyle(fit).fontSize);
        fit.style.fontSize = `${Math.max(6, Math.floor(size * (avail / w) * 10) / 10)}px`;
      }
    }
  }

  // ---- 暗い背景での色直し ----
  // 元サイトの色は白い背景向けなので、暗い背景では文字を明るく・背景の色を暗くする (色味はそのまま)
  const ctx = document.createElement("canvas").getContext("2d");
  function toHsl(color) {
    ctx.fillStyle = "#000";
    ctx.fillStyle = color;
    const v = ctx.fillStyle;
    if (!v.startsWith("#")) return null;
    const n = parseInt(v.slice(1), 16);
    const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  const hsl = (h, s, l) => `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
  function tuneColors(root, night) {
    for (const e of root.querySelectorAll(".thread [style]")) {
      if (e.dataset.c == null) {
        e.dataset.c = e.style.color;
        e.dataset.bg = e.style.backgroundColor;
      }
      e.style.color = e.dataset.c;
      e.style.backgroundColor = e.dataset.bg;
      if (!night) continue;
      const fg = e.dataset.c && toHsl(e.dataset.c);
      if (fg && fg[2] < 0.72) e.style.color = hsl(fg[0], Math.min(fg[1], 0.85), 0.74);
      const bg = e.dataset.bg && toHsl(e.dataset.bg);
      if (bg && bg[2] > 0.3) e.style.backgroundColor = hsl(bg[0], Math.min(bg[1], 0.6), 0.2);
    }
  }

  // ---- リーダーでの操作 (アンカーの表示・小さい画像の拡大) ----
  const reader = document.getElementById("reader");
  const pop = document.getElementById("anc-pop");
  const popBody = pop.querySelector(".anc-body");
  let index = new Map();

  function prepare(box) {
    index = groupPosts(box);
    markAnchors(box);
    markAA(box);
  }

  function showAnchor(from, to) {
    const lo = Math.min(from, to);
    const hi = Math.min(Math.max(from, to), lo + 9);
    popBody.textContent = "";
    for (let n = lo; n <= hi; n++) {
      const post = index.get(n);
      if (post) popBody.append(post.cloneNode(true));
    }
    if (!popBody.childElementCount) popBody.append(el("p", "anc-none", `>>${lo} のレスは、この記事に載っていません`));
    pop.querySelector(".anc-title").textContent = lo === hi ? `>>${lo}` : `>>${lo}-${hi}`;
    tuneColors(reader, look.theme === "night" && look.color === "orig");
    if (pop.hidden) {
      history.pushState({ anc: true }, "");
      pop.hidden = false;
    }
    pop.querySelector(".anc-sheet").scrollTop = 0;
    fitAA(popBody);
  }
  function closePopup() {
    pop.hidden = true;
    popBody.textContent = "";
  }

  reader.addEventListener("click", (e) => {
    const anc = e.target.closest(".anc");
    if (anc) {
      e.preventDefault();
      showAnchor(Number(anc.dataset.from), Number(anc.dataset.to));
      return;
    }
    if (e.target.closest(".anc-close") || e.target === pop) {
      history.back();
      return;
    }
    const img = e.target.closest(".thread img");
    if (img && look.img === "small" && !img.closest(".embed-video")) {
      e.preventDefault();
      img.classList.toggle("zoom");
    }
  });

  let fitTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      fitAA(reader);
      fitAA(preview);
    }, 150);
  });

  // ---- 設定の画面 (選択肢と見本) ----
  const preview = document.getElementById("look-preview");
  const SAMPLE_IMG =
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#f3d8a8"/>' +
        '<ellipse cx="160" cy="104" rx="118" ry="52" fill="#fff"/><ellipse cx="160" cy="98" rx="96" ry="38" fill="#fbf7ee"/>' +
        '<path d="M160 64c50 0 92 14 92 34s-42 34-92 34z" fill="#b8641e"/><circle cx="196" cy="92" r="9" fill="#e48a3c"/>' +
        '<circle cx="222" cy="104" r="7" fill="#7aa24a"/><circle cx="184" cy="114" r="8" fill="#e48a3c"/></svg>',
    );
  const SAMPLE =
    '<div class="t_h"><span class="ph">1: 名無しさん 2026/10/24(土) 09:12:05.31 ID:Ab3dE5fG0</span></div>' +
    '<div class="t_b" style="color:#7a2e9b;font-weight:bold;font-size:1.1em">今日から自炊始めたんやが<br>最初に何作ればええ？</div>' +
    '<div class="t_h"><span class="ph">2: 名無しさん 2026/10/24(土) 09:13:40.02 ID:Qx7pL2mN0</span></div>' +
    '<div class="t_b" style="color:#1f2bd6">&gt;&gt;1<br>カレー一択やろ</div>' +
    '<div class="t_h"><span class="ph">3: 名無しさん 2026/10/24(土) 09:14:11.87 ID:Ab3dE5fG0</span></div>' +
    `<div class="t_b" style="color:#7a2e9b;font-weight:bold;font-size:1.1em">作ったで<br><img src="${SAMPLE_IMG}" alt=""></div>` +
    '<div class="t_h"><span class="ph">5: 名無しさん 2026/10/24(土) 09:15:02.44 ID:kD9pX2wQ0</span></div>' +
    '<div class="t_b">うまそうやん<span style="color:#d4001b;font-weight:bold;font-size:1.4em">！</span></div>';

  function renderPreview() {
    const box = preview.querySelector(".thread");
    box.innerHTML = SAMPLE;
    groupPosts(box);
    markAnchors(box);
    applyLook(preview);
  }

  for (const input of document.querySelectorAll('#look-card input[type="radio"]')) {
    const key = input.name.replace(/^look-/, "");
    input.checked = look[key] === input.value;
    input.addEventListener("change", () => {
      if (!input.checked) return;
      look[key] = input.value;
      save();
      applyLook(reader);
      renderPreview();
    });
  }
  renderPreview();
  applyLook(reader);

  window.Thread = {
    // 記事を表示した直後に呼ぶ
    open(box) {
      closePopup();
      prepare(box);
      applyLook(reader);
    },
    // 戻る操作でアンカーの表示を閉じたときは true (記事は閉じない)
    onPopState() {
      if (pop.hidden) return false;
      closePopup();
      return true;
    },
    close: closePopup,
    // テスト用
    _parseHead: parseHead,
  };
})();
