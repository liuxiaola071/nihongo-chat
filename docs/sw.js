// 日语聊天 — Service Worker（网络优先 + 离线兜底）
const CACHE = 'nihongo-v16';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(['./', './index.html', './style.css', './app.js', './manifest.json', './icon.svg']))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // 清理旧版本缓存，否则更新代码后用户看到的还是旧版
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // API 请求永远走网络，不缓存
  if (e.request.url.includes('/api/')) return;
  // 页面资源：网络优先，失败了用缓存（离线也能打开）
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
