// 天気のページで使うデータの取り方を確かめるメンテ用 (debugワークフローから実行)。
// ブラウザから直接読めるか (CORS) と、データの形をログに出す。
// usage: node scripts/debug-extract.mjs "weather-probe"

const ORIGIN = "https://tsuyoshistyleball-collab.github.io";
const LAT = 35.6812;
const LON = 139.7671;

async function head(url, n = 1200) {
  try {
    const res = await fetch(url, { headers: { Origin: ORIGIN } });
    const text = await res.text();
    console.log(`\n=== ${url}`);
    console.log(
      `status=${res.status} acao=${res.headers.get("access-control-allow-origin")} type=${res.headers.get("content-type")} ` +
        `cache=${res.headers.get("cache-control")} size=${text.length}`,
    );
    console.log(text.slice(0, n));
    return text;
  } catch (err) {
    console.log(`\n=== ${url}\nNG ${err.message}`);
    return "";
  }
}

export async function probe() {
  const om =
    "https://api.open-meteo.com/v1/forecast?latitude=" + LAT + "&longitude=" + LON +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation" +
    "&hourly=temperature_2m,weather_code,precipitation,precipitation_probability" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset" +
    "&timezone=Asia%2FTokyo&forecast_days=7";
  await head(om, 1500);
  await head(om + "&models=jma_seamless", 800);
  await head(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${LAT}&lon=${LON}`);
  await head("https://www.jma.go.jp/bosai/forecast/data/forecast/130000.json", 600);
  await head("https://www.jma.go.jp/bosai/warning/data/warning/130000.json", 1500);

  // 地域の一覧 (府県予報区 offices → 一次細分 class10s → 市町村等をまとめた地域 class15s → 市区町村 class20s)
  const areaText = await head("https://www.jma.go.jp/bosai/common/const/area.json", 300);
  let area = {};
  try {
    area = JSON.parse(areaText);
  } catch {}
  for (const k of Object.keys(area)) {
    const entries = Object.entries(area[k]);
    console.log(`area.${k}: ${entries.length} 件 例: ${JSON.stringify(entries.slice(0, 2))}`);
  }

  // 全国の警報・注意報で使われているコードと状態を数える
  const codes = new Map();
  const statuses = new Map();
  const shapes = new Set();
  for (const office of Object.keys(area.offices ?? {})) {
    try {
      const w = await (await fetch(`https://www.jma.go.jp/bosai/warning/data/warning/${office}.json`)).json();
      shapes.add(Object.keys(w).join(","));
      for (const t of w.areaTypes ?? []) {
        for (const a of t.areas ?? []) {
          for (const x of a.warnings ?? []) {
            codes.set(x.code, (codes.get(x.code) ?? 0) + 1);
            statuses.set(x.status, (statuses.get(x.status) ?? 0) + 1);
          }
        }
      }
    } catch (err) {
      console.log(`warning ${office} NG ${err.message}`);
    }
  }
  console.log(`\nwarning json keys: ${[...shapes].join(" | ")}`);
  console.log(`codes: ${JSON.stringify([...codes].sort())}`);
  console.log(`statuses: ${JSON.stringify([...statuses])}`);

  // 警報・注意報の名前の表を、気象庁の警報のページのスクリプトから探す
  const page = await (await fetch("https://www.jma.go.jp/bosai/warning/")).text();
  const scripts = [...page.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => new URL(m[1], "https://www.jma.go.jp/bosai/warning/").href);
  console.log(`\nscripts: ${scripts.join(" ")}`);
  for (const src of scripts) {
    const js = await (await fetch(src)).text();
    for (const word of ["大雨警報", "大雨危険警報", "雷注意報", "土砂災害"]) {
      let at = js.indexOf(word);
      let shown = 0;
      while (at >= 0 && shown < 2) {
        console.log(`--- ${src} [${word}] ${js.slice(Math.max(0, at - 300), at + 300).replace(/\s+/g, " ")}`);
        at = js.indexOf(word, at + 1);
        shown++;
      }
    }
  }
}

// 警報・注意報のデータがいつ更新されたか (地域ごと) と、気象庁の警報のページが読んでいるデータを調べる
export async function probe2() {
  const area = await (await fetch("https://www.jma.go.jp/bosai/common/const/area.json")).json();
  const dates = [];
  for (const office of Object.keys(area.offices)) {
    try {
      const w = await (await fetch(`https://www.jma.go.jp/bosai/warning/data/warning/${office}.json`)).json();
      dates.push(`${office}:${w.reportDatetime}`);
    } catch (err) {
      dates.push(`${office}:NG`);
    }
  }
  dates.sort((a, b) => a.split(":").slice(1).join(":").localeCompare(b.split(":").slice(1).join(":")));
  console.log(`oldest: ${dates.slice(0, 5).join(" ")}`);
  console.log(`newest: ${dates.slice(-8).join(" ")}`);

  for (const url of ["https://www.jma.go.jp/bosai/warning/", "https://www.jma.go.jp/bosai/"]) {
    const html = await (await fetch(url)).text();
    console.log(`\n=== ${url} (${html.length})`);
    console.log(html.replace(/\s+/g, " ").slice(0, 6000));
  }
}

// 気象庁の警報のページ (と防災情報のトップ) の中に書かれているデータの場所を一覧にする
export async function probe3() {
  for (const url of ["https://www.jma.go.jp/bosai/warning/", "https://www.jma.go.jp/bosai/"]) {
    const html = await (await fetch(url)).text();
    const found = new Set();
    for (const m of html.matchAll(/["'`]([^"'`\s<>]{0,160}?(?:\.json|data\/|const\/)[^"'`\s<>]{0,120})["'`]/g)) found.add(m[1]);
    console.log(`\n=== ${url}: ${found.size} paths`);
    for (const p of [...found].slice(0, 200)) console.log(`  ${p}`);
    // 警報の名前の表 (大雨警報・危険警報など) がありそうな所
    for (const word of ["危険警報", "大雨警報", "warning/data", "warning_level", "elems"]) {
      let at = html.indexOf(word);
      for (let i = 0; at >= 0 && i < 2; i++) {
        console.log(`--- [${word}] ${html.slice(Math.max(0, at - 400), at + 400).replace(/\s+/g, " ")}`);
        at = html.indexOf(word, at + 1);
      }
    }
  }
}

// 2026年からの新しい警報・注意報のデータ (warning/data/r8/) の形を調べる
export async function probe4() {
  const base = "https://www.jma.go.jp/bosai/warning/data/r8/";
  await head(base + "130000.json", 4000);
  await head(base + "map_time.json", 600);
  const mapText = await head(base + "map.json", 1500);
  await head(base + "panel.json", 800);
  // 全国の地域ごとのデータで使われているキーとコードを数える
  const area = await (await fetch("https://www.jma.go.jp/bosai/common/const/area.json")).json();
  const keys = new Map();
  const samples = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, path + "[]"));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    else {
      const k = `${path}=${typeof v === "string" && v.length < 24 ? v : typeof v}`;
      keys.set(k, (keys.get(k) ?? 0) + 1);
    }
  };
  let dates = [];
  for (const office of Object.keys(area.offices)) {
    try {
      const j = await (await fetch(base + office + ".json")).json();
      walk(j, "");
      dates.push(j.reportDatetime ?? j[0]?.reportDatetime ?? "?");
      if (samples.length < 1 && JSON.stringify(j).includes("level3")) samples.push(office);
    } catch (err) {
      console.log(`r8 ${office} NG ${err.message}`);
    }
  }
  dates.sort();
  console.log(`\nreport dates: oldest ${dates[0]} newest ${dates[dates.length - 1]}`);
  const rows = [...keys].filter(([k]) => !/\.code=\d{7}$|\.code=\d{6}$/.test(k)).sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`keys (${rows.length}):`);
  for (const [k, n] of rows.slice(0, 400)) console.log(`  ${n}\t${k}`);
  if (samples[0]) await head(base + samples[0] + ".json", 3000);
  // ページのスクリプトから、警報の種類の名前の表を探す
  const html = await (await fetch("https://www.jma.go.jp/bosai/warning/")).text();
  for (const word of ["level30", "level40", "注意報", "警報"]) {
    let at = html.indexOf(word);
    for (let i = 0; at >= 0 && i < 3; i++) {
      console.log(`--- [${word}] ${html.slice(Math.max(0, at - 300), at + 500).replace(/\s+/g, " ")}`);
      at = html.indexOf(word, at + 1);
    }
  }
}

// 新しい警報・注意報のデータの、電文の種類 (dataTypeCode) ごとのコードと、名前の表のありかを調べる
export async function probe5() {
  const base = "https://www.jma.go.jp/bosai/warning/data/r8/";
  const area = await (await fetch("https://www.jma.go.jp/bosai/common/const/area.json")).json();
  const byType = new Map(); // dataTypeCode → { n, codes: Map(code → Set(status)), sample, heads: Set }
  const kindKeys = new Set();
  for (const office of Object.keys(area.offices)) {
    let list = [];
    try {
      list = await (await fetch(base + office + ".json")).json();
    } catch {
      continue;
    }
    for (const r of list) {
      const t = byType.get(r.dataTypeCode) ?? { n: 0, codes: new Map(), sample: null, heads: new Set(), keys: new Set() };
      byType.set(r.dataTypeCode, t);
      t.n++;
      for (const k of Object.keys(r)) t.keys.add(k);
      if (t.heads.size < 4 && r.headlineText) t.heads.add(r.headlineText.slice(0, 60));
      for (const [group, items] of Object.entries(r.warning ?? {})) {
        for (const it of items ?? []) {
          for (const k of it.kinds ?? []) {
            for (const key of Object.keys(k)) kindKeys.add(`${group}.${key}`);
            const set = t.codes.get(k.code ?? "-") ?? new Set();
            set.add(k.status);
            t.codes.set(k.code ?? "-", set);
            if (!t.sample && k.code && k.status !== "解除") t.sample = JSON.stringify(r).slice(0, 1800);
          }
        }
      }
    }
  }
  console.log(`kind keys: ${[...kindKeys].join(" ")}`);
  for (const [type, t] of [...byType].sort()) {
    console.log(`\n### ${type} reports=${t.n} keys=${[...t.keys].join(",")}`);
    console.log(`codes: ${[...t.codes].map(([c, s]) => `${c}:${[...s].join("/")}`).join("  ")}`);
    console.log(`heads: ${[...t.heads].join(" | ")}`);
    if (t.sample) console.log(`sample: ${t.sample}`);
  }
  // ページのスクリプトから、コードと名前の表を探す
  const html = await (await fetch("https://www.jma.go.jp/bosai/warning/")).text();
  for (const re of [/VPWW5\d/g, /危険警報/g, /土砂災害/g, /"10":/g, /code:"10"/g, /大雨/g]) {
    const hits = [...html.matchAll(re)].slice(0, 2);
    for (const m of hits) console.log(`--- [${re.source}] ${html.slice(Math.max(0, m.index - 300), m.index + 600).replace(/\s+/g, " ")}`);
  }
}

// 気象庁のページのスクリプトは日本語を \\uXXXX の形で書いているので、元に戻してから警報の名前の表を探す
export async function probe6() {
  const html = await (await fetch("https://www.jma.go.jp/bosai/warning/")).text();
  const text = html.replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  for (const word of ["土砂災害危険警報", "大雨危険警報", "高潮危険警報", "土砂災害注意報", "大雨特別警報", "濃霧注意報"]) {
    let at = text.indexOf(word);
    for (let i = 0; at >= 0 && i < 2; i++) {
      console.log(`--- [${word}] ${text.slice(Math.max(0, at - 700), at + 900).replace(/\s+/g, " ")}`);
      at = text.indexOf(word, at + 1);
    }
  }
}

// 新しい警報・注意報の種別コードの表を、解説ページから探す
export async function probe7() {
  for (const url of ["https://dmdata.jp/docs/topic/2026weather/", "https://dmdata.jp/docs/reference/conversion/json/schema/weather-warning/"]) {
    let html = "";
    try {
      html = await (await fetch(url)).text();
    } catch (err) {
      console.log(`=== ${url} NG ${err.message}`);
      continue;
    }
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
    console.log(`\n=== ${url} (${text.length})`);
    for (const word of ["コード", "危険警報", "VPWW"]) {
      let at = text.indexOf(word);
      for (let i = 0; at >= 0 && i < 6; i++) {
        console.log(`--- [${word}] ${text.slice(Math.max(0, at - 200), at + 700)}`);
        at = text.indexOf(word, at + 700);
      }
    }
  }
}

// 政令指定都市の区と、警報・注意報の地域コードの対応を確かめる
export async function probe8() {
  const area = await (await fetch("https://www.jma.go.jp/bosai/common/const/area.json")).json();
  for (const pre of ["0110", "1410", "1413", "2310", "2710", "4013", "1310", "1110", "2610"]) {
    const hits = Object.entries(area.class20s).filter(([c]) => c.startsWith(pre)).map(([c, v]) => `${c}:${v.name}`);
    console.log(`class20 ${pre}*: ${hits.join(" ")}`);
  }
  for (const office of ["140000", "016000", "270000"]) {
    const list = await (await fetch(`https://www.jma.go.jp/bosai/warning/data/r8/${office}.json`)).json();
    const codes = new Set();
    for (const r of list) for (const it of r.warning?.class20Items ?? []) codes.add(it.areaCode);
    const odd = [...codes].filter((c) => !area.class20s[c]);
    console.log(`r8 ${office}: ${codes.size} areas, not in area.json: ${odd.join(" ") || "none"}; sample: ${[...codes].slice(0, 12).join(" ")}`);
  }
  // 国土地理院の逆ジオコーダーが、横浜市中区・大阪市北区・札幌市中央区で返すコード
  for (const [lat, lon] of [[35.4437, 139.638], [34.7055, 135.4983], [43.0611, 141.3564]]) {
    const r = await (await fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lon}`)).json();
    console.log(`gsi ${lat},${lon}: ${JSON.stringify(r)}`);
  }
}

// 市区町村をさらに分けた地域 (横浜市北部・南部など) の一覧と、その境目の地図データがどこにあるか
export async function probe9() {
  const area = await (await fetch("https://www.jma.go.jp/bosai/common/const/area.json")).json();
  const split = {};
  for (const [c, v] of Object.entries(area.class20s)) if (!c.endsWith("00")) (split[c.slice(0, 5)] ??= []).push(`${c}:${v.name}`);
  const groups = Object.entries(split);
  console.log(`split municipalities: ${groups.length}`);
  for (const [m, list] of groups) console.log(`  ${m}: ${list.join(" ")}`);
  console.log(`1410011: ${JSON.stringify(area.class20s["1410011"])}`);
  console.log(`class15 of 1410011: ${JSON.stringify(area.class15s[area.class20s["1410011"]?.parent])}`);

  // 気象庁の警報のページが読み込むファイル
  const page = await (await fetch("https://www.jma.go.jp/bosai/warning/")).text();
  const srcs = [...page.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => new URL(m[1], "https://www.jma.go.jp/bosai/warning/").href);
  console.log(`scripts: ${srcs.join(" ")}`);
  const found = new Set();
  for (const s of srcs) {
    const js = await (await fetch(s)).text();
    for (const m of js.matchAll(/["'`]([^"'`\s]*(?:const|geojson|topojson|map)[^"'`\s]*\.(?:json|geojson|pbf)[^"'`\s]*)["'`]/g)) found.add(m[1]);
  }
  console.log(`json paths: ${[...found].slice(0, 60).join(" ")}`);

  for (const u of [
    "https://www.jma.go.jp/bosai/common/const/geojson/class20s.json",
    "https://www.jma.go.jp/bosai/common/const/topojson/class20s.json",
    "https://www.jma.go.jp/bosai/common/const/class20s.json",
    "https://maps.gsi.go.jp/js/muni.js",
  ]) {
    try {
      const res = await fetch(u, { headers: { Origin: ORIGIN } });
      const t = await res.text();
      console.log(`${u}: ${res.status} acao=${res.headers.get("access-control-allow-origin")} size=${t.length} head=${JSON.stringify(t.slice(0, 160))}`);
    } catch (err) {
      console.log(`${u}: NG ${err.message}`);
    }
  }
}

// 天気のタブ (public/weather.js) を、本物のデータで動かして表示を確かめる (画面の代わりに linkedom を使う)
export async function runWeather(lat, lon, fetchImpl = fetch) {
  const fs = await import("node:fs");
  const { parseHTML } = await import("linkedom");
  const { window, document } = parseHTML(fs.readFileSync("public/index.html", "utf8"));
  Object.getPrototypeOf(Object.getPrototypeOf(document.createElement("div"))).scrollTo ??= () => {};
  const store = new Map();
  const localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  const navigator = {
    geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: lat, longitude: lon } }) },
    permissions: { query: async () => ({ state: "granted" }) },
  };
  window.World = { view: () => "matome" }; // 読み込んだだけでは取りに行かせない
  // Node の fetch に無いオプション (cache) は外す
  const f = (url, { cache, ...opts } = {}) => fetchImpl(url, opts);
  new Function("window", "document", "localStorage", "navigator", "fetch", fs.readFileSync("public/weather.js", "utf8"))(
    window, document, localStorage, navigator, f,
  );
  await window.Weather.refresh();
  const text = (sel) => document.querySelector(sel)?.textContent.replace(/\s+/g, " ").trim() ?? "";
  return {
    place: text("#wx-place"),
    sub: text("#wx-sub"),
    warn: text(".wx-warn") || "(警報の欄なし)",
    now: `${text(".wx-now-temp")} ${text(".wx-now-text")}`,
    hours: document.querySelectorAll(".wx-col").length,
    days: document.querySelectorAll(".wx-wrow").length,
    msg: text(".wx-msg"),
  };
}

export async function probe10() {
  const places = [
    ["東京駅", 35.6812, 139.7671], ["横浜市中区", 35.4437, 139.638], ["札幌市清田区", 42.9998, 141.4436],
    ["大阪市北区", 34.7055, 135.4983], ["浜松市中央区", 34.7108, 137.7261], ["日光市", 36.7199, 139.6982],
    ["那覇市", 26.2124, 127.6809], ["稚内市", 45.4156, 141.6731], ["海の上", 35.0, 150.0],
  ];
  for (const [name, lat, lon] of places) {
    try {
      console.log(`\n=== ${name}: ${JSON.stringify(await runWeather(lat, lon))}`);
    } catch (err) {
      console.log(`\n=== ${name}: NG ${err.stack}`);
    }
  }
}

// 雨雲レーダー: 気象庁の「雨雲の動き」(降水ナウキャスト) の時刻の一覧と地図タイル、国土地理院の地図タイル
export async function probe11() {
  const tile = (lat, lon, z) => {
    const n = 2 ** z;
    const s = Math.sin((lat * Math.PI) / 180);
    return [Math.floor(((lon + 180) / 360) * n), Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n)];
  };
  const base = "https://www.jma.go.jp/bosai/jmatile/data/nowc/";
  const lists = {};
  for (const n of ["N1", "N2", "N3"]) {
    try {
      const res = await fetch(`${base}targetTimes_${n}.json`, { headers: { Origin: ORIGIN } });
      const t = await res.text();
      console.log(`targetTimes_${n}: ${res.status} acao=${res.headers.get("access-control-allow-origin")} cache=${res.headers.get("cache-control")} size=${t.length}`);
      const j = JSON.parse(t);
      lists[n] = j;
      console.log(`  n=${j.length} first=${JSON.stringify(j[0])} last=${JSON.stringify(j.at(-1))}`);
      console.log(`  elements: ${[...new Set(j.flatMap((x) => x.elements ?? []))].join(",")}`);
    } catch (err) {
      console.log(`targetTimes_${n}: NG ${err.message}`);
    }
  }
  const head = async (u) => {
    try {
      const r = await fetch(u, { headers: { Origin: ORIGIN } });
      const b = await r.arrayBuffer();
      return `${r.status} ${r.headers.get("content-type")} ${b.byteLength}B acao=${r.headers.get("access-control-allow-origin")} cache=${r.headers.get("cache-control")}`;
    } catch (err) {
      return `NG ${err.message}`;
    }
  };
  const now = lists.N1?.[0];
  const fut = lists.N2?.at(-1);
  for (const [label, t] of [["now", now], ["future", fut]]) {
    if (!t) continue;
    for (let z = 3; z <= 13; z++) {
      const [x, y] = tile(35.68, 139.76, z);
      console.log(`${label} hrpns z${z}: ${await head(`${base}${t.basetime}/none/${t.validtime}/surf/hrpns/${z}/${x}/${y}.png`)}`);
    }
  }
  for (const z of [3, 4, 5, 8, 10, 12, 14]) {
    const [x, y] = tile(35.68, 139.76, z);
    console.log(`gsi pale z${z}: ${await head(`https://cyberjapandata.gsi.go.jp/xyz/pale/${z}/${x}/${y}.png`)}`);
  }
  // 気象庁の地図ページが使っている地図タイル (あれば)
  const page = await (await fetch("https://www.jma.go.jp/bosai/nowc/")).text();
  console.log(`nowc page scripts: ${[...page.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]).join(" ")}`);
  for (const m of [...page.matchAll(/(?:tile|jmatile|xyz)[^"'\s<>]{0,120}/g)].slice(0, 20)) console.log(`  ${m[0]}`);
}

// 雨雲レーダー (public/radar.js) を本物の地図と雨雲で開いて、画面を撮る (ログに半分の大きさの JPEG を base64 で出す)
export async function probe12() {
  const fs = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const pub = `${process.cwd()}/public`;
  execFileSync("python3", ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--break-system-packages", "pillow"], { stdio: "inherit" });
  for (const [name, w, h, args] of [["tokyo", 412, 900, "35.6812, 139.7671"], ["japan", 412, 900, ""]]) {
    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
      <link rel="stylesheet" href="file://${pub}/style.css"></head><body>
      <script src="file://${pub}/radar.js"></script><script>Radar.open(${args});</script></body></html>`;
    fs.writeFileSync(`/tmp/radar-${name}.html`, html);
    try {
      const out = execFileSync("google-chrome", [
        "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--window-size=${w},${h}`,
        "--enable-logging=stderr", "--v=0", "--virtual-time-budget=20000",
        `--screenshot=/tmp/radar-${name}.png`, `file:///tmp/radar-${name}.html`,
      ], { stdio: "pipe", timeout: 90000 });
      const logs = out.toString();
      void logs;
    } catch (err) {
      console.log(`shot ${name} NG ${err.message}`);
      continue;
    }
    const b64 = execFileSync("python3", ["-c", `
import base64, io, sys
from PIL import Image
im = Image.open("/tmp/radar-${name}.png").convert("RGB")
im = im.resize((im.width // 2, im.height // 2))
buf = io.BytesIO(); im.save(buf, "JPEG", quality=62)
sys.stdout.write(base64.b64encode(buf.getvalue()).decode())
`]).toString();
    console.log(`SHOT ${name} ${b64.length}`);
    console.log(`B64:${name}:${b64}`);
  }
}
