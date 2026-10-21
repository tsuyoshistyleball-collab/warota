// 世界地図のデータ public/world-map.json を作る (開発時に1回だけ実行する)。
// 元データは Natural Earth (パブリックドメイン) の 1:110m 国境データ。
//
//   npm install --no-save --no-package-lock d3-geo topojson-client world-atlas
//   node scripts/build-map.mjs
//
// - 日本中心 (東経155度が中央。切れ目は大西洋の西経25度で、アイスランドを分断しない)
// - Natural Earth 図法。北緯80度〜南緯57度だけを表示し、南極は描かない
// - 国を8地域にまとめ、地域ごとに1本のパスにする (隣り合う国の間に塗りの継ぎ目が出ない)
// - ロシアはウラル山脈 (東経60度) で分け、シベリアはアジアとして塗る。仏領ギアナは中南米

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { geoNaturalEarth1, geoPath, geoGraticule } from "d3-geo";
import { feature, mesh } from "topojson-client";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const world = JSON.parse(await readFile(path.join(ROOT, "node_modules/world-atlas/countries-110m.json"), "utf8"));

const CENTER_LON = 155;
const WIDTH = 1000;
const LAT_TOP = 80;
const LAT_BOTTOM = -57;
const URAL_LON = 60;

// ISO 3166-1 の国番号 (国番号のない地域は名前) → 地域
const REGION_OF = {
  namerica: "124 840 304",
  latam: "484 320 084 222 340 558 188 591 192 332 214 388 044 630 780 170 862 328 740 218 604 076 068 600 152 032 858 238",
  europe: "352 578 752 246 208 826 372 528 056 442 250 724 620 276 756 040 380 705 191 070 688 499 Kosovo 008 807 300 100 642 498 804 112 616 203 703 348 440 428 233 643 268 051 031 196 N._Cyprus",
  mideast: "792 760 422 376 275 400 368 364 682 887 512 784 634 414 818",
  africa: "504 732 012 788 434 729 728 231 232 262 706 Somaliland 404 800 646 108 834 508 454 894 716 072 516 710 426 748 450 024 180 178 266 226 120 140 148 562 566 204 768 288 384 430 694 324 624 270 686 478 466 854",
  asia: "156 158 410 408 496 704 418 116 764 104 458 096 360 608 626 356 050 064 524 144 586 004 398 860 417 762 795",
  japan: "392",
  oceania: "036 554 598 090 548 540 242",
};
const EXCLUDE = new Set(["010", "260"]); // 南極・仏領南方南極地域
const regionByKey = new Map();
for (const [region, keys] of Object.entries(REGION_OF)) {
  for (const k of keys.split(" ")) regionByKey.set(k.replace("_", " "), region);
}
const keyOf = (g) => g.id ?? g.properties.name;

// 地図上のラベルの位置 [経度, 緯度] (重心ではなく、読み手が地域名を探す場所に置く)。
// 日本は小さく隣のアジアのラベルと重なるので、太平洋側に出して引き出し線でつなぐ (PINS が日本の位置)
const LABELS = {
  japan: [158, 29],
  asia: [96, 34],
  europe: [16, 51],
  mideast: [46, 27],
  africa: [20, 4],
  namerica: [-100, 43],
  latam: [-62, -12],
  oceania: [137, -25],
};
const PINS = { japan: [138.5, 36.5] };
// 地域を選んだときに拡大する範囲 [西端経度, 南端緯度, 東端経度, 北端緯度]
const ZOOM = {
  japan: [123, 23, 151, 47],
  asia: [60, -11, 150, 56],
  europe: [-25, 33, 62, 72],
  mideast: [24, 11, 64, 43],
  africa: [-20, -36, 53, 38],
  namerica: [-170, 14, -50, 74],
  latam: [-118, -56, -33, 33],
  oceania: [110, -48, 182, 2],
};

const projection = geoNaturalEarth1().rotate([-CENTER_LON, 0]).fitWidth(WIDTH, { type: "Sphere" });
const pathGen = geoPath(projection).digits(1);
const [, top] = projection([CENTER_LON, LAT_TOP]);
const [, bottom] = projection([CENTER_LON, LAT_BOTTOM]);
const round = (v) => Math.round(v * 10) / 10;

// ---- ロシアをウラル山脈で、フランスを本土と仏領ギアナに分ける ----

// 経度 x = URAL_LON の線で多角形の輪を切る (Sutherland–Hodgman)。keepEast で東側/西側を選ぶ。
// 東経180度を越えるチュクチ半島 (経度がマイナス) は +360 して東側として扱う
function clipRing(ring, keepEast) {
  const pts = ring.map(([x, y]) => [x < 0 ? x + 360 : x, y]);
  const inside = ([x]) => (keepEast ? x >= URAL_LON : x <= URAL_LON);
  const cross = ([x1, y1], [x2, y2]) => [URAL_LON, y1 + ((URAL_LON - x1) * (y2 - y1)) / (x2 - x1)];
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (inside(a)) {
      out.push(a);
      if (!inside(b)) out.push(cross(a, b));
    } else if (inside(b)) {
      out.push(cross(a, b));
    }
  }
  if (out.length < 3) return null;
  out.push(out[0]);
  return out.map(([x, y]) => [x > 180 ? x - 360 : x, y]);
}

function splitRussia(geometry) {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const west = [];
  const east = [];
  const seam = [];
  for (const rings of polys) {
    const w = rings.map((r) => clipRing(r, false)).filter(Boolean);
    const e = rings.map((r) => clipRing(r, true)).filter(Boolean);
    if (w.length) west.push(w);
    if (e.length) east.push(e);
    // 切り口 (経線上で隣り合う2点) をウラルの境界線として残す
    for (const ring of w) {
      for (let i = 0; i < ring.length - 1; i++) {
        if (ring[i][0] === URAL_LON && ring[i + 1][0] === URAL_LON) seam.push([ring[i], ring[i + 1]]);
      }
    }
  }
  return {
    pieces: [
      ["europe", { type: "MultiPolygon", coordinates: west }],
      ["asia", { type: "MultiPolygon", coordinates: east }],
    ],
    seam,
  };
}

function splitFrance(geometry) {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const meanLon = (rings) => rings[0].reduce((n, [x]) => n + x, 0) / rings[0].length;
  return [
    ["europe", { type: "MultiPolygon", coordinates: polys.filter((p) => meanLon(p) > -30) }],
    ["latam", { type: "MultiPolygon", coordinates: polys.filter((p) => meanLon(p) <= -30) }],
  ];
}

// ---- 地域ごとの塗り ----

const countries = world.objects.countries;
const regionPaths = Object.fromEntries(Object.keys(REGION_OF).map((r) => [r, []]));
let uralSeam = [];
const missing = [];
for (const g of countries.geometries) {
  const key = keyOf(g);
  if (EXCLUDE.has(key)) continue;
  const region = regionByKey.get(key);
  if (!region) {
    missing.push(`${key}:${g.properties.name}`);
    continue;
  }
  const f = feature(world, g);
  let pieces = [[region, f.geometry]];
  if (key === "643") {
    const r = splitRussia(f.geometry);
    pieces = r.pieces;
    uralSeam = r.seam;
  } else if (key === "250") {
    pieces = splitFrance(f.geometry);
  }
  for (const [r, geom] of pieces) {
    const d = pathGen(geom);
    if (d) regionPaths[r].push(d);
  }
}
if (missing.length) throw new Error(`地域が決まっていない国があります: ${missing.join(", ")}`);

// ---- 境界線 ----

// 国境の線を引くときの地域。ロシアは中国・モンゴル・北朝鮮との国境だけアジア側として扱う
const ASIAN_RUSSIA_NEIGHBORS = new Set(["156", "496", "408"]);
function borderRegion(g, other) {
  const key = keyOf(g);
  if (key === "643" && ASIAN_RUSSIA_NEIGHBORS.has(keyOf(other))) return "asia";
  return regionByKey.get(key);
}
const visible = (g) => !EXCLUDE.has(keyOf(g));
// 同じ地域の中の国境 (細い線)
const inner = mesh(world, countries, (a, b) => a !== b && visible(a) && visible(b) && borderRegion(a, b) === borderRegion(b, a));
// 地域と地域の境目 (塗りの切れ目として白く太めに引く)。海岸線は地域の塗りの輪郭で描くので持たない
const seams = mesh(world, countries, (a, b) => a !== b && visible(a) && visible(b) && borderRegion(a, b) !== borderRegion(b, a));
seams.coordinates.push(...uralSeam);

// ---- ラベル位置と拡大範囲 ----

const labels = Object.fromEntries(Object.entries(LABELS).map(([r, ll]) => [r, projection(ll).map(round)]));
const pins = Object.fromEntries(Object.entries(PINS).map(([r, ll]) => [r, projection(ll).map(round)]));

function zoomBox([w, s, e, n]) {
  const xs = [];
  const ys = [];
  for (let i = 0; i <= 12; i++) {
    for (let j = 0; j <= 12; j++) {
      let lon = w + ((e - w) * i) / 12;
      if (lon > 180) lon -= 360;
      const [x, y] = projection([lon, s + ((n - s) * j) / 12]);
      xs.push(x);
      ys.push(y);
    }
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(round);
}
const boxes = Object.fromEntries(Object.entries(ZOOM).map(([r, b]) => [r, zoomBox(b)]));

// ---- 書き出し ----

const graticule = pathGen(geoGraticule().step([30, 30]).extentMajor([[-180, -60], [180, 85]])());
const out = {
  source: "Natural Earth 1:110m (public domain) via world-atlas",
  viewBox: [0, round(top), WIDTH, round(bottom - top)],
  sphere: pathGen({ type: "Sphere" }),
  graticule,
  regions: Object.fromEntries(Object.entries(regionPaths).map(([r, ds]) => [r, ds.join("")])),
  inner: pathGen(inner),
  seams: pathGen(seams),
  labels,
  pins,
  boxes,
};
await writeFile(path.join(ROOT, "public/world-map.json"), JSON.stringify(out));
const size = Buffer.byteLength(JSON.stringify(out));
console.log(`public/world-map.json: ${(size / 1024).toFixed(1)} KB, viewBox ${out.viewBox.join(" ")}`);
for (const [r, d] of Object.entries(out.regions)) console.log(`  ${r}: ${(d.length / 1024).toFixed(1)} KB`);
