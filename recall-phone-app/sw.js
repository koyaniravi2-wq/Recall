/* Recall service worker — offline-first app shell.
 * Stale-while-revalidate: serves from cache instantly (fast + offline),
 * refreshes the cache in the background so the next launch is up to date. */
const CACHE = "recall-cache-v6";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name.startsWith("recall-cache-") && name !== CACHE)
    .map((name) => caches.delete(name)));
  await self.clients.claim();
})()));

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

/* ---------------- Everyday execution reminders --------------------------
 * Periodic Background Sync is best-effort (Android decides the exact wake
 * time), so we use a 20-minute grace window and de-duplicate each reminder.
 * The foreground app supplies exact minute checks while Recall is open. */
async function showPracticeReminders(force) {
  const store = await readStore();
  if (!store || !store.recall_data_v2) return;
  let data; try { data = JSON.parse(store.recall_data_v2); } catch (e) { return; }
  const practices = Array.isArray(data.practices)
    ? data.practices.filter((p) => p && !p.archivedAt && !p.archived_at
      && (!p.cadence || p.cadence === "daily")) : [];
  if (!practices.length) return;
  const now = new Date();
  const today = dayKey(now);
  const dayLog = (data.practiceLog && data.practiceLog[today]) || {};
  const done = new Set(Array.isArray(dayLog) ? dayLog
    : Object.entries(dayLog).filter(([, state]) => state && state.done).map(([id]) => id));
  const minute = now.getHours() * 60 + now.getMinutes();
  const sent = store["recall.practiceReminderSent"] || {};
  let changed = false;

  for (const p of practices) {
    if (done.has(p.id)) continue;
    const times = Array.isArray(p.reminder_times) ? p.reminder_times
      : Array.isArray(p.reminders) ? p.reminders : [];
    for (const time of times) {
      const parts = String(time).split(":").map(Number);
      if (parts.length !== 2 || parts.some(Number.isNaN)) continue;
      const dueMinute = parts[0] * 60 + parts[1];
      if (!force && (minute < dueMinute || minute > dueMinute + 20)) continue;
      const key = today + "." + p.id + "." + time;
      if (!force && sent[key]) continue;
      await self.registration.showNotification("Recall · Everyday", {
        body: (p.sourceTitle || p.daily_display_sentence || p.remember || "Idea") + "\n" +
          (p.implementation_action || p.execution || "Open your plan"),
        tag: "recall-practice-" + p.id + "-" + time,
        icon: "./icons/icon-192.png",
        badge: "./icons/icon-192.png",
        data: { practiceId: p.id, view: "everyday" },
      });
      sent[key] = true; changed = true;
      if (force) break;
    }
    if (force && changed) break;
  }

  if (changed) {
    store["recall.practiceReminderSent"] = sent;
    try {
      const req = indexedDB.open("recall-db", 1);
      req.onsuccess = () => {
        try { req.result.transaction("kv", "readwrite").objectStore("kv").put(store, "store"); }
        catch (e) {}
      };
    } catch (e) {}
  }
}

self.addEventListener("periodicsync", (e) => {
  if (e.tag === "recall-practice-reminders") e.waitUntil(showPracticeReminders(false));
});

self.addEventListener("message", (e) => {
  if (e.data === "recall-practice-check") showPracticeReminders(false);
  if (e.data === "recall-practice-test") showPracticeReminders(true);
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const target = "./?open=everyday";
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (list.length) {
      try { await list[0].navigate(target); } catch (err) {}
      return list[0].focus();
    }
    return self.clients.openWindow(target);
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
