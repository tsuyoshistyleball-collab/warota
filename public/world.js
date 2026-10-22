"use strict";

// 世界地図から地域別の話題ニュースを見る「ワールド」画面。
// world-map.json (地図の形・ラベル位置・拡大範囲) と world.json (地域ごとの話題TOP10) を表示する。
// 画面の切り替えは URL のハッシュで行う: #/world → #/world/<地域> → #/world/<地域>/<記事ID>、#/matome、#/settings
(() => {
  const $ = (id) => document.getElementById(id);
  const SVG_NS = "http://www.w3.org/2000/svg";
  const AUTO_REFRESH_MS = 5 * 60 * 1000;
  const READ_MAX = 500;
  const PIN_PX = 3.5; // 日本の位置を示す点の半径 (画面上の大きさ。地図を拡大しても変えない)
  const MIN_VIEW_W = 70; // いちばん拡大したときに見える幅 (地図全体の幅は 1000)
  const ZOOM_STEP = 1.7; // 拡大・縮小ボタン1回の倍率
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
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>',
  };

  const TAB_ORDER = ["world", "matome", "settings"]; // 下のタブの並び (左から)
  const VIEW_IDS = { world: "view-world", matome: "view-matome", settings: "view-settings" }; // タブごとの画面
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
  let leaving = null; // スワイプで送り出し中の画面 {anim, timer}

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
  let mapSize = store.get("mapSize", "large") === "small" ? "small" : "large"; // 地図の大きさ (大・小)

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

  const viewEl = (view) => $(VIEW_IDS[view]);
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
    return { svg, regions, pin, vb: mapData.viewBox.slice(), size: [0, 0], anim: 0, frame: 0, chips: new Map(), region: null };
  }

  function paintMap(m, selected) {
    for (const [id, path] of m.regions) {
      path.setAttribute("fill", heatColor(regionOf(id).heat));
      path.classList.toggle("sel", id === selected);
    }
    m.svg.classList.toggle("has-sel", !!selected);
  }

  // 表示枠の大きさ (画面上のピクセル) と、地図に重なっているボタン類の位置を測る。隠れていて測れないときは前の値のまま
  function measure(m) {
    const r = m.svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    m.size = [r.width, r.height];
    m.covers = [...(m.overlays ?? [])]
      .map((el) => el.getBoundingClientRect())
      .filter((c) => c.width)
      .map((c) => [c.left - r.left, c.top - r.top, c.right - r.left, c.bottom - r.top]);
  }
  const aspectOf = (m) => (m.size[0] ? m.size[0] / m.size[1] : mapData.viewBox[2] / mapData.viewBox[3]);

  // 見える範囲の幅の限度 [最小, 最大]。いちばん引いたときも地図が枠いっぱいに広がり、地図の端の外は見せない
  function widthLimits(m) {
    const [, , bw, bh] = mapData.viewBox;
    const max = Math.min(bw, bh * aspectOf(m));
    return [Math.min(MIN_VIEW_W, max), max];
  }

  // 範囲 [x,y,w,h] が収まるように、枠の縦横比・拡大の限度・地図の外に出ない位置に合わせた viewBox を返す
  function clampView(m, [x, y, w, h]) {
    const [bx, by, bw, bh] = mapData.viewBox;
    const aspect = aspectOf(m);
    const [minW, maxW] = widthLimits(m);
    const nw = Math.min(maxW, Math.max(minW, w, h * aspect));
    const nh = nw / aspect;
    const nx = Math.min(bx + bw - nw, Math.max(bx, x + w / 2 - nw / 2));
    const ny = Math.min(by + bh - nh, Math.max(by, y + h / 2 - nh / 2));
    return [nx, ny, nw, nh];
  }
  // 最初に見せる範囲: いちばん引いた大きさで、地図の中央 (日本が真ん中の図法) に置く
  const homeView = (m) => clampView(m, mapData.viewBox);
  // 地域を選んだときの範囲 (地域の拡大範囲 [x0,y0,x1,y1] に少し余白を付ける)
  function regionView(m, id) {
    const [x0, y0, x1, y1] = mapData.boxes[id];
    const [w, hgt] = [x1 - x0, y1 - y0];
    return clampView(m, [x0 - w * 0.07, y0 - hgt * 0.07, w * 1.14, hgt * 1.14]);
  }
  // 枠の中の点 (fx, fy: 枠に対する 0〜1 の位置) を動かさずに、見える範囲を k 倍にする
  function zoomAround(m, k, fx = 0.5, fy = 0.5) {
    const [x, y, w, hgt] = m.vb;
    const [minW, maxW] = widthLimits(m);
    const nw = Math.min(maxW, Math.max(minW, w * k));
    const nh = nw / aspectOf(m);
    return clampView(m, [x + fx * (w - nw), y + fy * (hgt - nh), nw, nh]);
  }

  function setView(m, vb) {
    m.vb = vb;
    m.svg.setAttribute("viewBox", vb.map((v) => v.toFixed(2)).join(" "));
    placeChips(m);
    m.onView?.();
  }

  // 範囲 target へ動かす (animate なら 0.56 秒かけて滑らかに)
  function flyTo(m, target, animate = true) {
    cancelAnimationFrame(m.anim);
    m.svg.classList.remove("animating");
    if (!animate || reducedMotion.matches || target.every((v, i) => Math.abs(v - m.vb[i]) < 0.05)) {
      setView(m, target);
      return;
    }
    const from = m.vb.slice();
    const start = performance.now();
    m.svg.classList.add("animating");
    const step = (now) => {
      const t = Math.min(1, (now - start) / 560);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      setView(m, from.map((v, i) => v + (target[i] - v) * e));
      if (t < 1) m.anim = requestAnimationFrame(step);
      else m.svg.classList.remove("animating");
    };
    m.anim = requestAnimationFrame(step);
  }

  // region を指定すればその地域へ、null なら世界全体へ寄せる
  function zoomMap(m, region, animate = true) {
    measure(m);
    flyTo(m, region ? regionView(m, region) : homeView(m), animate);
  }

  // 指 (マウス) で地図を動かし、2本指 (ホイール) で拡大縮小する。
  // m.pannable が false のとき (世界全体が見えている小さい地図) は、指1本の操作はページのスクロールやタブの切り替えに任せ、
  // 2本指の拡大縮小だけを受け付ける。動かし終わった直後のクリックは、指を離した位置の地域を選んだことにしない
  function enableGestures(m, stage, onMove) {
    const pts = new Map(); // 画面に触れている指 (pointerId → 位置)
    let base = null; // 触れたときの {vb, rect, cx, cy, d}
    let moved = false;
    let quietUntil = 0;
    const center = () => {
      const ps = [...pts.values()];
      return {
        cx: ps.reduce((n, p) => n + p.x, 0) / ps.length,
        cy: ps.reduce((n, p) => n + p.y, 0) / ps.length,
        d: ps.length > 1 ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 0,
      };
    };
    const rebase = () => {
      base = { vb: m.vb.slice(), rect: stage.getBoundingClientRect(), ...center() };
    };

    stage.addEventListener("pointerdown", (e) => {
      if ((e.pointerType === "mouse" && (e.button !== 0 || !m.pannable)) || e.target.closest("button")) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) moved = false;
      // 触れたら地図の動きを止める (指1本では動かせない地図は、2本目の指が触れたとき)
      if (m.pannable || pts.size > 1) {
        cancelAnimationFrame(m.anim);
        m.svg.classList.remove("animating");
      }
      rebase();
    });
    stage.addEventListener("pointermove", (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pts.size < 2 && !m.pannable) return;
      const now = center();
      if (!moved) {
        // 少しぶれただけ (タップ) なら、まだ地図は動かさない
        if (pts.size < 2 && Math.hypot(now.cx - base.cx, now.cy - base.cy) < 8) return;
        moved = true;
        for (const id of pts.keys()) {
          try {
            stage.setPointerCapture(id);
          } catch {}
        }
        m.svg.classList.add("moving");
        onMove?.();
      }
      const { vb: [x0, y0, w0, h0], rect } = base;
      const [minW, maxW] = widthLimits(m);
      const w = Math.min(maxW, Math.max(minW, base.d && now.d ? (w0 * base.d) / now.d : w0));
      const hgt = w / aspectOf(m);
      // 触れたときに指の下にあった地点が、いまの指の下に来るようにする
      const ax = x0 + ((base.cx - rect.left) / rect.width) * w0;
      const ay = y0 + ((base.cy - rect.top) / rect.height) * h0;
      m.next = clampView(m, [ax - ((now.cx - rect.left) / rect.width) * w, ay - ((now.cy - rect.top) / rect.height) * hgt, w, hgt]);
      // 描き直しは画面の更新1回につき1度だけ
      m.frame ||= requestAnimationFrame(() => {
        m.frame = 0;
        setView(m, m.next);
      });
    });
    const release = (e) => {
      if (!pts.delete(e.pointerId)) return;
      if (pts.size) {
        rebase(); // 2本指の片方を離したら、残った指でそのまま動かせるようにする
      } else if (moved) {
        m.svg.classList.remove("moving");
        quietUntil = performance.now() + 350;
      }
    };
    stage.addEventListener("pointerup", release);
    stage.addEventListener("pointercancel", release);
    stage.addEventListener(
      "click",
      (e) => {
        if (performance.now() < quietUntil && !e.target.closest("button")) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );
    stage.addEventListener(
      "wheel",
      (e) => {
        if (!m.pannable) return; // 小さい地図ではページのスクロールに使う
        e.preventDefault();
        const rect = stage.getBoundingClientRect();
        const k = Math.exp(e.deltaY * 0.0022);
        setView(m, zoomAround(m, k, (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height));
        onMove?.();
      },
      { passive: false },
    );
  }

  // 「世界全体」ボタンは、地図を動かしたか地域を選んでいるときだけ出す。拡大・縮小は限度に来たら押せなくする
  function updateMapControls() {
    const m = homeMap;
    const home = homeView(m);
    const reset = $("map-reset");
    const hide = !m.focus && m.vb.every((v, i) => Math.abs(v - home[i]) < 1);
    if (reset.hidden !== hide) {
      reset.hidden = hide;
      // ボタンが出たり消えたりしたら、地域名を重ねない場所を測り直す
      measure(m);
      placeChips(m);
    }
    const [minW, maxW] = widthLimits(m);
    $("map-zoom-in").disabled = m.vb[2] <= minW + 0.5;
    $("map-zoom-out").disabled = m.vb[2] >= maxW - 0.5;
    updatePannable();
  }

  // 指1本で地図を動かせるか: 大きい地図はいつも、小さい地図は拡大しているときだけ
  // (世界全体が見えているときは動かす先がないので、指はページのスクロールやタブの切り替えに使う)
  function updatePannable() {
    const on = mapSize === "large" || (!!homeMap && homeMap.vb[2] < widthLimits(homeMap)[1] - 0.5);
    $("map-stage").classList.toggle("pannable", on);
    if (homeMap) homeMap.pannable = on;
  }

  // 使い方の案内は、一度地図を動かしたら以後は出さない
  function hideMapHint() {
    const hint = $("map-hint");
    if (hint.hidden || hint.classList.contains("gone")) return;
    hint.classList.add("gone");
    store.set("mapMoved", true);
  }

  // 地図上の地域名チップ (HTML) を、SVG上のラベル位置に合わせて置く。
  // ラベル位置が枠の中なら、チップが枠からはみ出さないよう内側に寄せる。枠の外やボタンと重なる位置なら出さない
  function placeChips(m) {
    const [vx, vy, vw, vh] = m.vb;
    const [W, H] = m.size;
    const placed = [...m.chips].map(([id, chip]) => {
      const [lx, ly] = mapData.labels[id];
      const ax = ((lx - vx) / vw) * W;
      const ay = ((ly - vy) / vh) * H;
      const [hw, hh] = chip.half;
      const inside = W > 0 && ax >= 0 && ax <= W && ay >= 0 && ay <= H;
      return { chip, hw, hh, inside, cx: Math.min(W - hw - 6, Math.max(hw + 6, ax)), cy: ay };
    });
    // ボタン類と重なる地域名は横にずらす (大きく動かさないと避けられないときは出さない)
    for (const p of placed) {
      for (const [l, t, r, b] of m.covers ?? []) {
        if (!(p.cx + p.hw > l && p.cx - p.hw < r && p.cy + p.hh > t && p.cy - p.hh < b)) continue;
        const toLeft = p.cx + p.hw - l + 4;
        const toRight = r - (p.cx - p.hw) + 4;
        if (Math.min(toLeft, toRight) > 60) p.inside = false;
        else p.cx += toLeft < toRight ? -toLeft : toRight;
      }
    }
    // 重なった地域名は上下に押し分ける
    const shown = placed.filter((p) => p.inside);
    for (let pass = 0; pass < 3; pass++) {
      for (const [i, a] of shown.entries()) {
        for (const b of shown.slice(i + 1)) {
          const ox = Math.min(a.cx + a.hw, b.cx + b.hw) - Math.max(a.cx - a.hw, b.cx - b.hw);
          const oy = Math.min(a.cy + a.hh, b.cy + b.hh) - Math.max(a.cy - a.hh, b.cy - b.hh);
          if (ox <= 0 || oy <= 0) continue;
          const d = (oy + 3) / 2;
          const [upper, lower] = a.cy <= b.cy ? [a, b] : [b, a];
          upper.cy -= d;
          lower.cy += d;
        }
      }
    }
    for (const { chip, hw, hh, inside, cx, cy: rawY } of placed) {
      const cy = Math.min(H - hh - 6, Math.max(hh + 6, rawY));
      chip.style.left = `${cx}px`;
      chip.style.top = `${cy}px`;
      const covered = (m.covers ?? []).some(([l, t, r, b]) => cx + hw > l && cx - hw < r && cy + hh > t && cy - hh < b);
      chip.classList.toggle("off", !inside || covered);
    }
    if (W) m.pin.setAttribute("r", ((PIN_PX * vw) / W).toFixed(2));
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
          draggable: "false",
          "aria-label": `${r.name} 話題のニュース${r.items.length}件`,
        },
        h("i", { class: "chip-dot", style: `background:${heatColor(r.heat)}` }),
        h("span", {}, r.name),
        r.items.length ? h("b", {}, String(r.items.length)) : null,
      );
      layer.append(chip);
      m.chips.set(id, chip);
    }
    // チップの大きさは置き直すたびに測ると重いので、作ったときにまとめて測っておく
    for (const chip of m.chips.values()) chip.half = [chip.offsetWidth / 2 || 30, chip.offsetHeight / 2 || 12];
    placeChips(m);
  }

  // ---- ホーム (地図と地域カード) ----

  function renderHome(sideRegion) {
    const isWide = wide.matches;
    const selected = isWide ? route.region : null;
    paintMap(homeMap, selected);
    renderChips(homeMap, $("map-chips"), selected);

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
    if (parts[0] === "matome" || parts[0] === "settings") return { view: parts[0], region: null, article: null };
    const region = REGION_ORDER.includes(parts[1]) ? parts[1] : null;
    return { view: "world", region, article: region ? parts[2] || null : null };
  }

  // 画面ごとのスクロール位置 (どのタブも同じページのスクロールを使うので、切り替えるときに覚えておく)
  const scrollPos = { world: 0, matome: 0, settings: 0 };
  let shownView = null;

  function showView() {
    if (shownView === route.view) return;
    const before = shownView;
    if (before) scrollPos[before] = window.scrollY;
    const isWorld = route.view === "world";
    for (const [view, id] of Object.entries(VIEW_IDS)) $(id).hidden = view !== route.view;
    document.documentElement.dataset.view = route.view;
    for (const a of document.querySelectorAll("#tabbar a")) {
      if (a.dataset.tab === route.view) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    if (!isWorld) document.body.classList.remove("w-overlay");
    window.scrollTo(0, scrollPos[route.view]);
    shownView = route.view;
    finishLeaving();
    // 新しい画面は、タブの並びの方向から滑り込ませる (狭い画面で地域の一覧が全面に開く場合は除く)
    if (before && !reducedMotion.matches && !(isWorld && route.region && !wide.matches)) {
      const dir = TAB_ORDER.indexOf(route.view) > TAB_ORDER.indexOf(before) ? 1 : -1;
      viewEl(route.view).animate(
        [{ transform: `translateX(${dir * 48}px)`, opacity: 0 }, { transform: "none", opacity: 1 }],
        { duration: 240, easing: "cubic-bezier(.2, .8, .2, 1)" },
      );
    }
  }

  function renderRoute() {
    showView();
    if (route.view !== "world" || !world || !mapData) return;
    const isWide = wide.matches;
    // 広い画面では右側を空けず、地域を選ぶ前は一番話題の地域を出しておく
    const sideRegion = route.region ?? (isWide ? hottestRegion() : null);
    renderHome(sideRegion);
    // 広い画面では選んだ地域へ地図を寄せる。狭い画面の地図は、指で動かした位置のままにする
    const focus = isWide ? route.region : null;
    if (homeMap.focus !== focus) {
      const first = homeMap.focus === undefined;
      homeMap.focus = focus;
      zoomMap(homeMap, focus, !first);
    }

    const side = $("w-side");
    const open = !!sideRegion;
    const opening = open && !sideWasOpen;
    sideWasOpen = open;
    side.classList.toggle("open", open);
    side.inert = !open;
    $("w-home").inert = !isWide && open;
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
    if (hash === location.hash) {
      // 選んでいる地域をもう一度選んだら、動かした地図をその地域に戻す
      if (homeMap?.focus) zoomMap(homeMap, homeMap.focus);
      return;
    }
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

  // ---- 下のタブ (タップ・左右のスワイプで切り替え) ----

  // タブを切り替える。直前の履歴がそのタブなら「戻る」で切り替え、タブを行き来しても履歴が積み重ならないようにする
  function switchTab(tab) {
    const prev = idx > 0 ? entries[idx - 1] : null;
    if (prev && parseHash(prev).view === tab) history.back();
    else navigate(`#/${tab}`);
  }

  for (const a of document.querySelectorAll("#tabbar a")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const tab = a.dataset.tab;
      if (tab === route.view) {
        const behavior = reducedMotion.matches ? "auto" : "smooth";
        window.scrollTo({ top: 0, behavior });
        // 広い画面では左側だけがスクロールする (地図「大」は地域カード、「小」は見出しから地域カードまで)
        if (tab === "world") for (const id of ["w-main", "w-home"]) $(id).scrollTo({ top: 0, behavior });
        return;
      }
      switchTab(tab);
    });
  }

  // 画面を左右にスワイプしてタブを切り替える。画面は指に合わせて動き、十分に動かすか素早く払うと切り替わる。
  // 地図 (指で動かす)・横にスクロールする場所 (まとめのカテゴリ)・入力欄から始めたときや、
  // 地域・記事 (狭い画面)・リーダーの画面が開いているときは使わない
  let swipe = null; // {x, y, axis, dx, trail: [[時刻, dx], ...]}

  function swipeBlocked(target) {
    if (document.body.classList.contains("w-overlay") || !$("reader").hidden) return true;
    for (let el = target; el && el !== document.body; el = el.parentElement) {
      if (el.matches(".map-stage.pannable, input, textarea")) return true;
      if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
    }
    return false;
  }
  // 指を動かした向きにあるタブ (左へ払うと右隣のタブ)
  const swipeTarget = (dx) => TAB_ORDER[TAB_ORDER.indexOf(route.view) + (dx < 0 ? 1 : -1)] ?? null;
  // ここまで動かせば切り替わる距離 (画面幅の約3割。開いた折りたたみなど広い画面でも親指で届く長さまで)
  const swipeDistance = () => Math.min(document.documentElement.clientWidth * 0.28, 160);

  // 下のタブの色の付いた丸を、今のタブから切り替え先へ p (0〜1) だけ移す
  function setPills(from, to, p) {
    for (const a of document.querySelectorAll("#tabbar a")) {
      const v = a.dataset.tab === from ? 1 - p : a.dataset.tab === to ? p : 0;
      a.querySelector(".tab-ic").style.setProperty("--pill", v.toFixed(3));
    }
  }
  function clearPills() {
    $("tabbar").classList.remove("dragging");
    for (const ic of document.querySelectorAll("#tabbar .tab-ic")) ic.style.removeProperty("--pill");
  }

  window.addEventListener(
    "touchstart",
    (e) => {
      if (swipe?.axis === "x") finishSwipe(null); // 途中で2本目の指が触れたら取りやめる
      swipe = null;
      if (e.touches.length !== 1 || leaving || swipeBlocked(e.target)) return;
      swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, axis: null, dx: 0, trail: [] };
    },
    { passive: true },
  );
  window.addEventListener(
    "touchmove",
    (e) => {
      if (!swipe || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - swipe.x;
      const dy = e.touches[0].clientY - swipe.y;
      if (!swipe.axis) {
        if (Math.hypot(dx, dy) < 10) return;
        // 最初に大きく動いた向きで、横のスワイプか縦のスクロールかを決める
        swipe.axis = Math.abs(dx) > Math.abs(dy) * 1.3 ? "x" : "y";
        if (swipe.axis === "y") {
          swipe = null;
          return;
        }
        viewEl(route.view).style.willChange = "transform";
        $("tabbar").classList.add("dragging");
      }
      const now = performance.now();
      swipe.dx = dx;
      swipe.trail.push([now, dx]);
      while (swipe.trail.length > 2 && now - swipe.trail[0][0] > 100) swipe.trail.shift();
      // 切り替え先がある向きは指に合わせて動かし、ない向き (端のタブ) はゴムのように少しだけ動かす
      const to = swipeTarget(dx);
      const p = to ? Math.min(1, Math.abs(dx) / (swipeDistance() * 1.8)) : 0;
      const el = viewEl(route.view);
      el.style.transform = `translateX(${to ? dx * 0.6 : Math.sign(dx) * Math.min(36, Math.abs(dx) * 0.18)}px)`;
      el.style.opacity = String(1 - p * 0.35);
      setPills(route.view, to, p);
    },
    { passive: true },
  );
  window.addEventListener(
    "touchend",
    () => {
      if (swipe?.axis !== "x") {
        swipe = null;
        return;
      }
      const { dx, trail } = swipe;
      const [t0, x0] = trail[0];
      const [t1, x1] = trail[trail.length - 1];
      const v = t1 > t0 ? (x1 - x0) / (t1 - t0) : 0; // 指を離す直前の速さ (px/ms)
      const to = swipeTarget(dx);
      const far = Math.abs(dx) > swipeDistance();
      const flick = Math.abs(v) > 0.45 && Math.abs(dx) > 40 && Math.sign(v) === Math.sign(dx);
      finishSwipe(to && (far || flick) ? to : null);
    },
    { passive: true },
  );
  window.addEventListener(
    "touchcancel",
    () => {
      if (swipe?.axis === "x") finishSwipe(null);
      swipe = null;
    },
    { passive: true },
  );

  // スワイプを終える。to があれば今の画面を指の向きへ送り出してから切り替え、なければ元の位置へ戻す
  function finishSwipe(to) {
    const el = viewEl(route.view);
    const from = { transform: el.style.transform || "none", opacity: el.style.opacity || "1" };
    const dir = Math.sign(swipe.dx) || 1;
    swipe = null;
    el.style.transform = "";
    el.style.opacity = "";
    el.style.willChange = "";
    if (!to) {
      clearPills();
      if (!reducedMotion.matches) el.animate([from, { transform: "none", opacity: 1 }], { duration: 200, easing: "cubic-bezier(.2, .8, .2, 1)" });
      return;
    }
    $("tabbar").classList.remove("dragging");
    setPills(route.view, to, 1);
    // 送り出した状態のまま切り替わるのを待つ (「戻る」で切り替えるときは少し遅れて切り替わるため)
    const anim = el.animate([from, { transform: `translateX(${dir * document.documentElement.clientWidth * 0.35}px)`, opacity: 0 }], {
      duration: reducedMotion.matches ? 0 : 150,
      easing: "ease-in",
      fill: "forwards",
    });
    leaving = { anim, timer: setTimeout(finishLeaving, 900) };
    anim.onfinish = () => switchTab(to);
  }

  // 送り出した画面の後始末 (切り替わったとき、または切り替わらずに時間が過ぎたとき)
  function finishLeaving() {
    if (!leaving) return;
    clearTimeout(leaving.timer);
    leaving.anim.cancel();
    leaving = null;
    clearPills();
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && route.view === "world" && (route.article || (route.region && !wide.matches))) goBack();
  });
  wide.addEventListener("change", () => renderRoute());

  // ---- データ取得 ----

  async function loadWorld(manual = false) {
    const btn = $("w-refresh");
    btn.classList.add("spinning");
    try {
      if (!mapData) {
        const res = await fetch("./world-map.json");
        if (!res.ok) throw new Error(`map HTTP ${res.status}`);
        mapData = await res.json();
        homeMap = createMap($("world-map"), "home");
        homeMap.svg.addEventListener("click", (e) => {
          const id = e.target.closest?.(".m-region")?.dataset.region;
          if (id) navigate(`#/world/${id}`);
        });
        homeMap.onView = updateMapControls;
        homeMap.overlays = $("map-stage").closest(".map-card").querySelectorAll(".map-legend, .map-size, .map-zoom, .map-reset");
        updatePannable();
        enableGestures(homeMap, $("map-stage"), hideMapHint);
        // 枠の大きさが変わったら (画面の回転・折りたたみの開閉・タブの切り替え)、見ていた範囲を枠に合わせ直す
        new ResizeObserver(() => {
          if (!$("map-stage").offsetWidth) return; // ほかのタブを表示中で隠れているときは何もしない
          measure(homeMap);
          if (homeMap.refit) {
            // 設定で地図の大きさを変えたあと: 新しい枠の形で、世界全体 (選んでいる地域) を見せ直す
            homeMap.refit = false;
            zoomMap(homeMap, homeMap.focus ?? null, false);
          } else {
            setView(homeMap, clampView(homeMap, homeMap.vb));
          }
        }).observe($("map-stage"));
        $("map-hint").hidden = store.get("mapMoved", false);
        paintSizeArt();
      }
      const res = await fetch(`./world.json?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      world = await res.json();
      lastFetched = Date.now();
      $("w-updated").textContent = `${fmtTime(world.updated)} 更新`;
      $("w-status").hidden = true;
      renderRoute();
      paintSizeArt();
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
  $("map-reset").addEventListener("click", () => {
    if (homeMap?.focus) navigate("#/world");
    else if (homeMap) flyTo(homeMap, homeView(homeMap));
  });
  // 地図の大きさ ("large": 画面上部の幅いっぱい / "small": 世界全体が見えるカード)。地図の下のボタンと設定の画面で選ぶ
  function applyMapSize() {
    $("view-world").dataset.map = mapSize;
    for (const b of $("map-size").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.size === mapSize));
    for (const input of document.querySelectorAll('input[name="map-size"]')) input.checked = input.value === mapSize;
    updatePannable();
  }
  function setMapSize(size) {
    if (size === mapSize) return;
    mapSize = size;
    store.set("mapSize", mapSize);
    applyMapSize();
    if (!homeMap) return;
    renderRoute(); // 地域名の大きさが変わるので作り直す
    // 枠の形が変わるので、世界全体 (選んでいる地域) を見せ直す。ほかのタブで選んだときは、ワールドに戻ったときに
    if (route.view === "world") zoomMap(homeMap, homeMap.focus ?? null, false);
    else homeMap.refit = true;
  }
  for (const b of $("map-size").querySelectorAll("button")) b.addEventListener("click", () => setMapSize(b.dataset.size));
  for (const input of document.querySelectorAll('input[name="map-size"]')) input.addEventListener("change", () => setMapSize(input.value));
  applyMapSize();

  // 設定の画面の「地図の大きさ」の見本に、地図の形と今の話題の色を入れる
  function paintSizeArt() {
    for (const g of document.querySelectorAll(".art-map")) {
      if (!g.firstChild) for (const id of REGION_ORDER) g.append(svgEl("path", { d: mapData.regions[id], "data-region": id }));
      for (const p of g.children) p.setAttribute("fill", heatColor(regionOf(p.dataset.region).heat));
    }
  }

  $("map-zoom-in").addEventListener("click", () => homeMap && flyTo(homeMap, zoomAround(homeMap, 1 / ZOOM_STEP)));
  $("map-zoom-out").addEventListener("click", () => homeMap && flyTo(homeMap, zoomAround(homeMap, ZOOM_STEP)));
  $("map-zoom-in").innerHTML = ICONS.plus;
  $("map-zoom-out").innerHTML = ICONS.minus;
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
    view: () => route.view, // 表示中のタブ ("world" / "matome" / "settings")
    isActive: () => route.view === "world",
    // 地域や記事の画面が全面に重なっている (引っ張って更新を効かせない)
    overlayOpen: () => document.body.classList.contains("w-overlay"),
    refresh: () => loadWorld(true),
    // 指で動かせる地図を、上の端に着くまでに指を下へ何px動かせるか (引っ張って更新は、その先の引っ張りで判定する)
    mapPullSlack: () => {
      if (!homeMap) return 0;
      const h = $("map-stage").getBoundingClientRect().height;
      return Math.max(0, ((homeMap.vb[1] - mapData.viewBox[1]) / homeMap.vb[3]) * h);
    },
  };

  // この履歴に番号を付けて始める (再読み込みでは番号が残る)
  idx = Number.isInteger(history.state?.idx) ? history.state.idx : 0;
  history.replaceState({ ...history.state, idx }, "", location.hash || "#/world");
  entries[idx] = location.hash;
  route = parseHash();
  showView();
  loadWorld();
})();
