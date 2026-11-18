const CACHE_NAME = 'purecloud-shell-v1';
const SHELL_ASSETS = [
    './',
    'assets/css/app.css',
    'assets/js/app.js',
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

// Network-first for shell assets, bypass cache for API/Auth/Downloads
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.pathname.endsWith('api.php') || url.pathname.endsWith('share.php') || url.pathname.endsWith('webdav.php')) {
        return;
    }
    event.respondWith(
        fetch(req)
            .then((res) => {
                if (res && res.status === 200 && (url.pathname.endsWith('.css') || url.pathname.endsWith('.js'))) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => {});
                }
                return res;
            })
            .catch(() => caches.match(req))
    );
});
