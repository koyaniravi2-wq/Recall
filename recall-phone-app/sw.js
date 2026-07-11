/* Recall service worker — offline-first app shell.
 * Stale-while-revalidate: serves from cache instantly (fast + offline),
 * refreshes the cache in the background so the next launch is up to date. */
const CACHE = "recall-cache-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

/* ---------------- daily "Idea of the day" notification -------------------
 * Uses Periodic Background Sync (Android Chrome, installed PWA). Picks the
 * same deterministic idea-of-the-day as the app UI and shows it once a day. */

function dayKey(d = new Date()) {
  const p = (x) => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function readStore() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open("recall-db", 1);
      req.onsuccess = () => {
        try {
          const g = req.result.transaction("kv").objectStore("kv").get("store");
          g.onsuccess = () => resolve(g.result || null);
          g.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      };
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

async function showDailyIdea(force) {
  const store = await readStore();
  if (!store || !store.recall_data_v2) return;
  let data; try { data = JSON.parse(store.recall_data_v2); } catch (e) { return; }
  const notes = Array.isArray(data.notes) ? data.notes : [];
  if (!notes.length) return;
  const k = dayKey();
  if (!force && store["recall.lastIdeaNotif"] === k) return;   // once per day
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) % 99991;
  const n = notes[h % notes.length];
  const body = String(n.takeaway || n.content || "").replace(/==/g, "").slice(0, 140);
  await self.registration.showNotification("💡 Idea of the day", {
    body: n.title + (body ? "\n" + body : ""),
    tag: "recall-daily-idea",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    data: { noteId: n.id },
  });
  // remember we already notified today
  try {
    const req = indexedDB.open("recall-db", 1);
    req.onsuccess = () => {
      store["recall.lastIdeaNotif"] = k;
      try { req.result.transaction("kv", "readwrite").objectStore("kv").put(store, "store"); }
      catch (e) {}
    };
  } catch (e) {}
}

self.addEventListener("periodicsync", (e) => {
  if (e.tag === "recall-daily-idea") e.waitUntil(showDailyIdea(false));
});

self.addEventListener("message", (e) => {
  if (e.data === "recall-test-notification") showDailyIdea(true);
  if (e.data === "recall-daily-check") showDailyIdea(false);
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (list.length) return list[0].focus();
    return self.clients.openWindow("./");
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;      // never cache Google APIs
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: url.pathname.endsWith("/") });
    const refresh = fetch(req).then((r) => {
      if (r && r.ok) cache.put(req, r.clone());
      return r;
    }).catch(() => null);
    return cached || (await refresh) ||
      new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  })());
});
