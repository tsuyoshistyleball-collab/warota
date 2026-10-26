"use strict";

// 雨雲レーダー: 気象庁の「雨雲の動き」(高解像度降水ナウキャスト) を国土地理院の地図に重ねて、全画面で見せる。
// 1時間前から1時間後まで5分ごと。指で動かす・2本指で拡大縮小・再生ができ、戻る操作で閉じる
(() => {
  const TILE = 256; // 地図の画像1枚の大きさ (px)
  const MIN_Z = 5; // 倍率 (大きいほど拡大。1つ上がると2倍)
  const MAX_Z = 12;
  const HOME_Z = 9; // 現在地のまわり約100km
  const JMA = "https://www.jma.go.jp/bosai/jmatile/data/nowc/";
  const baseUrl = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/pale/${z}/${x}/${y}.png`;
  const rainUrl = (f, z, x, y) => `${JMA}${f.basetime}/none/${f.validtime}/surf/hrpns/${z}/${x}/${y}.png`;
  // 雨雲の画像は倍率 4・6・8・10 にだけあるので、間の倍率では1つ下の画像を2倍に伸ばして使う
  const rainZoom = (z) => Math.min(10, Math.max(4, z - (z % 2)));
  // 地図を動かせる範囲 (日本のまわり)
  const BOUNDS = { n: 47, s: 20, w: 122, e: 154 };
  // 雨の強さの色 (気象庁と同じ)。数字は色の境目 (1時間あたりの mm)
  const LEGEND = ["#f2f2ff", "#a0d2ff", "#218cff", "#0041ff", "#faf500", "#ff9900", "#ff2800", "#b40068"];
  const LEGEND_NUMS = [1, 5, 10, 20, 30, 50, 80];
  const ICON = {
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>',
    here: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fill" d="M8 5.5v13l11-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fill" d="M7 5h3.6v14H7zM13.4 5H17v14h-3.4z"/></svg>',
  };

  // メルカトル図法: 緯度経度 ⇔ 倍率 z の世界地図全体での位置 (px)
  function toPx(lat, lon, z) {
    const n = TILE * 2 ** z;
    const s = Math.sin((lat * Math.PI) / 180);
    return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const hhmm = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  // 気象庁の時刻 "20261026053000" (世界時) → Date
  const timeOf = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  let root = null; // 全画面の表示 (最初に開いたときに作る)
  const els = {};
  const view = { z: HOME_Z, x: 0, y: 0 }; // 地図の真ん中 (倍率 z での位置)
  let me = null; // 現在地 { lat, lon }
  let frames = []; // 時刻の一覧 [{ basetime, validtime, time }] (古い順)
  let nowFrame = 0; // 一番新しい実況 (今)
  let frame = 0; // 表示中の時刻
  let reloadTimer = 0;
  let playing = false;
  let playToken = 0;
  let returnFocus = null;
  const layers = {}; // base / rain: { el, imgs: Map(キー → img) }
  const preloaded = new Map(); // 再生のために先に読んでおく雨雲の画像 (URL → Image)

  function build() {
    root = document.createElement("div");
    root.className = "rd";
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "rd-title");
    const step = 100 / LEGEND.length;
    root.innerHTML = `
      <div class="rd-map" tabindex="0" aria-label="雨雲の地図。指で動かし、2本指で広げると拡大します">
        <div class="rd-pane">
          <div class="rd-layer rd-base"></div>
          <div class="rd-layer rd-rain"></div>
          <i class="rd-me" hidden></i>
        </div>
      </div>
      <header class="rd-bar">
        <button type="button" class="rd-btn rd-close" aria-label="閉じる">${ICON.close}</button>
        <div>
          <h2 id="rd-title">雨雲レーダー</h2>
          <p class="rd-time" aria-live="polite">読み込み中…</p>
        </div>
      </header>
      <div class="rd-zoom">
        <button type="button" class="rd-btn" data-zoom="1" aria-label="拡大">${ICON.plus}</button>
        <button type="button" class="rd-btn" data-zoom="-1" aria-label="縮小">${ICON.minus}</button>
        <button type="button" class="rd-btn rd-here" aria-label="現在地に戻る">${ICON.here}</button>
      </div>
      <footer class="rd-ctrl">
        <p class="rd-msg" hidden></p>
        <div class="rd-row">
          <button type="button" class="rd-btn rd-play" aria-label="再生">${ICON.play}</button>
          <div class="rd-track">
            <input class="rd-slider" type="range" min="0" max="0" value="0" aria-label="時刻 (左が1時間前、右が1時間後)">
            <div class="rd-ticks" aria-hidden="true"><span>1時間前</span><span class="rd-tick-now">今</span><span>1時間後</span></div>
          </div>
        </div>
        <div class="rd-legend" role="img" aria-label="雨の強さの色: 薄い水色は1時間に1mm未満、青は10〜20mm、黄色は20〜30mm、赤は50〜80mm、紫は80mm以上">
          <div class="rd-legend-scale">
            <span class="rd-legend-bar">${LEGEND.map((c) => `<i style="background:${c}"></i>`).join("")}</span>
            <span class="rd-legend-nums">${LEGEND_NUMS.map((n, i) => `<span style="left:${(step * (i + 1)).toFixed(2)}%">${n}</span>`).join("")}</span>
          </div>
          <span class="rd-legend-unit">mm/時</span>
        </div>
        <p class="rd-attr">雨雲: <a href="https://www.jma.go.jp/bosai/nowc/" target="_blank" rel="noopener">気象庁</a>
          / 地図: <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a></p>
      </footer>`;
    document.body.append(root);
    for (const [k, sel] of Object.entries({
      map: ".rd-map", pane: ".rd-pane", me: ".rd-me", time: ".rd-time", slider: ".rd-slider", play: ".rd-play",
      msg: ".rd-msg", now: ".rd-tick-now", close: ".rd-close",
    })) {
      els[k] = root.querySelector(sel);
    }
    layers.base = { el: root.querySelector(".rd-base"), imgs: new Map() };
    layers.rain = { el: root.querySelector(".rd-rain"), imgs: new Map() };

    els.close.onclick = () => history.back();
    els.play.onclick = () => setPlaying(!playing);
    els.slider.addEventListener("input", () => {
      setPlaying(false);
      setFrame(Number(els.slider.value));
    });
    for (const b of root.querySelectorAll("[data-zoom]")) b.onclick = () => zoomBy(Number(b.dataset.zoom));
    root.querySelector(".rd-here").onclick = () => {
      home();
      draw();
    };
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") history.back();
    });
    els.map.addEventListener("keydown", (e) => {
      const pan = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (pan) {
        e.preventDefault();
        view.x += pan[0] * 100;
        view.y += pan[1] * 100;
        clampView();
        draw();
      } else if (e.key === "+" || e.key === "=" || e.key === "-") {
        e.preventDefault();
        zoomBy(e.key === "-" ? -1 : 1);
      }
    });
    // アプリの「左右に払ってタブを切り替える」「下に引っ張って更新」に、地図を動かす指の動きを渡さない
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      root.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
    }
    gestures();
    window.addEventListener("resize", () => {
      if (!root.hidden) draw();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) setPlaying(false);
    });
  }

  // ---- 開く・閉じる ----
  function open(lat, lon) {
    if (!root) build();
    if (!root.hidden) return;
    me = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    returnFocus = document.activeElement;
    root.hidden = false;
    document.body.classList.add("noscroll");
    history.pushState({ radar: true }, "");
    home();
    draw();
    els.close.focus({ preventScroll: true });
    loadFrames();
    reloadTimer = setInterval(() => loadFrames(), 5 * 60 * 1000); // 開いている間も新しい雨雲に入れ替える
  }
  function close() {
    setPlaying(false);
    clearInterval(reloadTimer);
    root.hidden = true;
    document.body.classList.remove("noscroll");
    preloaded.clear();
    returnFocus?.focus?.({ preventScroll: true }); // ページを動かさずに、開いたボタンへ戻す
  }
  window.addEventListener("popstate", () => {
    if (root && !root.hidden) close();
  });

  // 現在地 (分からなければ日本全体) を真ん中に
  function home() {
    const [lat, lon, z] = me ? [me.lat, me.lon, HOME_Z] : [36.5, 137.5, MIN_Z];
    view.z = z;
    [view.x, view.y] = toPx(lat, lon, z);
    clampView();
  }
  function clampView() {
    const [x0, y0] = toPx(BOUNDS.n, BOUNDS.w, view.z);
    const [x1, y1] = toPx(BOUNDS.s, BOUNDS.e, view.z);
    view.x = clamp(view.x, x0, x1);
    view.y = clamp(view.y, y0, y1);
  }

  // ---- 時刻の一覧 ----
  async function loadFrames() {
    try {
      const [past, ahead] = await Promise.all(
        ["N1", "N2"].map(async (n) => {
          const res = await fetch(`${JMA}targetTimes_${n}.json`, { cache: "no-cache" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return (await res.json()).filter((t) => t.elements?.includes("hrpns"));
        }),
      );
      const byTime = (a, b) => a.validtime.localeCompare(b.validtime);
      const seen = past.sort(byTime).slice(-13); // 1時間前〜今 (5分ごと)
      const latest = seen.at(-1);
      if (!latest) throw new Error("no frames");
      // 予報は、一番新しい実況から先の1時間 (同じ時刻に作られたもの)
      const base = ahead.reduce((m, t) => (t.basetime > m ? t.basetime : m), "");
      const next = ahead.filter((t) => t.basetime === base && t.validtime > latest.validtime).sort(byTime).slice(0, 12);
      const keep = frames[frame] && frame !== nowFrame ? frames[frame].validtime : null;
      frames = [...seen, ...next].map((t) => ({ basetime: t.basetime, validtime: t.validtime, time: timeOf(t.validtime) }));
      nowFrame = seen.length - 1;
      els.slider.max = String(frames.length - 1);
      els.now.style.left = `${((nowFrame / Math.max(1, frames.length - 1)) * 100).toFixed(1)}%`;
      els.msg.hidden = true;
      // 見ていた時刻がまだ一覧にあればそのまま、なければ「今」
      const again = keep ? frames.findIndex((f) => f.validtime === keep) : -1;
      setFrame(again >= 0 ? again : nowFrame);
    } catch {
      els.msg.textContent = "雨雲の情報を取得できませんでした。通信状態を確かめて、開き直してください。";
      els.msg.hidden = false;
      if (!frames.length) els.time.textContent = "—";
    }
  }

  function setFrame(i) {
    const f = frames[i];
    if (!f) return;
    frame = i;
    els.slider.value = String(i);
    const mins = Math.round((f.time - frames[nowFrame].time) / 60000);
    const kind = mins > 0 ? "予報" : "実況";
    const rel = mins === 0 ? "今" : mins < 0 ? `${-mins}分前` : `${mins}分後`;
    els.time.innerHTML = `<b>${hhmm(f.time)}</b> <span class="rd-kind${mins > 0 ? " ahead" : ""}">${kind}</span> ${rel}`;
    els.slider.setAttribute("aria-valuetext", `${hhmm(f.time)} ${kind} ${rel}`);
    drawRain();
  }

  // ---- 再生 ----
  function setPlaying(on) {
    playing = on && frames.length > 1;
    playToken++;
    els.play.innerHTML = playing ? ICON.pause : ICON.play;
    els.play.setAttribute("aria-label", playing ? "一時停止" : "再生");
    if (playing) step(playToken);
  }
  async function step(token) {
    const next = frame >= frames.length - 1 ? 0 : frame + 1;
    // 次の時刻の雨雲の画像がそろってから切り替える (遅いときは2秒で先へ)
    await Promise.race([preload(next), wait(2000)]);
    if (token !== playToken) return;
    setFrame(next);
    // 「今」と最後の時刻では少し長く止める
    await wait(next === frames.length - 1 ? 1500 : next === nowFrame ? 1000 : 450);
    if (token === playToken) step(token);
  }
  function preload(i) {
    const f = frames[i];
    const z = rainZoom(view.z);
    return Promise.all(
      tilesInView(z).map(({ tx, ty }) => {
        const url = rainUrl(f, z, tx, ty);
        let im = preloaded.get(url);
        if (!im) {
          im = new Image();
          im.src = url;
          preloaded.set(url, im);
        }
        return im.complete ? null : new Promise((r) => {
          im.addEventListener("load", r, { once: true });
          im.addEventListener("error", r, { once: true });
        });
      }),
    );
  }

  // ---- 地図を描く ----
  // 倍率 lz の画像のうち、画面に入るもの (今の倍率で出す大きさ size と、画面の左上からの位置)
  function tilesInView(lz) {
    const w = els.map.clientWidth;
    const h = els.map.clientHeight;
    const size = TILE * 2 ** (view.z - lz);
    const left = view.x - w / 2;
    const top = view.y - h / 2;
    const last = 2 ** lz - 1;
    const out = [];
    for (let ty = Math.max(0, Math.floor(top / size)); ty <= Math.min(last, Math.floor((top + h) / size)); ty++) {
      for (let tx = Math.max(0, Math.floor(left / size)); tx <= Math.min(last, Math.floor((left + w) / size)); tx++) {
        out.push({ tx, ty, size, x: tx * size - left, y: ty * size - top });
      }
    }
    return out;
  }
  function place(layer, lz, url) {
    const want = new Set();
    for (const t of tilesInView(lz)) {
      const key = `${lz}/${t.tx}/${t.ty}`;
      want.add(key);
      let img = layer.imgs.get(key);
      if (!img) {
        img = document.createElement("img");
        img.alt = "";
        img.decoding = "async";
        img.draggable = false;
        img.onload = () => img.classList.remove("rd-miss");
        img.onerror = () => img.classList.add("rd-miss");
        layer.el.append(img);
        layer.imgs.set(key, img);
      }
      const src = url(lz, t.tx, t.ty);
      if (src && img.dataset.src !== src) {
        img.dataset.src = src;
        img.src = src; // 新しい画像が届くまでは前の画像が見えたまま
      }
      img.style.cssText = `width:${t.size}px;height:${t.size}px;transform:translate(${t.x}px,${t.y}px)`;
    }
    for (const [key, img] of layer.imgs) {
      if (!want.has(key)) {
        img.remove();
        layer.imgs.delete(key);
      }
    }
  }
  function drawRain() {
    const f = frames[frame];
    place(layers.rain, rainZoom(view.z), (z, x, y) => f && rainUrl(f, z, x, y));
  }
  function draw() {
    place(layers.base, view.z, baseUrl);
    drawRain();
    els.me.hidden = !me;
    if (me) {
      const [mx, my] = toPx(me.lat, me.lon, view.z);
      els.me.style.transform = `translate(${mx - view.x + els.map.clientWidth / 2}px,${my - view.y + els.map.clientHeight / 2}px)`;
    }
  }
  let frameReq = 0;
  const drawSoon = () => {
    if (!frameReq) {
      frameReq = requestAnimationFrame(() => {
        frameReq = 0;
        draw();
      });
    }
  };

  // 画面の点 from (地図の左上からの px) にある場所を、倍率を dz 変えたあと to に持ってくる
  function zoomAround(dz, from, to = from) {
    const w = els.map.clientWidth;
    const h = els.map.clientHeight;
    const k = 2 ** dz;
    const px = (view.x - w / 2 + from[0]) * k;
    const py = (view.y - h / 2 + from[1]) * k;
    view.z += dz;
    view.x = px - to[0] + w / 2;
    view.y = py - to[1] + h / 2;
    clampView();
    draw();
  }
  function zoomBy(dz) {
    const d = clamp(dz, MIN_Z - view.z, MAX_Z - view.z);
    if (d) zoomAround(d, [els.map.clientWidth / 2, els.map.clientHeight / 2]);
  }

  // ---- 指・マウスで動かす ----
  function gestures() {
    const map = els.map;
    const pts = new Map(); // 触れている指 (pointerId → [x, y])
    let pinch = null; // 2本指: { d0, m0, m, s }
    const local = (e) => {
      const r = map.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const two = () => {
      const [a, b] = [...pts.values()];
      return { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    };
    map.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      map.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, local(e));
      if (pts.size === 2) {
        const { d, m } = two();
        pinch = { d0: d, m0: m, m, s: 1 };
      }
    });
    map.addEventListener("pointermove", (e) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      const cur = local(e);
      pts.set(e.pointerId, cur);
      if (pinch && pts.size >= 2) {
        // 広げている間は今の画像をそのまま拡大して見せ、指を離したら近い倍率で描き直す
        const { d, m } = two();
        pinch.m = m;
        pinch.s = clamp(d / pinch.d0, 2 ** (MIN_Z - view.z - 0.5), 2 ** (MAX_Z - view.z + 0.5));
        els.pane.style.transformOrigin = `${pinch.m0[0]}px ${pinch.m0[1]}px`;
        els.pane.style.transform = `translate(${m[0] - pinch.m0[0]}px,${m[1] - pinch.m0[1]}px) scale(${pinch.s})`;
      } else if (pts.size === 1) {
        view.x -= cur[0] - prev[0];
        view.y -= cur[1] - prev[1];
        clampView();
        drawSoon();
      }
    });
    const up = (e) => {
      if (!pts.delete(e.pointerId) || !pinch || pts.size >= 2) return;
      const { s, m0, m } = pinch;
      pinch = null;
      els.pane.style.transform = "";
      zoomAround(clamp(Math.round(Math.log2(s)), MIN_Z - view.z, MAX_Z - view.z), m0, m);
    };
    map.addEventListener("pointerup", up);
    map.addEventListener("pointercancel", up);
    // パソコン: ホイールで拡大・縮小
    let lastWheel = 0;
    map.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (e.timeStamp - lastWheel < 250) return;
        lastWheel = e.timeStamp;
        const d = clamp(e.deltaY < 0 ? 1 : -1, MIN_Z - view.z, MAX_Z - view.z);
        if (d) zoomAround(d, local(e));
      },
      { passive: false },
    );
  }

  window.Radar = { open };
})();
