const CACHE_NAME = 'mlb-hrr-v3';
const DATA_URL = 'hrr-data.json';

self.addEventListener('install', (e) => self.skipWaiting());

self.addEventListener('fetch', (event) => {
  if (event.request.url.includes(DATA_URL) || event.request.url.includes('gist')) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return fetch(event.request).then((response) => {
          cache.put(event.request, response.clone());
          return response;
        }).catch(() => cache.match(event.request));
      })
    );
  }
});
