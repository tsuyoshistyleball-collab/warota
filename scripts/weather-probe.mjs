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
