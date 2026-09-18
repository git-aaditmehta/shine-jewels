const CACHE='shine-jewels-v2';
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(Promise.all([
  caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))),
  self.clients.claim()
])));
self.addEventListener('fetch', event => {
  const request=event.request;
  const url=new URL(request.url);
  if(request.method !== 'GET' || url.origin !== self.location.origin || !['http:','https:'].includes(url.protocol)) return;
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if(!response.ok) return response;
    const copy=response.clone();
    event.waitUntil(caches.open(CACHE).then(cache => cache.put(request,copy)));
    return response;
  }).catch(() => cached || Response.error())));
});
