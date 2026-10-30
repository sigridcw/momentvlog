/**
 * A deliberately small service worker: enough to install the app to the Home
 * Screen and open it offline, with no build-time precache manifest to drift
 * out of date.
 *
 * On install it fetches index.html and reads the hashed asset URLs straight
 * out of it, then reads *those* for the names they mention in turn — which
 * is how the metadata parser worker gets cached, since the bundler names it
 * inside the main script rather than in the HTML. So the exact files this
 * build needs are cached without anything having to be generated. (Runtime
 * caching alone is not enough: the very first page load happens before this
 * worker is controlling the page, so those requests would never pass
 * through it.)
 *
 * Why it matters past the offline promise: importing forty files must not
 * touch the network at all. The parser worker, the stylesheet, the fonts
 * (system, so there are none to fetch) and the default music track are all
 * on disk after the first load, so a hotel Wi-Fi dropping out mid-import
 * cannot be the reason an import fails.
 *
 * Video blobs never touch this cache — they live in IndexedDB.
 *
 * The one rule that matters more than any of the rest: **index.html is
 * always network first**. Everything else here is content-hashed and safe to
 * serve from cache forever, but the shell is what names those hashes, so a
 * stale copy of it pins the whole app to an old build. That is not
 * hypothetical — the owner spent a round of feedback reporting a bug that
 * had already been fixed, because her Home Screen app was still running
 * last week's code. The page asks for an update on every load and every
 * time it comes back to the foreground, and reloads itself once when a new
 * worker takes over (see `main.ts`).
 */

const CACHE = 'moment-vlog-v6';
const EXTRA = [
  './',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  /**
   * The track the app suggests when it has nothing to go on.
   *
   * Music is not needed to import — it is chosen at the end and only
   * actually played when something plays — but a flaky connection should
   * not be able to make the one default track unavailable either, and one
   * and a half megabytes buys that outright. The other seventeen are
   * cached by the fetch handler the first time each is heard.
   */
  './music/carefree.m4a',
];

/**
 * Static hosts (including `vite preview` and Vercel) answer with
 * `Vary: Origin`, and a module script tagged `crossorigin` sends an Origin
 * header the service worker's own fetch did not. Without ignoring Vary those
 * two never match and the app comes up blank offline.
 */
const MATCH_OPTIONS = { ignoreVary: true };

/** Pulls `src`/`href` targets out of the shell HTML. */
function assetUrlsFrom(html) {
  const urls = new Set();
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const url = match[1];
    if (!url || url.startsWith('http') || url.startsWith('data:') || url.startsWith('#')) continue;
    urls.add(url);
  }
  return [...urls];
}

/**
 * Pulls hashed asset names out of a bundle, resolved against the bundle.
 *
 * The shell HTML names the main script and the stylesheet, and that was all
 * this worker ever cached. It missed the one asset the import cannot do
 * without: the metadata parser worker, which the bundler emits as a separate
 * file and names *inside* the main script —
 *
 *   new Worker(new URL("worker-D5R07p5H.js", import.meta.url))
 *
 * On a first load over a bad connection that file would simply fail to
 * fetch, and the parser pool would fall back to reading sixty files on the
 * main thread. It worked, slowly, and it had no business depending on the
 * network at all. So the bundle is read as text and the hashed names in it
 * are cached too, which keeps this worker free of a generated manifest: it
 * reads the build rather than being told about it.
 */
function nestedUrlsFrom(source, baseUrl) {
  const urls = new Set();
  for (const match of source.matchAll(/["'`]([\w.-]+-[A-Za-z0-9_-]{6,12}\.(?:js|css|wasm))["'`]/g)) {
    try {
      urls.add(new URL(match[1], baseUrl).href);
    } catch {
      // Not a resolvable name; nothing to cache.
    }
  }
  return [...urls];
}

async function precache() {
  const cache = await caches.open(CACHE);
  let assets = [];

  try {
    const response = await fetch('./index.html', { cache: 'reload' });
    if (response.ok) {
      const html = await response.clone().text();
      assets = assetUrlsFrom(html);
      await cache.put('./index.html', response);
    }
  } catch {
    // Offline during install: whatever is already cached still serves.
  }

  /** Caches one URL, and hands back its text when it is a script. */
  const take = async (url) => {
    try {
      const response = await fetch(url, { cache: 'reload' });
      if (!response.ok) return null;
      const isScript = new URL(response.url ?? url, self.location.href).pathname.endsWith('.js');
      const text = isScript ? await response.clone().text() : null;
      await cache.put(url, response);
      return text ? { url, text } : null;
    } catch {
      return null;
    }
  };

  // One at a time, so a single missing file cannot fail the whole install.
  const scripts = (await Promise.all([...EXTRA, ...assets].map(take))).filter(Boolean);

  // Then whatever those scripts name — the parser worker, above all.
  const nested = new Set();
  for (const script of scripts) {
    const base = new URL(script.url, self.location.href).href;
    for (const url of nestedUrlsFrom(script.text, base)) nested.add(url);
  }
  await Promise.all([...nested].map(take));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The shell — however it is asked for — is network first, so a new build
  // is picked up the moment there is one. `mode === 'navigate'` covers the
  // usual case; the explicit path check covers a standalone Home Screen app
  // restoring a session, which does not always present as a navigation.
  const isShell =
    request.mode === 'navigate' ||
    url.pathname.endsWith('/index.html') ||
    url.pathname === '/' ||
    url.pathname === self.registration.scope.replace(self.location.origin, '');

  if (isShell) {
    event.respondWith(
      // `cache: 'no-store'` so the HTTP cache cannot hand back the same
      // stale shell the service worker is trying to get past.
      fetch(request, { cache: 'no-store' })
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() =>
          caches
            .match('./index.html', MATCH_OPTIONS)
            .then((cached) => cached ?? caches.match('./', MATCH_OPTIONS))
            .then((cached) => cached ?? Response.error()),
        ),
    );
    return;
  }

  // Everything else: cache first, since build assets are content-hashed.
  event.respondWith(
    caches.match(request, MATCH_OPTIONS).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached ?? Response.error());
    }),
  );
});
