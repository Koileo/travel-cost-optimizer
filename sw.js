// Service Worker — network-first 策略 + 版本更新检测
// ===========================================================================
// 版本号：修改任何静态资源后请递增，确保旧缓存被清理
const CACHE_VERSION = 10;
const CACHE_NAME = `travel-optimizer-v${CACHE_VERSION}`;

// 静态资源：安装时预缓存（离线兜底）
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/manifest.json',
  '/app-client-entry.js',
  '/01-state.js',
  '/02-utils.js',
  '/03-algorithm.js',
  '/04-map.js',
  '/05-didi.js',
  '/06-route.js',
  '/07-ui.js',
  '/08-settings.js',
  '/09-sw.js',
];

// ===========================================================================
// Install — 预缓存静态资源，立即接管
// ===========================================================================
self.addEventListener('install', (event) => {
  console.info(`[SW] v${CACHE_VERSION} 安装中…`);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.info(`[SW] 预缓存 ${STATIC_ASSETS.length} 个静态资源`);
        return cache.addAll(STATIC_ASSETS);
      })
      .catch((err) => console.warn('[SW] 预缓存失败（可能离线）:', err))
  );
  // 新版本立即激活，不等待旧 SW 释放
  self.skipWaiting();
});

// ===========================================================================
// Activate — 清理旧版本缓存 + 接管所有页面
// ===========================================================================
self.addEventListener('activate', (event) => {
  console.info(`[SW] v${CACHE_VERSION} 激活`);
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => n.startsWith('travel-optimizer-v') && n !== CACHE_NAME)
          .map((n) => {
            console.info(`[SW] 清理旧缓存: ${n}`);
            return caches.delete(n);
          })
      )
    )
  );
  // 接管所有打开的页面（不刷新也能使用新 SW）
  self.clients.claim();
});

// ===========================================================================
// Fetch — 网络优先，失败时回退缓存（离线可用）
// ===========================================================================
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // 跳过 chrome-extension:// 等非 http(s) 请求
  const { protocol } = new URL(event.request.url);
  if (protocol !== 'https:' && protocol !== 'http:') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // 只缓存成功的响应
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // 网络失败 → 回退缓存（离线可用）
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          // 对于导航请求，回退到首页（SPA 兜底）
          if (event.request.mode === 'navigate') {
            return caches.match('/');
          }
          // 完全无法匹配，返回离线提示
          return new Response('离线 — 请检查网络连接', {
            status: 503,
            statusText: 'Offline',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        });
      })
  );
});

// ===========================================================================
// Message — 响应客户端消息
// ===========================================================================
self.addEventListener('message', (event) => {
  if (event.data === 'GET_VERSION') {
    // 向所有客户端广播当前版本
    self.clients.matchAll().then((clients) => {
      clients.forEach((client) => {
        client.postMessage({ type: 'SW_VERSION', version: CACHE_VERSION });
      });
    });
  }
  if (event.data && event.data.type === 'SKIP_WAITING') {
    // 用户点击"立即更新" → 跳过等待，立即激活新 SW
    console.info('[SW] 收到 SKIP_WAITING，立即激活');
    self.skipWaiting();
  }
});
