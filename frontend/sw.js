// 日本語チャット — Service Worker（离线缓存）
const CACHE = 'nihongo-v1';
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(['/','/manifest.json']))
  );
  self.skipWaiting();
});
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
