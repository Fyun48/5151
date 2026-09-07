/* 吉比租房：系統推播與加入主畫面。沒有 VAPID 時仍可在分頁開著時用 Notification API。 */
// Cache 版本集中管理：換版時只需 bump CACHE_VERSION。CACHE 名稱一律以 CACHE_PREFIX 開頭，
// activate 時只清除「本站、本 Service Worker 管理」的舊版本 cache，不動其它來源/其它前綴的 cache。
const CACHE_PREFIX = "jibi-shell-";
const CACHE_VERSION = "v4";
const CACHE = CACHE_PREFIX + CACHE_VERSION;

self.addEventListener("install", (event) => {
  // 新版本 install 完成即接手，避免使用者停留在舊 shell。
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  // 安全清除本站舊版本 cache（僅限 CACHE_PREFIX 開頭且非目前版本），再接管所有頁面。
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(req).catch(() => caches.match(req).then((hit) => hit || caches.match("/"))),
  );
});

self.addEventListener("push", (event) => {
  let data = { title: "吉比租房物件追蹤", body: "有新的物件更新", url: "/" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    try {
      data.body = event.data.text();
    } catch {
      // keep default
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "吉比租房物件追蹤", {
      body: data.body || "有新的物件更新",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification?.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const hit = windows.find((client) => "focus" in client);
      if (hit) return hit.navigate(target).then((client) => client.focus()).catch(() => hit.focus());
      return self.clients.openWindow(target);
    }),
  );
});
