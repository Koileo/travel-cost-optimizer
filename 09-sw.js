// 09-sw.js — Service Worker 注册
// 出行成本优化器
// 出行成本优化器 - App.js

// ===========================================================================
// Service Worker — 注册 + 版本更新检测
// ===========================================================================
if ('serviceWorker' in navigator) {
  let swNewVersion = null;

  navigator.serviceWorker.register('sw.js').then((registration) => {
    console.info('[SW] 注册成功，scope:', registration.scope);

    // 检测是否有新版本在等待
    if (registration.waiting) {
      swNewVersion = registration.waiting;
      notifyUpdateAvailable();
    }

    // 发现新 SW 正在安装 → 跟踪其状态变化
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      console.info('[SW] 发现新版本，安装中…');
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          console.info('[SW] 新版本已就绪，等待页面刷新后生效');
          swNewVersion = installing;
          notifyUpdateAvailable();
        }
      });
    });
  }).catch((err) => {
    console.warn('[SW] 注册失败:', err);
  });

  // 监听 SW 发来的版本消息
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SW_VERSION') {
      console.info(`[SW] 当前缓存版本: v${event.data.version}`);
    }
  });

  // SW 控制器变更（skipWaiting + claim 后触发）
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    console.info('[SW] 控制器已切换，新版本已接管');
  });

  // 弹出更新提示
  function notifyUpdateAvailable() {
    // 避免重复弹窗
    if (document.getElementById('sw-update-toast')) return;
    const toast = document.createElement('div');
    toast.id = 'sw-update-toast';
    toast.innerHTML = `
      <span>🔄 有新版本可用</span>
      <button id="sw-update-btn">立即更新</button>
    `;
    Object.assign(toast.style, {
      position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
      background: 'var(--card-bg, #1e1e2e)', color: 'var(--text, #cdd6f4)',
      padding: '12px 20px', borderRadius: '12px', boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
      zIndex: '9999', display: 'flex', alignItems: 'center', gap: '16px',
      fontSize: '14px', border: '1px solid var(--border, #313244)',
    });
    const btn = toast.querySelector('#sw-update-btn');
    Object.assign(btn.style, {
      background: 'var(--accent, #89b4fa)', color: '#1e1e2e',
      border: 'none', borderRadius: '8px', padding: '6px 16px',
      cursor: 'pointer', fontWeight: '600', fontSize: '13px',
    });
    btn.addEventListener('click', () => {
      // 通知等待中的 SW 跳过等待并刷新
      if (swNewVersion) {
        swNewVersion.postMessage({ type: 'SKIP_WAITING' });
      }
      // 兜底：直接刷新页面
      window.location.reload();
    });
    document.body.appendChild(toast);
  }
}

// 初始化 Lucide 图标
