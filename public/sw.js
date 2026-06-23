// Mailcove service worker — installable PWA + offline app shell.
//
// This origin sits behind Cloudflare Access, so the SW is deliberately strict
// about WHAT it caches: it must never store an Access login/redirect page (which
// would poison the offline shell), API/auth responses, or arbitrary HTML.
//
// Strategy:
//  - /api/*, /cdn-cgi/* and any non-GET: always network, never cached.
//  - Navigations (HTML): network-first. The fresh response is cached as the app
//    shell ONLY if it's verified to BE the app shell (ok, not redirected, HTML,
//    and contains our build marker) — so an Access page is never cached. Offline
//    falls back to the cached shell.
//  - Allowlisted static assets (hashed JS/CSS, icons, manifest): stale-while-
//    revalidate, validating responses the same way. The cache is FIFO-trimmed so
//    hashed assets from old builds can't grow unbounded.

const CACHE = "Mailcove-v2";
const SHELL = "/";
// Substring of the index.html marker meta. Kept tolerant of self-closing "/>"
// and surrounding markup so a Vite re-serialize can't break shell detection.
const SHELL_MARKER = 'name="app-shell" content="Mailcove"';
const MAX_ASSETS = 64;

self.addEventListener("install", () => {
  // No precache: fetching "/" at install could capture an Access page. The shell
  // is populated by the first verified authenticated navigation instead.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

/** A same-origin, non-redirected OK response (i.e. genuinely from our origin). */
function isOwnOk(res) {
  return !!res && res.ok && res.type === "basic" && !res.redirected;
}

/** True only if `res` is our actual app shell HTML (not an Access/login page). */
async function isAppShell(res) {
  if (!isOwnOk(res)) return false;
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/html")) return false;
  try {
    const text = await res.clone().text();
    return text.includes(SHELL_MARKER);
  } catch {
    return false;
  }
}

/** Allowlist of cacheable static assets (hashed build output + PWA files). */
function isCacheableAsset(pathname) {
  return (
    pathname.startsWith("/assets/") ||
    /^\/icon(-\d+)?\.(png|svg)$/.test(pathname) ||
    pathname === "/apple-touch-icon.png" ||
    pathname === "/manifest.webmanifest"
  );
}

/** Keep the cache bounded: drop oldest asset entries past MAX_ASSETS (FIFO). */
async function trimCache(cache) {
  const keys = await cache.keys();
  const assetKeys = keys.filter((req) => {
    try {
      return isCacheableAsset(new URL(req.url).pathname);
    } catch {
      return false;
    }
  });
  for (let i = 0; i < assetKeys.length - MAX_ASSETS; i++) {
    await cache.delete(assetKeys[i]);
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return; // cross-origin: passthrough
  if (url.pathname.startsWith("/api/")) return; // mail/auth API: always live
  if (url.pathname.startsWith("/cdn-cgi/")) return; // Cloudflare Access: never cache

  // Navigations → network-first, cache only a verified app shell.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          if (await isAppShell(fresh)) {
            const cache = await caches.open(CACHE);
            cache.put(SHELL, fresh.clone()).catch(() => {});
          }
          return fresh;
        } catch {
          const cached = await caches.match(SHELL);
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  // Allowlisted static assets → stale-while-revalidate (validated).
  if (isCacheableAsset(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(req);
        const network = fetch(req)
          .then(async (res) => {
            if (isOwnOk(res)) {
              await cache.put(req, res.clone()).catch(() => {});
              await trimCache(cache).catch(() => {});
            }
            return res;
          })
          .catch(() => null);
        return cached || (await network) || Response.error();
      })(),
    );
    return;
  }

  // Everything else same-origin: straight to network, no caching.
});

// ---- Web Push (active once the client subscribes; see app/lib/push.ts) ----
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Mailcove", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "New mail";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag || "Mailcove-mail",
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of all) {
        if ("focus" in c) {
          c.navigate(target).catch(() => {});
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })(),
  );
});
