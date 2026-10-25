"use strict";

// 天気のタブ: 現在地の天気予報と、気象庁の警報・注意報。
// 予報は Open-Meteo (無料・キー不要。日本では気象庁のモデルなどを使う)、住所は国土地理院の逆ジオコーダー、
// 警報・注意報は気象庁のデータを、どれもブラウザから直接読む (アプリのサーバーを通さない)
(() => {
  const $ = (id) => document.getElementById(id);
  const body = $("wx-body");
  const KEY = "weatherCache";
  const STALE_MS = 15 * 60 * 1000; // これより古ければ、タブを開いたときに取り直す

  // ---- 保存 ----
  let cache = null; // { at, lat, lon, place, fc, warn }
  try {
    cache = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {}
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(cache));
    } catch {}
  };

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---- 天気の種類 (WMO の天気コード → 日本語・アイコン) ----
  const WMO = {
    0: ["晴れ", "clear"], 1: ["晴れ", "clear"], 2: ["晴れ時々くもり", "partly"], 3: ["くもり", "cloudy"],
    45: ["霧", "fog"], 48: ["霧", "fog"],
    51: ["霧雨", "drizzle"], 53: ["霧雨", "drizzle"], 55: ["霧雨", "drizzle"], 56: ["みぞれ", "sleet"], 57: ["みぞれ", "sleet"],
    61: ["小雨", "drizzle"], 63: ["雨", "rain"], 65: ["強い雨", "heavy"], 66: ["みぞれ", "sleet"], 67: ["みぞれ", "sleet"],
    71: ["小雪", "snow"], 73: ["雪", "snow"], 75: ["大雪", "snow"], 77: ["雪", "snow"],
    80: ["にわか雨", "shower"], 81: ["にわか雨", "shower"], 82: ["激しいにわか雨", "heavy"],
    85: ["にわか雪", "snow"], 86: ["強いにわか雪", "snow"],
    95: ["雷雨", "thunder"], 96: ["ひょうを伴う雷雨", "thunder"], 99: ["ひょうを伴う雷雨", "thunder"],
  };
  const kindOf = (code) => WMO[code] ?? ["—", "cloudy"];

  // アイコン (48×48)。夜は太陽の代わりに月
  const C = { sun: "#f5a623", moon: "#f2c14e", cloud: "#cfd5dd", cloudDark: "#a9b2bd", rain: "#2f7fd8", snow: "#8bb8e8", bolt: "#f2b705" };
  const sun = (x, y, r) => {
    let rays = "";
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const p = (d) => `${(x + Math.cos(a) * d).toFixed(1)} ${(y + Math.sin(a) * d).toFixed(1)}`;
      rays += `M${p(r + 3)}L${p(r + 6.5)}`;
    }
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${C.sun}"/><path d="${rays}" stroke="${C.sun}" stroke-width="2.6" stroke-linecap="round"/>`;
  };
  const moon = (x, y, r) =>
    `<path d="M${x + r * 0.35} ${y - r}a${r} ${r} 0 1 0 ${r * 0.65} ${r * 1.72}A${r * 0.82} ${r * 0.82} 0 0 1 ${x + r * 0.35} ${y - r}z" fill="${C.moon}"/>`;
  const cloud = (dy = 0, fill = C.cloud) =>
    `<g fill="${fill}" transform="translate(0 ${dy})"><circle cx="17" cy="29" r="7"/><circle cx="26.5" cy="24" r="9.5"/>` +
    `<circle cx="35" cy="30" r="6"/><rect x="17" y="29" width="18" height="7"/></g>`;
  const drops = (n) =>
    `<path d="${[[17, 39], [25, 39], [33, 39], [21, 44], [29, 44]].slice(0, n).map(([x, y]) => `M${x} ${y}l-2 4`).join("")}" stroke="${C.rain}" stroke-width="2.6" stroke-linecap="round"/>`;
  const flakes = () => [[18, 41], [26, 43], [34, 41]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.3" fill="${C.snow}"/>`).join("");
  function icon(type, night = false) {
    const orb = (x, y, r) => (night ? moon(x, y, r) : sun(x, y, r));
    let g;
    switch (type) {
      case "clear": g = orb(24, 24, 9); break;
      case "partly": g = orb(17, 17, 7) + cloud(4); break;
      case "cloudy": g = cloud(-6, C.cloudDark) + cloud(2); break;
      case "fog": g = `<path d="M10 22h28M7 29h34M11 36h26" stroke="${C.cloudDark}" stroke-width="3" stroke-linecap="round"/>`; break;
      case "drizzle": g = cloud(-4) + drops(3); break;
      case "rain": g = cloud(-4, C.cloudDark) + drops(5); break;
      case "heavy": g = cloud(-4, C.cloudDark) + drops(5) + `<path d="M13 44l-2 4M37 44l-2 4" stroke="${C.rain}" stroke-width="2.6" stroke-linecap="round"/>`; break;
      case "shower": g = orb(16, 15, 6) + cloud(-1) + drops(3); break;
      case "snow": g = cloud(-4) + flakes(); break;
      case "sleet": g = cloud(-4) + drops(2) + `<circle cx="33" cy="41" r="2.3" fill="${C.snow}"/>`; break;
      case "thunder": g = cloud(-4, C.cloudDark) + `<path d="M26 33l-6 8h5l-3 7 9-10h-5l3-5z" fill="${C.bolt}"/>`; break;
      default: g = cloud(0);
    }
    return `<svg class="wx-ic" viewBox="0 0 48 48" aria-hidden="true">${g}</svg>`;
  }

  // ---- データの取得 ----
  async function getJson(url, timeout = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function position() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(Object.assign(new Error("no geolocation"), { code: 2 }));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        reject,
        { enableHighAccuracy: false, timeout: 20000, maximumAge: 10 * 60 * 1000 },
      );
    });
  }

  function forecast(lat, lon) {
    const q = new URLSearchParams({
      latitude: lat.toFixed(3),
      longitude: lon.toFixed(3),
      current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,precipitation,is_day",
      hourly: "temperature_2m,weather_code,precipitation,precipitation_probability,is_day",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
      timezone: "auto",
      forecast_days: "7",
      wind_speed_unit: "ms",
    });
    return getJson(`https://api.open-meteo.com/v1/forecast?${q}`);
  }

  // 住所: 市区町村コード (国土地理院) → 気象庁の市区町村 (警報・注意報を出す単位) と府県
  async function place(lat, lon) {
    const r = await getJson(
      `https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`,
    );
    const muni = r?.results?.muniCd;
    if (!muni) return null; // 日本の外や海の上
    const town = (r.results.lv01Nm || "").replace(/^[-－]$/, "");
    let info = loadArea(muni);
    if (!info) {
      info = areaOf(await getJson("https://www.jma.go.jp/bosai/common/const/area.json", 30000), muni.padStart(5, "0"));
      if (info) storeArea(muni, info);
    }
    return { ...(info ?? { name: "", areas: [] }), town, muni };
  }
  // 気象庁の市区町村のコードは「市区町村コード + 2桁」。政令指定都市の区は市全体で警報・注意報が出るので、
  // 区のコードから番号を戻って市のコードを探す (区は市のすぐ後ろの番号)。
  // 横浜市北部・南部のように市町村をさらに分けた地域は、全部を返す (どちらにいるかは市区町村コードでは分からない)
  function areaOf(area, muni5) {
    const all = Object.keys(area.class20s);
    for (let d = 0; d <= 30; d++) {
      const m = String(Number(muni5) - d).padStart(5, "0");
      const codes = all.filter((c) => c.startsWith(m)).sort();
      if (!codes.length) continue;
      const first = area.class20s[codes[0]];
      const office = area.class10s[area.class15s[first.parent]?.parent]?.parent ?? "";
      return {
        name: codes.length > 1 ? (first.name.match(/^.+?[市町村]/)?.[0] ?? first.name) : first.name,
        areas: codes.map((code) => ({ code, name: area.class20s[code].name })),
        office,
        pref: area.offices[office]?.name ?? "",
      };
    }
    return null;
  }
  // 市区町村の対応は滅多に変わらないので、一度調べたものは覚えておく (気象庁の地域の一覧は大きい)
  function loadArea(muni) {
    try {
      return JSON.parse(localStorage.getItem("weatherAreas") || "{}")[muni] ?? null;
    } catch {
      return null;
    }
  }
  function storeArea(muni, info) {
    try {
      const all = JSON.parse(localStorage.getItem("weatherAreas") || "{}");
      if (info) all[muni] = info;
      else delete all[muni];
      localStorage.setItem("weatherAreas", JSON.stringify(all));
    } catch {}
  }

  // ---- 警報・注意報 ----
  // 2026年からの新しい形 (warning/data/r8/<府県>.json)。電文ごとに、市区町村ごとの種類 (code) と状態 (status) が並ぶ。
  // 種類のコードは十の位で段階が分かる (0: 警報 / 1・2: 注意報 / 3: 特別警報 / 4: 危険警報)
  const KIND = {
    "02": "暴風雪警報", "03": "大雨警報", "04": "洪水警報", "05": "暴風警報", "06": "大雪警報", "07": "波浪警報", "08": "高潮警報", "09": "土砂災害警報",
    10: "大雨注意報", 12: "大雪注意報", 13: "風雪注意報", 14: "雷注意報", 15: "強風注意報", 16: "波浪注意報", 17: "融雪注意報", 18: "洪水注意報",
    19: "高潮注意報", 20: "濃霧注意報", 21: "乾燥注意報", 22: "なだれ注意報", 23: "低温注意報", 24: "霜注意報", 25: "着氷注意報", 26: "着雪注意報",
    27: "その他の注意報", 29: "土砂災害注意報",
    32: "暴風雪特別警報", 33: "大雨特別警報", 35: "暴風特別警報", 36: "大雪特別警報", 37: "波浪特別警報", 38: "高潮特別警報", 39: "土砂災害特別警報",
    43: "大雨危険警報", 48: "高潮危険警報", 49: "土砂災害危険警報",
  };
  const LEVEL = { 0: 30, 1: 20, 2: 20, 3: 50, 4: 40 }; // 十の位 → 段階
  const STEP = { 20: "注意報", 30: "警報", 40: "危険警報", 50: "特別警報" };
  // 大雨・高潮・土砂災害は、名前の前に警戒レベル (注意報 2 / 警報 3 / 危険警報 4 / 特別警報 5) が付く
  const LEVELED = /^(0[389]|10|19|29|3[389]|4[389])$/;
  function warnInfo(code) {
    const level = LEVEL[code[0]] ?? 20;
    return { name: KIND[code] ?? `その他の${STEP[level]}`, level, alert: LEVELED.test(code) ? level / 10 : 0 };
  }

  async function warnings(p) {
    if (!p?.office || !p.areas?.length) return null;
    const list = await getJson(`https://www.jma.go.jp/bosai/warning/data/r8/${p.office}.json`);
    // 電文は現象 (大雨・土砂災害・高潮・風・波・大雪・その他) ごと。それぞれ一番新しいものを見る
    const latest = new Map();
    for (const r of Array.isArray(list) ? list : []) {
      if (!(latest.get(r.dataTypeCode)?.reportDatetime >= r.reportDatetime)) latest.set(r.dataTypeCode, r);
    }
    const at = [...latest.values()].reduce((a, r) => (r.reportDatetime > a ? r.reportDatetime : a), "");
    let seen = false;
    const areas = p.areas.map(({ code, name }) => {
      const found = new Map();
      for (const r of latest.values()) {
        const item = (r.warning?.class20Items ?? []).find((x) => x.areaCode === code);
        if (item) seen = true;
        for (const k of item?.kinds ?? []) if (k.code && k.status !== "解除") found.set(k.code, { code: k.code, ...warnInfo(k.code) });
      }
      // 重いものから。同じ段階なら、避難に関わる警戒レベル付き (大雨・土砂災害・高潮) を先に
      const items = [...found.values()].sort((a, b) => b.level - a.level || b.alert - a.alert || a.code.localeCompare(b.code));
      return { code, name, items };
    });
    // どの電文にも見当たらないときは、気象庁の地域の分け方が変わったのかもしれない。次は地域の一覧から調べ直す
    if (!seen) {
      storeArea(p.muni, null);
      return null;
    }
    return { at, areas };
  }

  // ---- 表示 ----
  const W = ["日", "月", "火", "水", "木", "金", "土"];
  const dayOf = (date) => {
    const [y, m, d] = date.split("-").map(Number);
    return { w: W[new Date(Date.UTC(y, m - 1, d)).getUTCDay()], md: `${m}/${d}` };
  };
  const hourOf = (t) => Number(t.slice(11, 13));
  const deg = (v) => `${Math.round(v)}°`;
  const DIRS = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
  const dirName = (d) => DIRS[Math.round(d / 45) % 8];

  function render() {
    if (!cache?.fc) return;
    const { fc, place: p, warn } = cache;
    $("wx-place").textContent = p?.name ? `${p.name}` : "現在地";
    const town = p?.town ? `${p.town}付近` : "";
    const upd = new Date(cache.at);
    $("wx-sub").textContent = [p?.pref, town, `${upd.getHours()}:${String(upd.getMinutes()).padStart(2, "0")} 更新`]
      .filter(Boolean)
      .join(" · ");

    const cur = fc.current;
    const d = fc.daily;
    const [curText, curKind] = kindOf(cur.weather_code);
    const night = cur.is_day === 0;

    // 1時間ごと: 今の時刻から明日の終わりまで
    const h = fc.hourly;
    let start = h.time.indexOf(`${cur.time.slice(0, 13)}:00`);
    if (start < 0) start = 0;
    let end = h.time.indexOf(`${d.time[1]}T23:00`);
    end = end < 0 ? Math.min(h.time.length, start + 48) : end + 1;
    const hours = [];
    for (let i = start; i < end; i++) {
      hours.push({
        t: h.time[i], temp: h.temperature_2m[i], code: h.weather_code[i], pop: h.precipitation_probability?.[i],
        mm: h.precipitation[i], day: h.is_day[i],
      });
    }

    // 広い画面では、左に警報・今の天気・今日と明日、右に1時間ごとと週間予報
    body.innerHTML = `
      <div class="wx-colL">
      ${warnHTML(warn, p)}
      <section class="wx-now wx-card" aria-label="今の天気">
        <div class="wx-now-main">
          ${icon(curKind, night)}
          <div>
            <p class="wx-now-temp">${deg(cur.temperature_2m)}</p>
            <p class="wx-now-text">${esc(curText)}</p>
          </div>
        </div>
        <dl class="wx-facts">
          <div><dt>最高</dt><dd class="wx-hi">${deg(d.temperature_2m_max[0])}</dd></div>
          <div><dt>最低</dt><dd class="wx-lo">${deg(d.temperature_2m_min[0])}</dd></div>
          <div><dt>体感</dt><dd>${deg(cur.apparent_temperature)}</dd></div>
          <div><dt>湿度</dt><dd>${Math.round(cur.relative_humidity_2m)}%</dd></div>
          <div><dt>風</dt><dd>${dirName(cur.wind_direction_10m)} ${Math.round(cur.wind_speed_10m)}m/s</dd></div>
        </dl>
      </section>
      <div class="wx-days">${[0, 1].map((i) => dayCard(d, i, i === 0 ? "今日" : "明日")).join("")}</div>
      </div>
      <div class="wx-colR">
      <section class="wx-card wx-hourly" aria-labelledby="wx-hourly-h">
        <h2 id="wx-hourly-h" class="wx-h">1時間ごと</h2>
        ${hourlyHTML(hours)}
      </section>
      <section class="wx-card wx-week" aria-labelledby="wx-week-h">
        <h2 id="wx-week-h" class="wx-h">週間予報</h2>
        ${weekHTML(d, cur.temperature_2m)}
      </section>
      </div>
      <p class="wx-credit">
        予報: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>
        (気象庁などのデータ) / 警報・注意報: <a href="https://www.jma.go.jp/bosai/warning/" target="_blank" rel="noopener">気象庁ホームページ</a>
        / 住所: 国土地理院
      </p>`;
    // 横に長い1時間ごとの表は、今の時刻が左端に来るようにしておく
    body.querySelector(".wx-scroll")?.scrollTo({ left: 0 });
  }

  function dayCard(d, i, label) {
    const [text, kind] = kindOf(d.weather_code[i]);
    const pop = d.precipitation_probability_max?.[i];
    return `<section class="wx-card wx-day" aria-label="${label}の天気">
      <h2 class="wx-h">${label} <small>${dayOf(d.time[i]).md}(${dayOf(d.time[i]).w})</small></h2>
      <div class="wx-day-main">${icon(kind)}<p>${esc(text)}</p></div>
      <p class="wx-day-temp"><span class="wx-hi">${deg(d.temperature_2m_max[i])}</span><span class="wx-sep">/</span><span class="wx-lo">${deg(d.temperature_2m_min[i])}</span></p>
      <p class="wx-day-pop">降水確率 <b>${pop == null ? "—" : `${pop}%`}</b></p>
    </section>`;
  }

  // 1時間ごと: 時刻・天気・気温 (線で上がり下がりも見せる)・降水確率・降水量を、横にスクロールする表で
  function hourlyHTML(hours) {
    if (!hours.length) return "";
    const CW = 52; // 1時間の幅
    const H = 46; // 気温の線の高さ
    const temps = hours.map((x) => x.temp);
    const lo = Math.min(...temps);
    const hi = Math.max(...temps);
    const y = (t) => (hi === lo ? H / 2 : 6 + (1 - (t - lo) / (hi - lo)) * (H - 12));
    const pts = hours.map((x, i) => [i * CW + CW / 2, y(x.temp)]);
    const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join("");
    const area = `${line}L${pts[pts.length - 1][0].toFixed(1)} ${H}L${pts[0][0].toFixed(1)} ${H}Z`;
    const w = hours.length * CW;
    const cols = hours
      .map((x, i) => {
        const hh = hourOf(x.t);
        const first = i === 0;
        const newDay = !first && hh === 0;
        const [text, kind] = kindOf(x.code);
        const pop = x.pop == null ? "—" : `${x.pop}%`;
        const mm = x.mm >= 0.05 ? (x.mm >= 10 ? Math.round(x.mm) : x.mm.toFixed(1)) : "0";
        return `<div class="wx-col${newDay ? " wx-newday" : ""}${first ? " wx-nowcol" : ""}" role="listitem"
          aria-label="${first ? "今" : `${hh}時`} ${esc(text)} ${Math.round(x.temp)}度 降水確率${pop} 降水量${mm}ミリ">
          <span class="wx-t">${first ? "今" : newDay ? "明日" : `${hh}時`}</span>
          ${icon(kind, x.day === 0)}
          <span class="wx-temp">${deg(x.temp)}</span>
          <span class="wx-pop${x.pop >= 50 ? " wet" : ""}">${pop}</span>
          <span class="wx-mm${x.mm >= 1 ? " wet" : ""}">${mm}</span>
        </div>`;
      })
      .join("");
    return `<div class="wx-hgrid">
      <div class="wx-rowlabels" aria-hidden="true"><span></span><span></span><span>気温</span><span>降水確率</span><span>降水量<small>mm</small></span></div>
      <div class="wx-scroll" tabindex="0" aria-label="1時間ごとの天気 (横にスクロール)">
        <div class="wx-track" style="width:${w}px">
          <svg class="wx-curve" viewBox="0 0 ${w} ${H}" width="${w}" height="${H}" aria-hidden="true">
            <path d="${area}" class="wx-curve-area"/><path d="${line}" class="wx-curve-line"/>
            <circle cx="${pts[0][0]}" cy="${pts[0][1]}" r="4" class="wx-curve-now"/>
          </svg>
          <div class="wx-cols" role="list">${cols}</div>
        </div>
      </div>
    </div>`;
  }

  // 週間予報: 曜日・天気・降水確率と、1週間で共通の目盛りの上に最低〜最高気温の幅
  function weekHTML(d, now) {
    const lo = Math.min(...d.temperature_2m_min);
    const hi = Math.max(...d.temperature_2m_max);
    const pct = (t) => (hi === lo ? 50 : ((t - lo) / (hi - lo)) * 100);
    return `<ol class="wx-weeklist">${d.time
      .map((t, i) => {
        const { w, md } = dayOf(t);
        const [text, kind] = kindOf(d.weather_code[i]);
        const mn = d.temperature_2m_min[i];
        const mx = d.temperature_2m_max[i];
        const pop = d.precipitation_probability_max?.[i];
        const nowDot = i === 0 && now >= mn && now <= mx ? `<i class="wx-bar-now" style="left:${pct(now).toFixed(1)}%"></i>` : "";
        const day = i === 0 ? "今日" : i === 1 ? "明日" : w;
        return `<li class="wx-wrow${w === "日" ? " sun" : w === "土" ? " sat" : ""}">
          <span class="wx-wday"><b>${day}</b><small>${md}</small></span>
          ${icon(kind)}
          <span class="wx-wtext">${esc(text)}</span>
          <span class="wx-wpop">${pop == null ? "—" : `${pop}%`}</span>
          <span class="wx-lo">${deg(mn)}</span>
          <span class="wx-bar" aria-hidden="true"><i style="left:${pct(mn).toFixed(1)}%;right:${(100 - pct(mx)).toFixed(1)}%"></i>${nowDot}</span>
          <span class="wx-hi">${deg(mx)}</span>
        </li>`;
      })
      .join("")}</ol>`;
  }

  function warnHTML(warn, p) {
    if (!p?.areas?.length) return "";
    if (!warn) {
      return `<section class="wx-warn none" aria-label="警報・注意報"><p>警報・注意報を取得できませんでした</p></section>`;
    }
    if (!warn.areas.some((a) => a.items.length)) {
      return `<section class="wx-warn none" aria-label="警報・注意報"><p>${esc(p.name)}に発表中の警報・注意報はありません</p></section>`;
    }
    const chips = (items) =>
      `<ul class="wx-chips">${items
        .map((w) => `<li class="wx-chip lv${w.level}">${w.alert ? `<span class="wx-lvl">レベル${w.alert}</span>` : ""}${esc(w.name)}</li>`)
        .join("")}</ul>`;
    // 横浜市北部・南部のように分かれた地域で、出ているものが違うときは地域ごとに並べる
    const kinds = (a) => a.items.map((w) => w.code).join();
    const same = warn.areas.every((a) => kinds(a) === kinds(warn.areas[0]));
    const list = same
      ? chips(warn.areas[0].items)
      : warn.areas
          .map((a) => `<div class="wx-warea"><h3>${esc(a.name)}</h3>${a.items.length ? chips(a.items) : '<p class="wx-wnone">なし</p>'}</div>`)
          .join("");
    const hm = /T(\d\d):(\d\d)/.exec(warn.at);
    const t = hm ? `${Number(hm[1])}:${hm[2]} 発表 · ` : "";
    return `<section class="wx-warn" aria-label="警報・注意報">
      <h2 class="wx-h">${esc(p.name)}に発表中の警報・注意報</h2>
      ${list}
      <p class="wx-more">${t}<a href="https://www.jma.go.jp/bosai/warning/#area_type=class20s&area_code=${esc(warn.areas[0].code)}" target="_blank" rel="noopener">気象庁で詳しく見る ↗</a></p>
    </section>`;
  }

  // 位置情報を許可してもらう前・許可されなかったとき・取得に失敗したとき
  function message(kind, detail = "") {
    const texts = {
      ask: [
        "現在地の天気を表示します",
        "スマホの位置情報を使って、今いる場所の天気・1時間ごとの予報・週間予報・警報と注意報を表示します。位置は天気を調べるためだけに、気象サービスへ送られます。",
        "現在地の天気を見る",
      ],
      denied: [
        "位置情報が許可されていません",
        "ブラウザの設定で、このアプリの位置情報を「許可」にしてから、もう一度お試しください。(Chrome: アドレス欄の左のアイコン → 権限 → 位置情報)",
        "もう一度試す",
      ],
      error: ["天気を取得できませんでした", detail || "通信状態を確かめて、もう一度お試しください。", "もう一度試す"],
    }[kind];
    const keep = cache?.fc ? body.querySelector(".wx-now") : null;
    const box = `<section class="wx-card wx-msg"><h2 class="wx-h">${texts[0]}</h2><p>${esc(texts[1])}</p>
      <button type="button" class="wx-btn" id="wx-go">${texts[2]}</button></section>`;
    if (keep) {
      // 前に取れた天気は残して、上にお知らせを出す
      body.querySelector(".wx-msg")?.remove();
      body.insertAdjacentHTML("afterbegin", box);
    } else {
      $("wx-place").textContent = "天気";
      $("wx-sub").textContent = "";
      body.innerHTML = box;
    }
    $("wx-go").onclick = () => refresh(true);
  }

  // ---- 更新 ----
  let busy = false;
  async function refresh(manual = false) {
    if (busy) return;
    busy = true;
    body.classList.add("loading");
    if (!cache?.fc) body.innerHTML = '<p class="wx-loading">現在地の天気を調べています…</p>';
    try {
      const pos = await position();
      const [fc, p] = await Promise.all([forecast(pos.lat, pos.lon), place(pos.lat, pos.lon).catch(() => null)]);
      const warn = p?.areas?.length ? await warnings(p).catch(() => null) : null;
      cache = { at: Date.now(), lat: pos.lat, lon: pos.lon, place: p, fc, warn };
      save();
      render();
    } catch (err) {
      if (err?.code === 1) message("denied");
      else if (err?.code === 2 || err?.code === 3) message("error", "現在地を取得できませんでした。位置情報がオンになっているか確かめてください。");
      else message("error");
      if (manual) console.warn("weather:", err);
    } finally {
      busy = false;
      body.classList.remove("loading");
    }
  }

  // タブを開いたとき: 許可済みなら古ければ取り直す。まだなら説明とボタンを出す
  async function onShow() {
    if (cache?.fc && !body.childElementCount) render();
    let state = "prompt";
    try {
      state = (await navigator.permissions?.query({ name: "geolocation" }))?.state ?? "prompt";
    } catch {}
    if (state === "denied") return message("denied");
    if (state === "granted" || cache?.fc) {
      if (!cache?.fc || Date.now() - cache.at > STALE_MS) refresh();
      return;
    }
    message("ask");
  }

  document.addEventListener("viewchange", (e) => {
    if (e.detail === "weather") onShow();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && window.World?.view() === "weather" && cache?.fc && Date.now() - cache.at > STALE_MS) refresh();
  });
  if (window.World?.view() === "weather") onShow();

  window.Weather = { refresh: () => refresh(true) };
})();
