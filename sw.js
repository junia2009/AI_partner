// AIパラス の Service Worker
// - アプリ本体（index.html など）は「ネット優先、つながらなければ保存しておいた版」
//   → 更新はすぐ反映され、電波が悪くても画面は開ける
// - CDN のライブラリ（three.js、Anthropic SDK）はバージョン固定なので「保存版優先」で速く起動
// - Claude や Fish Audio への通信（POST）は一切保存しない

const VERSION = "pallas-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // バージョン固定の CDN ライブラリ：保存版を優先
  if (url.hostname === "cdn.jsdelivr.net") {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // 同じサイト内のファイル：ネット優先、失敗したら保存版
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(req)) || (await caches.match("./index.html")))
    );
  }
});
