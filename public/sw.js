const CACHE = "warota-v18";
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./thread.js",
  "./world.js",
  "./weather.js",
  "./radar.js",
  "./world-map.json",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];
const DATA_FILES = ["data.json", "world.json"];
// 雨雲レーダーの地図の画像 (地理院タイル)。一度読んだものはここに残して、次からすぐに出す (版を上げても消さない)
const TILES = "warota-tiles";
const TILE_HOST = "https://cyberjapandata.gsi.go.jp";
const MAX_TILES = 400;

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 常にネットワーク優先で最新版を取得し、オフライン時だけキャッシュを使う。
// cache:"no-cache" でHTTPキャッシュも再検証させ、更新の反映漏れを防ぐ。
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "GET" && url.origin === TILE_HOST) {
    e.respondWith(tile(e));
    return;
  }
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  // 記事データ (data.json / world.json) は ?t= 付きで取りに来るので、キャッシュはファイル名だけで持つ
  const dataFile = DATA_FILES.find((f) => url.pathname.endsWith(`/${f}`));
  const key = dataFile ? `./${dataFile}` : e.request;
  e.respondWith(
    fetch(e.request, { cache: dataFile ? "no-store" : "no-cache" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(key).then((cached) => {
          if (cached) return cached;
          throw new Error("offline");
        })
      )
  );
});

// 地図の画像: 残っていればそれを、なければ取りに行って残す (多くなったら古いものから消す)
let tilePuts = 0;
async function tile(e) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(e.request);
  if (hit) return hit;
  const res = await fetch(e.request);
  if (res.ok && res.type === "cors") {
    // 画面には先に返し、残すのは後で
    const copy = res.clone();
    e.waitUntil(
      (async () => {
        await cache.put(e.request, copy);
        if (++tilePuts % 50 === 0) {
          const keys = await cache.keys();
          await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_TILES)).map((k) => cache.delete(k)));
        }
      })(),
    );
  }
  return res;
}
