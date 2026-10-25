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
