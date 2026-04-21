const CACHE_NAME = 'mlb-hrr-v3';
self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('hrr-data.json')) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return fetch(event.request).then((res) => {
          cache.put(event.request, res.clone());
          return res;
        }).catch(() => cache.match(event.request));
      })
    );
  }
});
