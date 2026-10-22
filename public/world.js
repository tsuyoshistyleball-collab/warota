"use strict";

// 世界地図から地域別の話題ニュースを見る「ワールド」画面。
// world-map.json (地図の形・ラベル位置・拡大範囲) と world.json (地域ごとの話題TOP10) を表示する。
// 画面の切り替えは URL のハッシュで行う: #/world → #/world/<地域> → #/world/<地域>/<記事ID>、#/matome
(() => {
  const $ = (id) => document.getElementById(id);
  const SVG_NS = "http://www.w3.org/2000/svg";
  const AUTO_REFRESH_MS = 5 * 60 * 1000;
  const READ_MAX = 500;
  const PIN_PX = 3.5; // 日本の位置を示す点の半径 (画面上の大きさ。地図を拡大しても変えない)
  // 話題の盛り上がり (0〜1) を表す1色の濃淡。明るさが単調に変わることを検証済みの5段階を補間する
  const HEAT_RAMP = ["#f7eee9", "#f5cfb6", "#f4b082", "#ec8f4a", "#e07100"];
  // 色だけに頼らず、盛り上がりを言葉でも示す
  const HEAT_WORDS = [[0.75, "沸騰"], [0.45, "活発"], [0.15, "ふつう"], [0, "静か"]];
  const REGION_ORDER = ["japan", "asia", "europe", "mideast", "africa", "namerica", "latam", "oceania"];
  const REGION_NAMES = {
    japan: "日本", asia: "アジア", europe: "ヨーロッパ", mideast: "中東",
    africa: "アフリカ", namerica: "北米", latam: "中南米", oceania: "オセアニア",
  };
  // 話題が見つからない地域で案内する Googleニュースの検索語
  const SEARCH_WORDS = {
    japan: "日本", asia: "アジア", europe: "ヨーロッパ", mideast: "中東", africa: "アフリカ",
    namerica: "アメリカ", latam: "中南米", oceania: "オーストラリア OR ニュージーランド",
  };

  const ICONS = {
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 13v5.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V13"/></svg>',
    external: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M17 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18.5v-10A1.5 1.5 0 0 1 5.5 7H10"/></svg>',
    spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>',
    reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.3 3.5 5.2 3.5 8.5s-1.1 6.2-3.5 8.5c-2.4-2.3-3.5-5.2-3.5-8.5S9.6 5.8 12 3.5z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/></svg>',
  };

  const wide = matchMedia("(min-width: 600px)");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  let mapData = null;
  let world = null;
  let lastFetched = 0;
  let homeMap = null;
  let miniMap = null;
  let route = { view: "world", region: null, article: null };
  let sideWasOpen = false;
  let regionShown = { id: null, updated: 0 };
  let articleShown = "";

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    },
  };
  let readIds = store.get("worldRead", []);
  const readSet = new Set(readIds);

  // ---- 小さな道具 ----

  // 要素を作る。文字列の子要素はテキストとして入る (ニュースの見出しをHTMLとして解釈しない)
  function h(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "style") e.style.cssText = v;
      else if (k === "html") e.innerHTML = v; // アイコンなど、こちらで用意した固定のマークアップだけに使う
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) e.append(c);
    return e;
  }
  const svgEl = (tag, attrs = {}) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);
  const thumbImg = (src, cls) =>
    h("img", { class: cls, src, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer", onerror: (e) => e.target.remove() });

  function heatColor(heat) {
    const t = Math.max(0, Math.min(1, heat || 0)) * (HEAT_RAMP.length - 1);
    const i = Math.min(HEAT_RAMP.length - 2, Math.floor(t));
    const rgb = (hex) => [1, 3, 5].map((p) => parseInt(hex.slice(p, p + 2), 16));
    const a = rgb(HEAT_RAMP[i]);
    const b = rgb(HEAT_RAMP[i + 1]);
    return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * (t - i))).join(",")})`;
  }
  const heatWord = (heat) => HEAT_WORDS.find(([min]) => heat >= min)[1];

  function ago(ts) {
    const min = Math.round((Date.now() - ts) / 60000);
    if (min < 1) return "たった今";
    if (min < 60) return `${min}分前`;
    const hours = Math.round(min / 60);
    if (hours < 24) return `${hours}時間前`;
    return `${Math.round(hours / 24)}日前`;
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  const regionOf = (id) =>
    world?.regions.find((r) => r.id === id) ?? { id, name: REGION_NAMES[id], heat: 0, items: [] };
  // 盛り上がりが一番大きい地域 (広い画面で最初に右側へ出す)
  const hottestRegion = () =>
    [...(world?.regions ?? [])].filter((r) => r.items.length).sort((a, b) => b.heat - a.heat)[0]?.id ?? "japan";

  function markRead(id) {
    if (readSet.has(id)) return;
    readSet.add(id);
    readIds.unshift(id);
    if (readIds.length > READ_MAX) for (const old of readIds.splice(READ_MAX)) readSet.delete(old);
    store.set("worldRead", readIds);
  }

  // ---- 地図 ----

  // 地図のSVGを作る。prefix は1ページに地図が2つあってもグラデーション等のIDが重ならないようにするため
  function createMap(svg, prefix) {
    svg.textContent = "";
    const [x, y, w, hgt] = mapData.viewBox;
    svg.setAttribute("viewBox", `${x} ${y} ${w} ${hgt}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
    const defs = svgEl("defs");
    defs.innerHTML = `
      <radialGradient id="${prefix}-ocean" cx="50%" cy="38%" r="72%">
        <stop offset="0" stop-color="#f1f6fb"/><stop offset=".65" stop-color="#e2ecf6"/><stop offset="1" stop-color="#d2e1f0"/>
      </radialGradient>
      <filter id="${prefix}-lift" x="-5%" y="-5%" width="110%" height="118%">
        <feDropShadow dx="0" dy="1.4" stdDeviation="1.8" flood-color="#18284a" flood-opacity=".2"/>
      </filter>`;
    svg.append(defs);
    svg.append(svgEl("path", { d: mapData.sphere, fill: `url(#${prefix}-ocean)`, class: "m-sphere" }));
    svg.append(svgEl("path", { d: mapData.graticule, class: "m-grat" }));
    const land = svgEl("g", { class: "m-land", filter: `url(#${prefix}-lift)` });
    const regions = new Map();
    for (const id of REGION_ORDER) {
      // ニュースを読み込む前 (読み込めなかったとき) も、塗りの既定値の黒にならないようにする
      const p = svgEl("path", { d: mapData.regions[id], class: "m-region", "data-region": id, fill: HEAT_RAMP[0] });
      land.append(p);
      regions.set(id, p);
    }
    svg.append(land);
    svg.append(svgEl("path", { d: mapData.inner, class: "m-inner" }));
    svg.append(svgEl("path", { d: mapData.seams, class: "m-seam" }));
    // 日本は小さいので、太平洋側のラベルから引き出し線で示す
    const [px, py] = mapData.pins.japan;
    const [lx, ly] = mapData.labels.japan;
    svg.append(svgEl("line", { x1: px, y1: py, x2: lx, y2: ly, class: "m-leader" }));
    const pin = svgEl("circle", { cx: px, cy: py, r: 2.6, class: "m-pin" });
    svg.append(pin);
    return { svg, regions, pin, vb: mapData.viewBox.slice(), width: 0, anim: 0, chips: new Map(), region: null };
  }

  function paintMap(m, selected) {
    for (const [id, path] of m.regions) {
      path.setAttribute("fill", heatColor(regionOf(id).heat));
      path.classList.toggle("sel", id === selected);
    }
    m.svg.classList.toggle("has-sel", !!selected);
  }

  // 拡大範囲 [x0,y0,x1,y1] を、表示枠の縦横比に合わせた viewBox [x,y,w,h] にする
  function fitBox([x0, y0, x1, y1], aspect, pad) {
    let w = (x1 - x0) * (1 + pad);
    let hgt = (y1 - y0) * (1 + pad);
    if (w / hgt > aspect) hgt = w / aspect;
    else w = hgt * aspect;
    return [(x0 + x1) / 2 - w / 2, (y0 + y1) / 2 - hgt / 2, w, hgt];
  }

  // region を指定すればその地域へ、null なら世界全体へ寄せる
  function zoomMap(m, region, animate = true) {
    const { width, height } = m.svg.getBoundingClientRect();
    if (width) m.width = width;
    const [x, y, w, hgt] = mapData.viewBox;
    const aspect = width && height ? width / height : w / hgt;
    const target = region ? fitBox(mapData.boxes[region], aspect, 0.14) : fitBox([x, y, x + w, y + hgt], aspect, 0);
    cancelAnimationFrame(m.anim);
    m.svg.classList.remove("animating");
    if (target.every((v, i) => Math.abs(v - m.vb[i]) < 0.05)) {
      placeChips(m);
      return;
    }
    if (!animate || reducedMotion.matches) {
      m.vb = target;
      m.svg.setAttribute("viewBox", target.join(" "));
      placeChips(m);
      return;
    }
    const from = m.vb.slice();
    const start = performance.now();
    m.svg.classList.add("animating");
    const step = (now) => {
      const t = Math.min(1, (now - start) / 560);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      m.vb = from.map((v, i) => v + (target[i] - v) * e);
      m.svg.setAttribute("viewBox", m.vb.join(" "));
      placeChips(m);
      if (t < 1) m.anim = requestAnimationFrame(step);
      else m.svg.classList.remove("animating");
    };
    m.anim = requestAnimationFrame(step);
  }

  // 地図上の地域名チップ (HTML) を、SVG上のラベル位置に合わせて置く
  function placeChips(m) {
    const [vx, vy, vw, vh] = m.vb;
    for (const [id, chip] of m.chips) {
      const [x, y] = mapData.labels[id];
      const left = ((x - vx) / vw) * 100;
      const top = ((y - vy) / vh) * 100;
      chip.style.left = `${left}%`;
      chip.style.top = `${top}%`;
      chip.classList.toggle("off", left < 4 || left > 96 || top < 6 || top > 94);
    }
    if (m.width) m.pin.setAttribute("r", ((PIN_PX * vw) / m.width).toFixed(2));
  }

  function renderChips(m, layer, selected) {
    layer.textContent = "";
    m.chips.clear();
    const hottest = hottestRegion();
    for (const id of REGION_ORDER) {
      const r = regionOf(id);
      const chip = h(
        "a",
        {
          class: `chip${id === hottest ? " hot" : ""}${selected && id !== selected ? " dim" : ""}${id === selected ? " sel" : ""}`,
          href: `#/world/${id}`,
          "aria-label": `${r.name} 話題のニュース${r.items.length}件`,
        },
        h("i", { class: "chip-dot", style: `background:${heatColor(r.heat)}` }),
        h("span", {}, r.name),
        r.items.length ? h("b", {}, String(r.items.length)) : null,
      );
      layer.append(chip);
      m.chips.set(id, chip);
    }
    placeChips(m);
  }

  // ---- ホーム (地図と地域カード) ----

  function renderHome(sideRegion) {
    const isWide = wide.matches;
    const selected = isWide ? route.region : null;
    paintMap(homeMap, selected);
    renderChips(homeMap, $("map-chips"), selected);
    $("map-reset").hidden = !selected;

    const box = $("region-cards");
    box.textContent = "";
    box.removeAttribute("aria-busy");
    const hottest = hottestRegion();
    // 日本を先頭に、ほかは盛り上がりの大きい順。話題のない地域は最後
    const order = [...REGION_ORDER].sort((a, b) => {
      const ra = regionOf(a);
      const rb = regionOf(b);
      return (b === "japan") - (a === "japan") || (rb.items.length > 0) - (ra.items.length > 0) || rb.heat - ra.heat;
    });
    for (const id of order) {
      const r = regionOf(id);
      const top = r.items[0];
      const thumb = safeUrl(top?.image);
      box.append(
        h(
          "a",
          { class: `rcard${isWide && sideRegion === id ? " active" : ""}${id === hottest ? " hot" : ""}`, href: `#/world/${id}` },
          h(
            "div",
            { class: "rcard-head" },
            h("i", { class: "rdot", style: `background:${heatColor(r.heat)}` }),
            h("h3", {}, r.name),
            h("span", { class: "rcard-count" }, r.items.length ? `TOP${r.items.length}` : "話題なし"),
            h("span", { class: "rcard-go", html: ICONS.chevron }),
          ),
          top
            ? h(
                "div",
                { class: "rcard-top" },
                h("p", {}, h("span", { class: "rcard-rank" }, "1位"), top.title),
                thumb ? thumbImg(thumb, "rcard-thumb") : null,
              )
            : h("p", { class: "rcard-empty" }, "いまは大きな話題が見つかっていません"),
          h(
            "div",
            { class: "heat-row" },
            h("div", { class: "heat-bar" }, h("i", { style: `width:${Math.max(4, Math.round(r.heat * 100))}%;background:${heatColor(Math.max(r.heat, 0.25))}` })),
            h("span", {}, r.items.length ? `話題度 ${heatWord(r.heat)}` : "—"),
          ),
        ),
      );
    }
  }

  // ---- 地域の話題TOP10 ----

  function renderRegion(id, opening) {
    const r = regionOf(id);
    const changed = regionShown.id !== id;
    if (changed || regionShown.updated !== world.updated) {
      regionShown = { id, updated: world.updated };
      renderRegionList(id, r);
      if (changed) $("rv-scroll").scrollTop = 0;
    }

    // 狭い画面では、見出しの上に選んだ地域へ寄せた小さな地図を出す (開くたびに世界全体から寄っていく)
    if (!wide.matches) {
      if (!miniMap) {
        const svg = svgEl("svg", { class: "map-svg", "aria-hidden": "true" });
        $("rv-map").append(svg);
        miniMap = createMap(svg, "mini");
      }
      paintMap(miniMap, id);
      if (opening || miniMap.region !== id) {
        miniMap.region = id;
        zoomMap(miniMap, null, false);
        requestAnimationFrame(() => zoomMap(miniMap, id));
      }
    }

    // 開いている記事・既読の印だけを付け直す (一覧を作り直すとスクロール位置が戻ってしまう)
    for (const a of $("rv-list").querySelectorAll("a[data-id]")) {
      a.classList.toggle("active", a.dataset.id === route.article);
      a.parentElement.classList.toggle("read", readSet.has(a.dataset.id));
    }
  }

  function renderRegionList(id, r) {
    $("rv-name").textContent = r.name;
    $("rv-dot").style.background = heatColor(r.heat);
    $("rv-sub").textContent = `話題のニュース${r.items.length ? ` TOP${r.items.length}` : ""} ・ ${fmtTime(world.updated)} 更新`;

    const list = $("rv-list");
    list.textContent = "";
    if (r.items.length === 0) {
      const q = encodeURIComponent(SEARCH_WORDS[id] ?? r.name);
      list.append(
        h(
          "li",
          { class: "rv-empty" },
          h("p", {}, `${r.name}の話題は、日本語のニュースではまだ大きく取り上げられていません。`),
          h("a", { href: `https://news.google.com/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`, target: "_blank", rel: "noopener noreferrer" }, "Googleニュースで探す"),
        ),
      );
      return;
    }
    r.items.forEach((it, i) => {
      const thumb = safeUrl(it.image);
      list.append(
        h(
          "li",
          {},
          h(
            "a",
            { href: `#/world/${id}/${it.id}`, "data-id": it.id },
            h("span", { class: `rank${i < 3 ? " top" : ""}` }, String(i + 1)),
            h(
              "div",
              { class: "ri-body" },
              h("h3", {}, it.title),
              h(
                "p",
                { class: "ri-meta" },
                h("span", { class: "ri-source" }, it.source),
                h("span", {}, ago(it.ts)),
                it.outlets > 1 ? h("span", { class: "ri-outlets" }, `${it.outlets}社が報道`) : null,
              ),
            ),
            thumb ? thumbImg(thumb, "ri-thumb") : null,
          ),
        ),
      );
    });
  }

  // ---- 記事の詳細 (最初に要約) ----

  function summaryBlock(text) {
    // 「。」で区切って、2文以上なら箇条書きにする
    const sentences = (text.match(/[^。]+。?/g) ?? []).map((s) => s.trim()).filter(Boolean);
    if (sentences.length >= 2) return h("ul", { class: "sum-list" }, sentences.map((s) => h("li", {}, s)));
    return h("p", { class: "sum-text" }, text);
  }

  function renderArticle(regionId, itemId) {
    // 同じ記事を表示中なら作り直さない (自動更新で読んでいる位置が先頭に戻らないように)
    const key = `${regionId}/${itemId}`;
    if (articleShown === key) return;
    articleShown = key;

    const r = regionOf(regionId);
    const index = r.items.findIndex((it) => it.id === itemId);
    const it = r.items[index];
    const box = $("av-body");
    box.textContent = "";
    $("av-scroll").scrollTop = 0;
    $("av-crumb").textContent = it ? `${r.name}・${index + 1}位` : r.name;
    if (!it) {
      $("av-share").hidden = true;
      box.append(h("p", { class: "av-missing" }, "この記事はランキングから外れました。最新の一覧からお選びください。"));
      return;
    }
    markRead(it.id);
    const url = safeUrl(it.url);
    const img = safeUrl(it.image);
    const next = r.items[index + 1];
    box.append(
      img
        ? h("figure", { class: "av-hero" }, h("img", { src: img, alt: "", decoding: "async", referrerpolicy: "no-referrer", onerror: (e) => e.target.closest("figure").remove() }))
        : null,
      h("h2", { class: "av-title" }, it.title),
      h(
        "p",
        { class: "av-meta" },
        h("span", { class: "av-source" }, it.source),
        h("span", {}, fmtTime(it.ts)),
        it.outlets > 1 ? h("span", { class: "ri-outlets" }, `${it.outlets}社が報道`) : null,
      ),
      h(
        "section",
        { class: "sum-card", "aria-label": "要約" },
        h("h3", {}, h("span", { class: "sum-icon", html: ICONS.spark }), "要約"),
        it.summary ? summaryBlock(it.summary) : h("p", { class: "sum-text muted" }, "この記事には要約がありません。元記事でご確認ください。"),
        h("p", { class: "sum-note" }, `${it.source}が配信した記事の概要をもとに表示しています`),
      ),
      url
        ? h(
            "a",
            { class: "cta", href: url, target: "_blank", rel: "noopener noreferrer" },
            h("span", {}, "元記事を読む"),
            h("small", {}, it.source),
            h("span", { class: "cta-icon", html: ICONS.external }),
          )
        : null,
      it.coverage?.length
        ? h(
            "section",
            { class: "coverage" },
            h("h3", {}, `このニュースを伝えたメディア (${it.coverage.length})`),
            h(
              "ul",
              {},
              it.coverage.map((c) => {
                const u = safeUrl(c.u);
                return h(
                  "li",
                  {},
                  h(u ? "a" : "div", u ? { href: u, target: "_blank", rel: "noopener noreferrer" } : {}, h("b", {}, c.s), h("span", {}, c.t)),
                );
              }),
            ),
          )
        : null,
      next
        ? h(
            "a",
            { class: "next-card", href: `#/world/${regionId}/${next.id}` },
            h("small", {}, `次の話題・${index + 2}位`),
            h("span", {}, next.title),
            h("span", { class: "next-go", html: ICONS.chevron }),
          )
        : null,
    );
    $("av-share").hidden = !navigator.share || !url;
    $("av-share").onclick = () => navigator.share?.({ title: it.title, url }).catch(() => {});
  }

  // ---- 画面の切り替え ----

  function parseHash(hash = location.hash) {
    const parts = decodeURIComponent(hash.replace(/^#\/?/, "")).split("/");
    if (parts[0] === "matome") return { view: "matome", region: null, article: null };
    const region = REGION_ORDER.includes(parts[1]) ? parts[1] : null;
    return { view: "world", region, article: region ? parts[2] || null : null };
  }

  // 画面ごとのスクロール位置 (ワールドとまとめは同じページのスクロールを使うので、切り替えるときに覚えておく)
  const scrollPos = { world: 0, matome: 0 };
  let shownView = null;

  function showView() {
    if (shownView === route.view) return;
    if (shownView) scrollPos[shownView] = window.scrollY;
    const isWorld = route.view === "world";
    $("view-world").hidden = !isWorld;
    $("view-matome").hidden = isWorld;
    document.documentElement.dataset.view = route.view;
    for (const a of document.querySelectorAll("#tabbar a")) {
      if (a.dataset.tab === route.view) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    if (!isWorld) document.body.classList.remove("w-overlay");
    window.scrollTo(0, scrollPos[route.view]);
    shownView = route.view;
  }

  function renderRoute() {
    showView();
    if (route.view !== "world" || !world || !mapData) return;
    const isWide = wide.matches;
    // 広い画面では右側を空けず、地域を選ぶ前は一番話題の地域を出しておく
    const sideRegion = route.region ?? (isWide ? hottestRegion() : null);
    renderHome(sideRegion);
    zoomMap(homeMap, isWide ? route.region : null);

    const side = $("w-side");
    const open = !!sideRegion;
    const opening = open && !sideWasOpen;
    sideWasOpen = open;
    side.classList.toggle("open", open);
    side.inert = !open;
    $("w-main").inert = !isWide && open;
    document.body.classList.toggle("w-overlay", !isWide && open);
    if (!open) return;
    const showArticle = !!route.article;
    side.classList.toggle("show-article", showArticle);
    $("region-view").inert = showArticle;
    $("article-view").inert = !showArticle;
    $("rv-back").hidden = isWide;
    $("rv-hint").hidden = !(isWide && !route.region);
    renderRegion(sideRegion, opening);
    if (showArticle) renderArticle(sideRegion, route.article);
    else articleShown = "";
  }

  // ---- 履歴 ----
  // アプリ内の移動は pushState で行い、履歴ごとに通し番号 (idx) を付ける。
  // entries[idx] にその履歴のハッシュを覚えておき、「戻る」ボタンでブラウザの「戻る」を使えるか判断する
  const entries = [];
  let idx = 0;

  function navigate(hash, replace = false) {
    if (hash === location.hash) return;
    if (replace) {
      history.replaceState({ idx }, "", hash);
    } else {
      idx++;
      entries.length = idx;
      history.pushState({ idx }, "", hash);
    }
    entries[idx] = location.hash;
    route = parseHash();
    renderRoute();
  }

  window.addEventListener("popstate", (e) => {
    if (Number.isInteger(e.state?.idx)) idx = e.state.idx;
    entries[idx] = location.hash;
    route = parseHash();
    renderRoute();
  });
  // アドレス欄の書き換えなど、pushState を通らない移動
  window.addEventListener("hashchange", () => {
    if (entries[idx] === location.hash) return; // popstate で処理済み
    idx = Number.isInteger(history.state?.idx) ? history.state.idx : idx + 1;
    history.replaceState({ idx }, "");
    entries[idx] = location.hash;
    route = parseHash();
    renderRoute();
  });

  // p が r より上の画面か (記事 → 地域の一覧 → 地図)
  function isAbove(p, r) {
    if (p.view !== "world" || p.article) return false;
    if (r.article) return !p.region || p.region === r.region;
    return !!r.region && !p.region;
  }

  // 戻る: 直前の履歴が上の画面ならブラウザの「戻る」。URLを直接開いたときなどは上の画面に置き換える
  function goBack() {
    const prev = idx > 0 ? entries[idx - 1] : null;
    if (prev && isAbove(parseHash(prev), route)) history.back();
    else navigate(route.article ? `#/world/${route.region}` : "#/world", true);
  }

  // 画面内の「#/...」へのリンクは pushState で移動する
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.('a[href^="#/"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(a.getAttribute("href"));
  });

  // 下のタブ。直前の履歴がそのタブなら「戻る」で切り替え、タブを行き来しても履歴が積み重ならないようにする
  for (const a of document.querySelectorAll("#tabbar a")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const tab = a.dataset.tab;
      if (tab === route.view) {
        window.scrollTo({ top: 0, behavior: reducedMotion.matches ? "auto" : "smooth" });
        return;
      }
      const prev = idx > 0 ? entries[idx - 1] : null;
      if (prev && parseHash(prev).view === tab) history.back();
      else navigate(a.getAttribute("href"));
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && route.view === "world" && (route.article || (route.region && !wide.matches))) goBack();
  });
  wide.addEventListener("change", () => renderRoute());
  window.addEventListener("resize", () => {
    if (!homeMap) return;
    homeMap.width = homeMap.svg.clientWidth || homeMap.width;
    placeChips(homeMap);
  });

  // ---- データ取得 ----

  async function loadWorld(manual = false) {
    const btn = $("w-refresh");
    btn.classList.add("spinning");
    try {
      if (!mapData) {
        const res = await fetch("./world-map.json");
        if (!res.ok) throw new Error(`map HTTP ${res.status}`);
        mapData = await res.json();
        $("map-stage").style.aspectRatio = `${mapData.viewBox[2]} / ${mapData.viewBox[3]}`;
        homeMap = createMap($("world-map"), "home");
        homeMap.svg.addEventListener("click", (e) => {
          const id = e.target.closest?.(".m-region")?.dataset.region;
          if (id) navigate(`#/world/${id}`);
        });
      }
      const res = await fetch(`./world.json?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      world = await res.json();
      lastFetched = Date.now();
      $("w-updated").textContent = `${fmtTime(world.updated)} 更新`;
      $("w-status").hidden = true;
      renderRoute();
    } catch {
      if (!world) {
        $("w-status").textContent = "ニュースを読み込めませんでした。通信環境を確認して、右上の更新ボタンを押してください。";
        $("w-status").hidden = false;
      } else if (manual) {
        $("w-updated").textContent = "更新に失敗しました";
      }
    } finally {
      btn.classList.remove("spinning");
    }
  }

  $("w-refresh").addEventListener("click", () => loadWorld(true));
  $("rv-back").addEventListener("click", goBack);
  $("av-back").addEventListener("click", goBack);
  $("map-reset").addEventListener("click", () => navigate("#/world"));
  $("w-refresh").innerHTML = ICONS.refresh;
  $("map-reset").innerHTML = `${ICONS.reset}<span>世界全体</span>`;
  $("rv-back").innerHTML = ICONS.back;
  $("av-back").innerHTML = ICONS.back;
  $("av-share").innerHTML = ICONS.share;

  setInterval(() => {
    if (document.visibilityState === "visible" && route.view === "world") loadWorld();
  }, AUTO_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastFetched > AUTO_REFRESH_MS) loadWorld();
  });

  // まとめ画面 (app.js) からも使う
  window.World = {
    isActive: () => route.view === "world",
    // 地域や記事の画面が全面に重なっている (引っ張って更新を効かせない)
    overlayOpen: () => document.body.classList.contains("w-overlay"),
    refresh: () => loadWorld(true),
  };

  // この履歴に番号を付けて始める (再読み込みでは番号が残る)
  idx = Number.isInteger(history.state?.idx) ? history.state.idx : 0;
  history.replaceState({ ...history.state, idx }, "", location.hash || "#/world");
  entries[idx] = location.hash;
  route = parseHash();
  showView();
  loadWorld();
})();
