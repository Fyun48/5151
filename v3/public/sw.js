/* 吉比租房：系統推播與加入主畫面。沒有 VAPID 時仍可在分頁開著時用 Notification API。 */
const CACHE = "jibi-shell-v3";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
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
