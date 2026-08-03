const CACHE = "warota-v4";
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 常にネットワーク優先で最新版を取得し、オフライン時だけキャッシュを使う。
// cache:"no-cache" でHTTPキャッシュも再検証させ、更新の反映漏れを防ぐ。
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  const isData = url.pathname.endsWith("/data.json");
  e.respondWith(
    fetch(e.request, { cache: isData ? "no-store" : "no-cache" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          const key = isData ? "./data.json" : e.request;
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(isData ? "./data.json" : e.request).then((cached) => {
          if (cached) return cached;
          throw new Error("offline");
        })
      )
  );
});
