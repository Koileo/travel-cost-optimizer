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
function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

// Emoji → Lucide 名称映射（用于动态渲染的描述文字）
const ICON_MAP = {
  '🚇': 'train-front',
  '🚌': 'bus',
  '🚕': 'car-taxi-front',
  '🚖': 'car-taxi-front',
  '🚗': 'car',
  '🚶': 'footprints',
  '🚴': 'bike',
  '⏱': 'clock',
  '⏱️': 'clock',
};

// 将含 emoji 的描述文字转换为带 Lucide 图标的 HTML
function descriptionToHtml(desc) {
  if (!desc) return '';
  // 按 '→' 拆分步骤，再按空格 / emoji 切分 token
  return desc.split(/\s*→\s*/).map(step => {
    const trimmed = step.trim();
    if (!trimmed) return '';
    // 找出步骤里的第一个 emoji，映射成 Lucide
    const emojiMatch = trimmed.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    const iconName = emojiMatch ? ICON_MAP[emojiMatch[0]] : null;
    const label = trimmed.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
    const iconHtml = iconName
      ? `<i data-lucide="${iconName}"></i>`
      : '';
    return `<span class="desc-step">${iconHtml}<span>${label}</span></span>`;
  }).join('<span class="desc-arrow">→</span>');
}

// 徽章配置
const BADGE_META = {
  best:       { label: '当前最优', icon: 'award' },
  fast:       { label: '最快',   icon: 'zap' },
  recommended:{ label: '推荐',   icon: 'thumbs-up' },
};

// 类别配置
const CATEGORY_META = {
  transit: { label: '全程公交', icon: 'bus' },
  taxi:    { label: '全程打车', icon: 'car-taxi-front' },
  hybrid:  { label: '混合',     icon: 'shuffle' },
  walk:    { label: '全程步行', icon: 'footprints' },
  ride:    { label: '全程骑行', icon: 'bike' },
};

// 高德地图配置
const AMAP_KEY = '0d6897af1d905d14d1dc553850ee051f';
let map, transfer;
let _autoCompleteStart, _autoCompleteEnd, _placeSearchStart, _placeSearchEnd;

// 成本计算配置
const COST_CONFIG = {
  taxi: {
    base: 14,      // 起步价
    perKm: 2.3,    // 每公里价格
    perMin: 0.5    // 每分钟等待
  },
  bus: {
    base: 2,       // 公交基础价
    perKm: 0.1     // 公交每公里加价
  },
  subway: {
    base: 3,       // 地铁基础价
    perKm: 0.4     // 地铁每公里加价
  },
  walk: {
    perKm: 0       // 步行免费
  }
};

// DOM 元素
const startInput = document.getElementById('start-input');
const endInput = document.getElementById('end-input');
const gpsBtn = document.getElementById('gps-btn');
const swapBtn = document.getElementById('swap-btn');
const searchBtn = document.getElementById('search-btn');
const resultsList = document.getElementById('results-list');
const mapContainer = document.getElementById('map-container');
const modal = document.getElementById('route-detail-modal');
const modalBody = document.getElementById('modal-body');
const closeModal = document.getElementById('close-modal');

// 状态
let currentLocation = null;
let startPOI = null;
let endPOI = null;
let allRoutes = [];
let passengerCount = 1;
let _lastResults = []; // 缓存最近一次搜索结果，人数变化时重渲染
const SAVED_SEARCH_KEY = 'travel-optimizer-last-search';

const COMFORT_WEIGHTS = {
  walk: 1,
  ride: 0.62,
  bus: 0.45,
  subway: 0.3,
  transit: 0.4,
  taxi: 0.1,
};

// 天气舒适度惩罚系数（用于 walk 和 ride）
let _currentWeather = null; // { temp, weather, humidity }

async function fetchWeather(city) {
  return new Promise((resolve) => {
    let settled = false;
    // 5 秒超时，防止插件加载失败导致 Promise 永不 resolve
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; console.warn('[天气] 超时，跳过'); resolve(null); }
    }, 5000);

    try {
      AMap.plugin('AMap.Weather', () => {
        if (settled) return;
        const weather = new AMap.Weather();
        weather.getLive(city, (err, data) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (err || !data) {
            console.warn('[天气] 获取失败，使用默认值:', err);
            resolve(null);
            return;
          }
          const info = {
            temp: data.temperature != null ? Number(data.temperature) : null,
            weather: data.weather || '',
            humidity: data.humidity != null ? Number(data.humidity) : null,
            reportTime: data.reportTime || '',
          };
          console.info('[天气] 获取成功:', info);
          resolve(info);
        });
      });
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(timeout); console.warn('[天气] 插件异常:', e); resolve(null); }
    }
  });
}

// 城市 → 地图中心坐标（用于初始化和切换城市时定位）
const CITY_CENTERS = {
  '北京': [116.397428, 39.90923],
  '北京市': [116.397428, 39.90923],
  '上海': [121.473701, 31.230416],
  '上海市': [121.473701, 31.230416],
  '广州': [113.264385, 23.129112],
  '广州市': [113.264385, 23.129112],
  '深圳': [114.057868, 22.543099],
  '深圳市': [114.057868, 22.543099],
  '杭州': [120.155070, 30.274084],
  '杭州市': [120.155070, 30.274084],
  '成都': [104.066541, 30.572815],
  '成都市': [104.066541, 30.572815],
};

function getCityCenter(city) {
  return CITY_CENTERS[city] || [116.397428, 39.90923]; // 兜底北京
}

// 初始化地图
function initMap() {
  const container = document.getElementById('map-container');
  if (!container) {
    console.error('地图容器不存在');
    return;
  }

  const city = appSettings.city || '北京';
  map = new AMap.Map('map-container', {
    zoom: 14,
    center: getCityCenter(city),
    resizeEnable: true
  });

  // 等地图完全初始化后再创建 Transfer，避免 SDK 内部状态未就绪
  map.on('complete', () => {
    transfer = new AMap.Transfer({
      city: city,
      panel: null,
      outlineColor: '#1A73E8'
    });
  });

  // 初始化搜索插件（AutoComplete 模糊匹配 + PlaceSearch 精确定位）
  AMap.plugin(['AMap.PlaceSearch', 'AMap.AutoComplete'], () => {
    const city = appSettings.city || '北京';

    _placeSearchStart = new AMap.PlaceSearch({
      pageSize: 10, pageIndex: 1, city, citylimit: true,
    });
    _placeSearchEnd = new AMap.PlaceSearch({
      pageSize: 10, pageIndex: 1, city, citylimit: true,
    });
    _autoCompleteStart = new AMap.AutoComplete({ city, citylimit: true });
    _autoCompleteEnd = new AMap.AutoComplete({ city, citylimit: true });

    const startDropdown = document.getElementById('start-dropdown');
    const endDropdown = document.getElementById('end-dropdown');

    // 渲染下拉列表（统一 PlaceSearch/AutoComplete 结果）
    function renderDropdown(dropdown, tips, callback) {
      if (!tips || tips.length === 0) {
        dropdown.classList.remove('show');
        return;
      }
      dropdown.innerHTML = tips.map((tip, idx) => {
        // AutoComplete 返回 {name, district, address, location}
        // PlaceSearch 返回 poi {id, name, address, location}
        const name = tip.name || '';
        const addr = tip.district || tip.address || '';
        return `
          <div class="autocomplete-item" data-idx="${idx}">
            <div class="item-name">${name}</div>
            <div class="item-address">${addr}</div>
          </div>
        `;
      }).join('');
      dropdown.classList.add('show');

      dropdown.querySelectorAll('.autocomplete-item').forEach(item => {
        item.addEventListener('click', () => {
          const tip = tips[parseInt(item.dataset.idx)];
          if (tip && tip.location) {
            callback({
              location: tip.location,
              name: tip.name,
              address: tip.district || tip.address || '',
            });
          }
          dropdown.classList.remove('show');
        });
      });
    }

    // 通用搜索：先 AutoComplete（支持模糊匹配），无结果再 PlaceSearch
    function doSearch(keyword, autoComplete, placeSearch, dropdown, callback) {
      autoComplete.search(keyword, (status, result) => {
        if (status === 'complete' && result.tips && result.tips.length > 0) {
          // AutoComplete 结果：只保留有坐标的
          const tips = result.tips.filter(t => t.location && t.name);
          if (tips.length > 0) {
            renderDropdown(dropdown, tips, callback);
            return;
          }
        }
        // AutoComplete 无结果，回退 PlaceSearch
        placeSearch.search(keyword, (s, r) => {
          if (s === 'complete' && r.poiList && r.poiList.pois) {
            renderDropdown(dropdown, r.poiList.pois, callback);
          } else {
            dropdown.classList.remove('show');
          }
        });
      });
    }

    // 起点输入监听
    let startSearchTimer = null;
    startInput.addEventListener('input', () => {
      const keyword = startInput.value.trim();
      clearTimeout(startSearchTimer);
      if (keyword.length < 2) {
        startDropdown.classList.remove('show');
        return;
      }
      startSearchTimer = setTimeout(() => {
        doSearch(keyword, _autoCompleteStart, _placeSearchStart, startDropdown, (poi) => {
          startPOI = { location: poi.location, name: poi.name, address: poi.address };
          startInput.value = poi.name;
          startInput.closest('.input-wrapper').classList.add('selected');
          updateMapMarkers();
        });
      }, 250);
    });

    // 终点输入监听
    let endSearchTimer = null;
    endInput.addEventListener('input', () => {
      const keyword = endInput.value.trim();
      clearTimeout(endSearchTimer);
      if (keyword.length < 2) {
        endDropdown.classList.remove('show');
        return;
      }
      endSearchTimer = setTimeout(() => {
        doSearch(keyword, _autoCompleteEnd, _placeSearchEnd, endDropdown, (poi) => {
          endPOI = { location: poi.location, name: poi.name, address: poi.address };
          endInput.value = poi.name;
          endInput.closest('.input-wrapper').classList.add('selected');
          updateMapMarkers();
        });
      }, 250);
    });

    // 点击其他地方关闭下拉
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.input-wrapper')) {
        startDropdown.classList.remove('show');
        endDropdown.classList.remove('show');
      }
    });
  });
}

// 获取当前位置
function getCurrentLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('浏览器不支持定位'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { longitude, latitude } = position.coords;
        currentLocation = [longitude, latitude];
        resolve(currentLocation);
      },
      (error) => {
        reject(error);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

// 获取地址描述
async function reverseGeocode(location) {
  return new Promise((resolve) => {
    AMap.plugin('AMap.Geocoder', () => {
      const geocoder = new AMap.Geocoder();
      geocoder.getAddress(location, (status, result) => {
        if (status === 'complete') {
          resolve(result.regeocode.formattedAddress);
        } else {
          resolve('未知位置');
        }
      });
    });
  });
}

// 更新地图标记
function updateMapMarkers() {
  map.clearMap();

  if (startPOI) {
    const startMarker = new AMap.Marker({
      position: startPOI.location,
      title: '起点',
      icon: new AMap.Icon({
        size: new AMap.Size(32, 32),
        image: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle fill="%2334A853" cx="16" cy="16" r="14"/><text x="16" y="21" text-anchor="middle" fill="white" font-size="14">起点</text></svg>'
      })
    });
    map.add(startMarker);
  }

  if (endPOI) {
    const endMarker = new AMap.Marker({
      position: endPOI.location,
      title: '终点',
      icon: new AMap.Icon({
        size: new AMap.Size(32, 32),
        image: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle fill="%23EA4335" cx="16" cy="16" r="14"/><text x="16" y="21" text-anchor="middle" fill="white" font-size="14">终点</text></svg>'
      })
    });
    map.add(endMarker);
  }

  if (startPOI && endPOI) {
    map.setFitView();
  }
}

// 本地估算费用（整车/单人总价；人数分摊只在 getDisplayCost 中处理）
function calculateCost(distance, type) {
  if (type === 'taxi') {
    return estimateTaxiByLocalRules(distance, 0);
  }
  const config = COST_CONFIG[type];
  const distanceKm = distance / 1000;
  if (type === 'bus') {
    return Math.max(config.base, config.base + distanceKm * config.perKm);
  } else if (type === 'subway') {
    return Math.max(config.base, config.base + distanceKm * config.perKm);
  }
  return 0;
}

// 根据人数计算人均显示价格
// taxi: 总价分摊；transit: AMap 返回已为人均；hybrid: 出租车部分分摊 + 公交部分不变
function getDisplayCost(route) {
  if (!route) return 0;
  if (route.type === 'taxi') {
    return route.cost / passengerCount;
  }
  if (route.type === 'hybrid' && route.raw) {
    const taxiPortion = route.raw.taxiCost || 0;
    const transitPortion = route.raw.transitCost || 0;
    return taxiPortion / passengerCount + transitPortion;
  }
  return route.cost; // transit: 已是人均
}

function getSegmentMode(segment) {
  const mode = String(segment?.type || segment?.mode || segment?.transit_mode || '').toLowerCase();
  if (mode === 'subway') return 'subway';
  if (mode === 'bus') return 'bus';
  if (mode === 'transit') return String(segment?.transitMode || '').toLowerCase() || 'transit';
  return mode || 'walk';
}

function getSegmentMinutes(segment, fallbackMinutes) {
  const seconds = Number(segment?.time);
  if (Number.isFinite(seconds) && seconds > 0) return seconds / 60;
  const distance = Number(segment?.distance) || 0;
  const mode = getSegmentMode(segment);
  const speed = { walk: 1.25, ride: 4.2, bus: 6.5, subway: 9, transit: 7, taxi: 8.3 }[mode] || 5;
  return distance > 0 ? distance / speed / 60 : fallbackMinutes;
}

// 天气惩罚系数：返回 walk/ride 的额外倍数（0 = 无惩罚）
function getWeatherPenalty(weather) {
  if (!weather) return { walkBonus: 0, rideBonus: 0, label: '' };

  const temp = weather.temp;
  const weatherText = (weather.weather || '').toLowerCase();
  let tempBonus = 0;
  let labelParts = [];

  // 温度惩罚
  if (temp != null && !isNaN(temp)) {
    if (temp < 0)        { tempBonus = 2.0; labelParts.push(`${temp}°C极寒`); }
    else if (temp < 5)   { tempBonus = 1.5; labelParts.push(`${temp}°C寒冷`); }
    else if (temp < 12)  { tempBonus = 0.5; labelParts.push(`${temp}°C偏冷`); }
    else if (temp <= 28) { /* 舒适区，无惩罚 */ }
    else if (temp < 33)  { tempBonus = 0.5; labelParts.push(`${temp}°C偏热`); }
    else if (temp < 37)  { tempBonus = 1.5; labelParts.push(`${temp}°C炎热`); }
    else                 { tempBonus = 2.5; labelParts.push(`${temp}°C酷热`); }
  }

  // 降雨惩罚
  let rainBonus = 0;
  const rainPatterns = [
    { keywords: ['暴雨','大暴雨','特大暴雨','雷阵雨转暴雨'], bonus: 2.5 },
    { keywords: ['大雨','中到大雨','雷阵雨转大雨'], bonus: 1.5 },
    { keywords: ['中雨','小到中雨','阵雨','雷阵雨'], bonus: 0.8 },
    { keywords: ['小雨','毛毛雨','雨夹雪'], bonus: 0.3 },
    { keywords: ['雪','中雪','大雪','暴雪'], bonus: 1.5 },
    { keywords: ['小雪','阵雪'], bonus: 0.8 },
    { keywords: ['雾','霾','扬沙','沙尘','浮尘'], bonus: 0.3 },
  ];
  for (const { keywords, bonus } of rainPatterns) {
    if (keywords.some(k => weatherText.includes(k))) {
      rainBonus = bonus;
      labelParts.push(keywords[0]);
      break;
    }
  }

  // 高湿惩罚（闷热感，汗液不易蒸发）
  let humidityBonus = 0;
  const humidity = weather.humidity;
  if (humidity != null && !isNaN(humidity)) {
    if (humidity > 90)      { humidityBonus = 0.3; labelParts.push('高湿'); }
    else if (humidity > 80) { humidityBonus = 0.15; /* 轻微不标注 */ }
  }

  const totalBonus = tempBonus + rainBonus + humidityBonus;
  const walkBonus = totalBonus;   // 步行直接受影响
  const rideBonus = totalBonus * 1.2; // 骑行更受天气影响（风吹、路面湿滑）

  return {
    walkBonus,
    rideBonus,
    label: labelParts.length ? `⚠️ ${labelParts.join(' + ')}` : '',
  };
}

// 打车是否值得：综合步行时间 + 天气，替代硬编码距离阈值
// 步行速度 ~5 km/h ≈ 83 m/min，天气越差阈值越低
function isTaxiWorthIt(distanceMeters, { isFullTrip = false } = {}) {
  const weather = _currentWeather;
  const walkSpeedMperMin = 83; // 5 km/h
  const walkTimeMin = distanceMeters / walkSpeedMperMin;

  const penalty = getWeatherPenalty(weather);
  const penaltyMul = 1 + penalty.walkBonus;
  const effectiveWalkMin = walkTimeMin * penaltyMul;

  // 默认阈值：对应原 TAXI_MIN_FULL_M=1000m / TAXI_MIN_LEG_M=800m
  // 步行 5 km/h ≈ 83 m/min，1000m≈12min，800m≈9.6min
  let thresholdMin = isFullTrip ? 12 : 9.6;

  // 恶劣天气降低阈值（步行有效时间 = 实际时间 × (1+walkBonus)）
  if (penalty.walkBonus >= 2.0)       thresholdMin = 5;  // 极寒/酷热/暴雨
  else if (penalty.walkBonus >= 1.5)  thresholdMin = 6.5;// 寒冷/炎热/大雨
  else if (penalty.walkBonus >= 0.5)  thresholdMin = 8;  // 偏冷/偏热/中雨

  const worthIt = effectiveWalkMin >= thresholdMin;

  if (!worthIt) {
    const reason = penalty.label ? `（${penalty.label}也不值得）` : '';
    console.info(`[打车判断] ${Math.round(distanceMeters)}m → 步行约 ${Math.round(effectiveWalkMin)} 分钟 < ${thresholdMin} 分钟阈值${reason}，打车不划算`);
  }

  return { worthIt, walkTimeMin: Math.round(effectiveWalkMin), reason: penalty.label, thresholdMin };
}

// 舒适成本越低越好：出行暴露时间 + 候车/换乘负担。
function getComfortCost(route) {
  const segments = Array.isArray(route?.segments) && route.segments.length
    ? route.segments
    : [{ type: route?.type, time: (route?.time || 0) * 60 }];
  const fallbackMinutes = Math.max(1, (route?.time || 0) / segments.length);
  const weather = _currentWeather;
  const wp = getWeatherPenalty(weather);
  let discomfort = 0;
  let transitBoardings = 0;
  let taxiSegments = 0;
  let rideMinutes = 0;
  let walkMinutes = 0;

  segments.forEach(segment => {
    const mode = getSegmentMode(segment);
    const minutes = getSegmentMinutes(segment, fallbackMinutes);
    let weight = COMFORT_WEIGHTS[mode] ?? 0.5;

    // 天气对步行和骑行的惩罚
    if (mode === 'walk') {
      weight *= (1 + wp.walkBonus);
      walkMinutes += minutes;
    } else if (mode === 'ride') {
      weight *= (1 + wp.rideBonus);
      rideMinutes += minutes;
    }

    discomfort += minutes * weight;
    if (mode === 'bus' || mode === 'subway' || mode === 'transit') transitBoardings++;
    if (mode === 'taxi') taxiSegments++;
  });

  discomfort += Math.max(0, segments.length - 1) * 1.5;
  discomfort += transitBoardings * 2.5;
  discomfort += taxiSegments * 4; // 叫车与等待成本
  return Math.round(discomfort * 10) / 10;
}

function getComfortScore(route) {
  return Math.max(1, Math.round(100 / (1 + getComfortCost(route) / 24)));
}

function getComfortStars(route) {
  const score = getComfortScore(route);
  if (score >= 80) return 5;
  if (score >= 65) return 4;
  if (score >= 50) return 3;
  if (score >= 35) return 2;
  return 1;
}

// 根据星星数返回中文标签
function getComfortLabel(stars) {
  if (stars >= 5) return '极佳';
  if (stars >= 4) return '舒适';
  if (stars >= 3) return '一般';
  if (stars >= 2) return '凑合';
  return '折腾';
}

function getWeatherComfortNote() {
  if (!_currentWeather) return '';
  const wp = getWeatherPenalty(_currentWeather);
  return wp.label || '';
}

function renderComfortStars(route) {
  const stars = getComfortStars(route);
  const weatherNote = getWeatherComfortNote();
  const weatherHint = weatherNote ? ` · ${weatherNote}` : '';
  return `<span class="comfort-stars" aria-label="舒适度 ${stars} 星" title="舒适度 ${stars}/5${weatherHint}">${
    Array.from({ length: 5 }, (_, index) =>
      `<i data-lucide="star" class="comfort-star ${index < stars ? 'is-active' : ''}"></i>`
    ).join('')
  }</span>`;
}

function countTaxiSegments(route) {
  if (Number.isFinite(route?.raw?.taxiSegments)) return route.raw.taxiSegments;
  return (route?.segments || []).filter(segment => getSegmentMode(segment) === 'taxi').length;
}

function assignParetoRanks(routes) {
  const metrics = routes.map(route => ({
    cost: getDisplayCost(route),
    time: Number(route.time) || 0,
    comfort: getComfortCost(route),
  }));
  const remaining = new Set(routes.map((_, index) => index));
  let rank = 0;

  while (remaining.size > 0) {
    const frontier = [...remaining].filter(i => ![...remaining].some(j => {
      if (i === j) return false;
      const a = metrics[j], b = metrics[i];
      return a.cost <= b.cost && a.time <= b.time && a.comfort <= b.comfort &&
        (a.cost < b.cost || a.time < b.time || a.comfort < b.comfort);
    }));
    frontier.forEach(index => {
      routes[index].paretoRank = rank;
      routes[index].metrics = { ...metrics[index], comfortScore: getComfortScore(routes[index]) };
      remaining.delete(index);
    });
    rank++;
  }
}

// 三目标排序：经济、时间、舒适度都参与，每个偏好只改变权重。
function sortRoutes(routes, mode = 'balanced') {
  if (!routes || routes.length <= 1) return;

  assignParetoRanks(routes);

  const costs = routes.map(r => getDisplayCost(r));
  const times = routes.map(r => r.time || 0);
  const comforts = routes.map(r => getComfortCost(r));
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const minComfort = Math.min(...comforts);
  const maxComfort = Math.max(...comforts);
  const costRange = maxCost - minCost || 1;
  const timeRange = maxTime - minTime || 1;
  const comfortRange = maxComfort - minComfort || 1;

  // 算分
  const scores = routes.map((r, i) => {
    const costNorm = (costs[i] - minCost) / costRange;
    const timeNorm = (times[i] - minTime) / timeRange;
    const comfortNorm = (comforts[i] - minComfort) / comfortRange;
    const paretoPenalty = Math.min(r.paretoRank || 0, 3) * 0.08;

    switch (mode) {
      case 'cheapest':    return costNorm * 0.72 + timeNorm * 0.13 + comfortNorm * 0.15 + paretoPenalty;
      case 'fastest':     return costNorm * 0.13 + timeNorm * 0.72 + comfortNorm * 0.15 + paretoPenalty;
      case 'comfortable': return costNorm * 0.15 + timeNorm * 0.15 + comfortNorm * 0.7 + paretoPenalty;
      case 'balanced':
      default:            return (costNorm + timeNorm + comfortNorm) / 3 + paretoPenalty;
    }
  });

  // 原地排序（保持引用关系）
  const indexed = routes.map((r, i) => ({ r, s: scores[i] }));
  indexed.sort((a, b) => a.s - b.s);
  routes.length = 0;
  routes.push(...indexed.map(x => x.r));
}

// 计算步行距离
function calculateWalkingDistance(points) {
  let totalDistance = 0;
  for (let i = 0; i < points.length - 1; i++) {
    totalDistance += map.getDistance(points[i], points[i + 1]);
  }
  return totalDistance;
}

// 排序模式状态
let sortMode = 'balanced'; // 'cheapest' | 'fastest' | 'comfortable' | 'balanced'

// 查询基础路线并枚举多方式接驳组合。
async function searchRoutes() {
  if (!startPOI || !endPOI) {
    alert('请输入起点和终点');
    return;
  }

  // 滴滴报价有 15 分钟缓存；重复搜索不会重复请求相同行程。

  searchBtn.disabled = true;
  searchBtn.querySelector('.btn-text').hidden = true;
  searchBtn.querySelector('.btn-loading').hidden = false;
  resultsList.innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <p class="loading-text">正在查询最优路线…</p>
    </div>
  `;
  refreshIcons();

  try {
    // 各基础路网只查询一次；混合方案复用公共交通主干。
    const [[taxiRoutes, transitResult, walkingRoutes, ridingRoutes], weatherData] = await Promise.all([
      Promise.all([
        searchFullTaxi(),
        searchTransitPlans(),
        searchFullWalk(),
        searchFullRide(),
      ]),
      fetchWeather(appSettings.city || '北京'),
    ]);
    _currentWeather = weatherData;
    if (weatherData) {
      console.info('[天气] 已更新舒适度基准:', weatherData);
    }
    const traffic = extractTrafficFactor(taxiRoutes[0]);

    // 给打车路线挂上拥堵分析结果
    if (taxiRoutes[0]) {
      taxiRoutes[0].congestion = detectTaxiCongestion(taxiRoutes[0]);
    }

    const transitRoutes = buildFullTransitRoutes(transitResult);
    const fullTaxiCost = taxiRoutes[0] ? taxiRoutes[0].cost : null;
    const [
      multimodalRoutes,
      busThenTaxiRoutes,
      taxiToTransitRoutes,
      taxiTransitTaxiRoutes,
    ] = await Promise.all([
      searchTransitCombinations(traffic, transitResult),
      searchBusThenTaxi(traffic, transitResult, fullTaxiCost),
      searchTaxiToTransit(traffic, transitResult, fullTaxiCost),
      searchTaxiTransitTaxi(traffic, transitResult, fullTaxiCost),
    ]);
    const hybridRoutes = [...multimodalRoutes, ...busThenTaxiRoutes, ...taxiToTransitRoutes, ...taxiTransitTaxiRoutes];
    console.info(`[路线汇总] 混合方案: 接驳${multimodalRoutes.length} + 公交→打车${busThenTaxiRoutes.length} + 打车→公交${taxiToTransitRoutes.length} + 双打车${taxiTransitTaxiRoutes.length} = ${hybridRoutes.length}条，全程打车${taxiRoutes.length}条，公交${transitRoutes.length}条`);
    allRoutes = [...transitRoutes, ...walkingRoutes, ...ridingRoutes, ...taxiRoutes, ...hybridRoutes]
      .filter(route => countTaxiSegments(route) <= 2);

    // 检测叫车可用性 + 区域难度：Didi 失败时标记所有含打车段的路由
    const taxiRouteOk = taxiRoutes[0] && taxiRoutes[0].dataSource === 'didi';
    const hybridHasDidi = hybridRoutes.some(r => r.dataSource === 'didi');
    const didiAvailable = taxiRouteOk || hybridHasDidi;  // 至少有一条路线能拿到滴滴报价

    // 区域叫车难度：取所有 didi 路由里最差值（最低应答率 / 最长等待）
    let answerRate = null, didiDurationMinutes = null;
    for (const r of [...taxiRoutes, ...hybridRoutes]) {
      if (r.dataSource !== 'didi') continue;
      answerRate = minOrNull(answerRate, r.answerRate);
      didiDurationMinutes = maxOrNull(didiDurationMinutes, r.didiDurationMinutes);
    }
    window._taxiDifficulty = { available: didiAvailable, answerRate, didiDurationMinutes };
    window._taxiAvailable = didiAvailable;  // 兼容既有引用

    sortRoutes(allRoutes, sortMode);

    // 给"当前模式最优"打上 best 徽章
    if (allRoutes.length > 0) {
      allRoutes[0].badge = 'best';
    }

    renderResults(allRoutes.slice(0, 14));
    saveSearchState();
  } catch (error) {
    console.error('查询失败:', error);
    resultsList.innerHTML = `
      <div class="error-state">
        <div class="error-icon"><i data-lucide="alert-circle"></i></div>
        <p>查询失败: ${error.message}</p>
        <button class="retry-btn" onclick="searchRoutes()">
          <i data-lucide="rotate-cw"></i>
          <span>重试</span>
        </button>
      </div>
    `;
    refreshIcons();
  } finally {
    searchBtn.disabled = false;
    searchBtn.querySelector('.btn-text').hidden = false;
    searchBtn.querySelector('.btn-loading').hidden = true;
  }
}

// 从完整打车路线里提取「含实时路况」的平均车速（m/s）
// 用于让混合方案的"换乘站→终点"分段打车时间与实时路况一致
function extractTrafficFactor(taxiRoute) {
  if (!taxiRoute || !taxiRoute.raw) return { speedMps: 8.3 }; // 默认 30 km/h 兜底
  const r = taxiRoute.raw;
  const distance = r.distance || 0; // 米
  const time = r.time || 0;        // 秒
  if (distance <= 0 || time <= 0) return { speedMps: 8.3 };
  return { speedMps: distance / time, distance, time };
}

// 针对单个打车段的实时驾车时间查询（含路况），用于混合方案中的每段打车
// 针对单个打车段的实时驾车时间查询（含路况），用于混合方案中的每段打车
// 替代之前所有段共用一个 speedMps 的近似算法

// AMap.Driving 并发限制（避免同时发起过多请求导致失败）
let _drivingInFlight = 0;
const DRIVING_MAX_CONCURRENT = 3;

async function getDrivingTime(from, to, fallbackSpeedMps = 8.3) {
  // 并发控制：排队等待
  while (_drivingInFlight >= DRIVING_MAX_CONCURRENT) {
    await new Promise(r => setTimeout(r, 100));
  }
  _drivingInFlight++;

  try {
    return await new Promise((resolve) => {
      AMap.plugin('AMap.Driving', () => {
        const driving = new AMap.Driving({ panel: null });
        const origin = Array.isArray(from) ? new AMap.LngLat(from[0], from[1]) : from;
        const destination = Array.isArray(to) ? new AMap.LngLat(to[0], to[1]) : to;
        driving.search(origin, destination, (status, result) => {
          if (status === 'complete' && result.routes && result.routes.length > 0) {
            const route = result.routes[0];
            const dist = route.distance || 0;
            const time = route.time || 0;
            if (dist > 0 && time > 0) {
              resolve({ time, distance: dist, speedMps: dist / time });
              return;
            }
          }
          // 回退：直线距离 × 1.3 近似路网距离，默认速度算时间
          const straightDist = calculateDistance(from, to);
          const dist = Math.round(straightDist * 1.3);
          resolve({ time: Math.round(dist / fallbackSpeedMps), distance: dist, speedMps: fallbackSpeedMps });
        });
      });
    });
  } finally {
    _drivingInFlight--;
  }
}

function searchTransitPlans() {
  return new Promise((resolve) => {
    transfer.search(startPOI.location, endPOI.location, (status, result) => {
      if (status === 'complete' && result.plans && result.plans.length > 0) {
        resolve(result);
      } else {
        resolve(null);
      }
    });
  });
}

// 类别 1：全程公交/地铁（地铁优先，公交只留 1 条）
function buildFullTransitRoutes(result) {
  if (!result || !Array.isArray(result.plans)) return [];
  const makeRoute = (r, index) => ({
    id: `transit-${index}`,
    category: 'transit',
    type: 'transit',
    cost: r.cost || 2,
    time: Math.round((r.time || 0) / 60),
    distance: r.distance || 0,
    segments: r.segments || [],
    description: formatTransitDescription(r.segments),
    raw: r,
  });
  const hasSubway = r => (r.segments || []).some(s => s.transit_mode === 'SUBWAY');
  const upTo6 = result.plans.slice(0, 6);
  return [
    ...upTo6.filter(hasSubway),
    ...upTo6.filter(r => !hasSubway(r)).slice(0, 1),
  ].map(makeRoute);
}

// 类别 2：全程打车
function searchFullTaxi() {
  return new Promise((resolve) => {
    AMap.plugin('AMap.Driving', () => {
      const driving = new AMap.Driving({ panel: null });
      driving.search(startPOI.location, endPOI.location, (status, result) => {
        if (status === 'complete' && result.routes && result.routes.length > 0) {
          const route = result.routes[0];
          const distance = route.distance || 0;
          // 综合步行时间+天气判断打车是否值得
          const taxiCheck = isTaxiWorthIt(distance, { isFullTrip: true });
          console.info(`[全程打车] AMap 驾车距离 ${Math.round(distance)}m，打车判断: ${taxiCheck.worthIt ? '值得' : '不值得'}（步行${taxiCheck.walkTimeMin}min / 阈值${taxiCheck.thresholdMin}min${taxiCheck.reason ? ' ' + taxiCheck.reason : ''}）`);
          if (!taxiCheck.worthIt) {
            resolve([]);
            return;
          }
          const time = route.time || 0;
          const distanceKm = Math.round(distance / 100) / 10;

          // 用高德驾车 API 的 taxi_cost 估算价格，失败时回退本地规则。
          estimateTaxi(distance, time, startPOI.location, endPOI.location).then(taxiEst => {
            const dataSource = taxiEst.source; // 'didi' | 'amap' | 'local'
            const carTypeLabel = taxiEst.carType ? ` · ${taxiEst.carType}` : '';

            resolve([{
              id: 'taxi-only',
              category: 'taxi',
              type: 'taxi',
              cost: Math.round(taxiEst.cost * 100) / 100,
              time: Math.round(time / 60),
              distance,
              segments: [{ type: 'taxi', distance, time, lineName: `全程打车${carTypeLabel}` }],
              description: `🚕 全程打车 ${distanceKm} km${carTypeLabel}`,
              dataSource,
              answerRate: taxiEst.answerRate,
              didiDurationMinutes: taxiEst.didiDurationMinutes,
              raw: route,
            }]);
          });
        } else {
          resolve([]);
        }
      });
    });
  });
}

function searchFullWalk() {
  return new Promise(resolve => {
    AMap.plugin('AMap.Walking', () => {
      const walking = new AMap.Walking({ panel: null });
      walking.search(startPOI.location, endPOI.location, (status, result) => {
        const route = status === 'complete' && result.routes?.[0];
        if (!route) return resolve([]);
        const distance = route.distance || calculateDistance(
          [startPOI.location.lng, startPOI.location.lat],
          [endPOI.location.lng, endPOI.location.lat]
        );
        const time = route.time || Math.round(distance / 1.25);
        resolve([{
          id: 'walk-only', category: 'walk', type: 'walk', cost: 0,
          time: Math.max(1, Math.round(time / 60)), distance,
          segments: [{ type: 'walk', distance, time }],
          description: `🚶 全程步行 ${(distance / 1000).toFixed(1)} km`,
          raw: route,
        }]);
      });
    });
  });
}

function estimateRideCost(timeSeconds) {
  const billingUnits = Math.max(1, Math.ceil(timeSeconds / (15 * 60)));
  return billingUnits * 1.5;
}

function searchFullRide() {
  return new Promise(resolve => {
    AMap.plugin('AMap.Riding', () => {
      const riding = new AMap.Riding({ panel: null });
      riding.search(startPOI.location, endPOI.location, (status, result) => {
        const route = status === 'complete' && result.routes?.[0];
        if (!route) return resolve([]);
        const distance = route.distance || calculateDistance(
          [startPOI.location.lng, startPOI.location.lat],
          [endPOI.location.lng, endPOI.location.lat]
        ) * 1.15;
        const time = route.time || Math.round(distance / 4.2);
        resolve([{
          id: 'ride-only', category: 'ride', type: 'ride',
          cost: estimateRideCost(time),
          time: Math.max(1, Math.round(time / 60)), distance,
          segments: [{ type: 'ride', distance, time }],
          description: `🚴 全程骑行 ${(distance / 1000).toFixed(1)} km`,
          raw: route,
        }]);
      });
    });
  });
}

function createTransitMiddleSegments(segments) {
  return segments.map(seg => {
    if (seg.transit_mode === 'WALK') {
      return { type: 'walk', distance: seg.distance || 0, time: seg.time || 0 };
    }
    const line = seg.transit?.lines?.[0] || {};
    const info = parseLineInfo(line.name, seg.transit_mode);
    return {
      type: 'transit',
      mode: seg.transit_mode,
      transitMode: seg.transit_mode,
      distance: seg.distance || 0,
      time: seg.time || 0,
      lineName: info.direction ? `${info.line} · ${info.direction}` : info.line,
      fromStation: seg.transit?.on_station?.name || '上车',
      toStation: seg.transit?.off_station?.name || '下车',
      entrance: seg.transit?.entrance?.name || '',
      exit: seg.transit?.exit?.name || '',
    };
  });
}

async function createEndpointVariants({
  side, station, rawDistance, rawTime, traffic, origin, destination,
}) {
  const stationPoint = [station.location.lng, station.location.lat];
  const from = side === 'access' ? origin : stationPoint;
  const to = side === 'access' ? stationPoint : destination;
  const fromName = side === 'access' ? startPOI.name : station.name;
  const toName = side === 'access' ? station.name : endPOI.name;
  const directDistance = calculateDistance(from, to);
  const walkDistance = Math.max(rawDistance || 0, directDistance);
  const walkTime = rawTime > 0 ? rawTime : Math.round(walkDistance / 1.25);
  const variants = [{
    type: 'walk', icon: '🚶', label: '步行', distance: walkDistance,
    time: walkTime, cost: 0, taxiCost: 0, taxiSegments: 0,
    segment: { type: 'walk', distance: walkDistance, time: walkTime, fromStation: fromName, toStation: toName },
    mapLeg: { type: 'walk', from, to },
  }];

  if (walkDistance >= 350) {
    const rideDistance = Math.max(directDistance * 1.15, walkDistance * 0.9);
    const rideTime = Math.round(rideDistance / 4.2 + 90);
    variants.push({
      type: 'ride', icon: '🚴', label: '骑行', distance: rideDistance,
      time: rideTime, cost: estimateRideCost(rideTime), taxiCost: 0, taxiSegments: 0,
      segment: { type: 'ride', distance: rideDistance, time: rideTime, fromStation: fromName, toStation: toName },
      mapLeg: { type: 'ride', from, to },
    });
  }

  if (walkDistance >= 500) {
    // 每段打车独立查询实时驾车时间（含路况），不再共用全程打车的 speedMps
    const driving = await getDrivingTime(from, to, traffic.speedMps || 8.3);
    const taxiDistance = driving.distance;
    // 综合步行时间+天气判断打车是否值得
    const taxiCheck = isTaxiWorthIt(taxiDistance);
    console.info(`[接驳打车] ${side}端 路网${Math.round(taxiDistance)}m (直線${Math.round(calculateDistance(from,to))}m)，判断: ${taxiCheck.worthIt ? '值得' : '跳过'}（步行${taxiCheck.walkTimeMin}min/阈值${taxiCheck.thresholdMin}min）`);
    if (!taxiCheck.worthIt) {
    } else {
    const drivingTime = driving.time;
    const estimate = await estimateTaxi(taxiDistance, drivingTime, from, to, { fromName, toName });
    const carTypeSuffix = estimate.carType ? ` · ${estimate.carType}` : '';
    // 每一段独立估价，Didi 或本地兜底都会为这一段单独计算起步价。
    variants.push({
      type: 'taxi', icon: '🚕', label: `打车${carTypeSuffix}`, distance: taxiDistance,
      time: drivingTime + 5 * 60, cost: estimate.cost, taxiCost: estimate.cost,
      taxiSegments: 1, dataSource: estimate.source,
      answerRate: estimate.answerRate, didiDurationMinutes: estimate.didiDurationMinutes,
      segment: { type: 'taxi', distance: taxiDistance, time: drivingTime + 5 * 60, fromStation: fromName, toStation: toName },
      mapLeg: { type: 'taxi', from, to },
      actualSpeedMps: driving.speedMps,
    });
    }
  }

  return variants;
}

// 公交主干两端可分别接步行、骑行或打车；最多允许两段打车。
async function searchTransitCombinations(traffic = { speedMps: 8.3 }, result = null) {
  if (!result?.plans?.length) return [];
  const origin = [startPOI.location.lng, startPOI.location.lat];
  const destination = [endPOI.location.lng, endPOI.location.lat];

  const planRoutes = await Promise.all(result.plans.slice(0, 4).map(async (plan, planIndex) => {
    const segments = plan.segments || [];
    const transitIndexes = segments
      .map((seg, index) => ({ seg, index }))
      .filter(({ seg }) => seg.transit_mode === 'SUBWAY' || seg.transit_mode === 'BUS');
    if (!transitIndexes.length) return [];

    const firstIndex = transitIndexes[0].index;
    const lastIndex = transitIndexes[transitIndexes.length - 1].index;
    const entry = segments[firstIndex].transit?.on_station;
    const exit = segments[lastIndex].transit?.off_station;
    if (!isValidLocation(entry?.location) || !isValidLocation(exit?.location)) return [];

    const leading = segments.slice(0, firstIndex);
    const middleRaw = segments.slice(firstIndex, lastIndex + 1);
    const trailing = segments.slice(lastIndex + 1);
    const leadingDistance = leading.reduce((sum, seg) => sum + (seg.distance || 0), 0);
    const leadingTime = leading.reduce((sum, seg) => sum + (seg.time || 0), 0);
    const trailingDistance = trailing.reduce((sum, seg) => sum + (seg.distance || 0), 0);
    const trailingTime = trailing.reduce((sum, seg) => sum + (seg.time || 0), 0);
    const middleTime = middleRaw.reduce((sum, seg) => sum + (seg.time || 0), 0);
    const middleDistance = middleRaw.reduce((sum, seg) => sum + (seg.distance || 0), 0);
    if (middleDistance < 1000) return [];

    // 从 TransitDetails 获取结构化的出入口名称
    const entranceGate = segments[firstIndex].transit?.entrance?.name || '';
    const exitGate = segments[lastIndex].transit?.exit?.name || '';

    const [accessVariants, egressVariants] = await Promise.all([
      createEndpointVariants({
        side: 'access', station: entry, rawDistance: leadingDistance, rawTime: leadingTime,
        traffic, origin, destination,
      }),
      createEndpointVariants({
        side: 'egress', station: exit, rawDistance: trailingDistance, rawTime: trailingTime,
        traffic, origin, destination,
      }),
    ]);
    const middleSegments = createTransitMiddleSegments(middleRaw);
    const transitCost = plan.cost || 2;
    const routes = [];

    accessVariants.forEach(access => {
      egressVariants.forEach(egress => {
        if (access.type !== 'taxi' && egress.type !== 'taxi') return;
        const taxiSegments = access.taxiSegments + egress.taxiSegments;
        if (taxiSegments > 2) return;

        const taxiCost = access.taxiCost + egress.taxiCost;
        const personalCost = transitCost + (access.cost - access.taxiCost) + (egress.cost - egress.taxiCost);
        const totalCost = taxiCost + personalCost;
        // 注入入口/出口号到步行/骑行段
        const accessSeg = { ...access.segment };
        const egressSeg = { ...egress.segment };
        if (entranceGate && (access.type === 'walk' || access.type === 'ride')) {
          accessSeg.toStation = `${accessSeg.toStation}(${entranceGate})`;
        }
        if (exitGate && (egress.type === 'walk' || egress.type === 'ride')) {
          egressSeg.fromStation = `${egressSeg.fromStation}(${exitGate})`;
        }
        const detailSegments = [accessSeg, ...middleSegments, egressSeg];
        const transitLabels = middleSegments
          .filter(seg => seg.type === 'transit')
          .map(seg => `${seg.mode === 'SUBWAY' ? '🚇' : '🚌'} ${parseLineInfo(seg.lineName, seg.mode).line}`);
        const sources = [access.dataSource, egress.dataSource].filter(Boolean);
        const dataSource = sources.length ? (sources.every(source => source === 'didi') ? 'didi' : 'local') : null;

        routes.push({
          id: `multimodal-${planIndex}-${access.type}-${egress.type}`,
          category: 'hybrid', type: 'hybrid', direction: 'multimodal',
          cost: Math.round(totalCost * 100) / 100,
          time: Math.max(1, Math.round((access.time + middleTime + egress.time) / 60)),
          distance: access.distance + middleDistance + egress.distance,
          segments: detailSegments,
          description: `${access.icon} ${access.label}到 ${entry.name} → ${transitLabels.join(' → ')} → ${egress.icon} ${egress.label}到终点`,
          dataSource,
          answerRate: minOrNull(access.answerRate, egress.answerRate),
          didiDurationMinutes: maxOrNull(access.didiDurationMinutes, egress.didiDurationMinutes),
          raw: {
            segments: middleRaw,
            taxiCost,
            taxiSegments,
            transitCost: personalCost,
            taxiLegs: [access.mapLeg, egress.mapLeg].filter(Boolean),
            endpointLegs: [access.mapLeg, egress.mapLeg].filter(Boolean),
            trafficSpeedKmh: taxiSegments
              ? Math.round(Math.min(
                  access.actualSpeedMps || traffic.speedMps || 8.3,
                  egress.actualSpeedMps || traffic.speedMps || 8.3
                ) * 3.6)
              : null,
          },
        });
      });
    });
    return routes;
  }));

  return planRoutes.flat();
}

// 类别 3：公交+打车（用 AMap 真实公交站作为换乘点，并按实时路况估算打车时间）
async function searchBusThenTaxi(traffic = { speedMps: 8.3 }, result = null, fullTaxiTotal = null) {
  if (!isValidLocation(startPOI && startPOI.location) || !isValidLocation(endPOI && endPOI.location)) {
    return [];
  }
  if (!result) return [];

  // 遍历前 2 个公交方案，收集所有真实的公交/地铁下车站
  const candidates = [];
  const seen = new Set();
  result.plans.slice(0, 4).forEach(plan => {
    collectTransferStations(plan).forEach(s => {
      const key = s.name + '|' + Math.round(s.ratio * 100);
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push({ plan, station: s });
      }
    });
  });

  const endLngLat = [endPOI.location.lng, endPOI.location.lat];
  const fullTaxiDist = calculateDistance(
    [startPOI.location.lng, startPOI.location.lat],
    endLngLat
  );
  const fullTaxiCost = Number.isFinite(fullTaxiTotal) && fullTaxiTotal > 0
    ? fullTaxiTotal
    : calculateCost(fullTaxiDist, 'taxi');
  if (!isFinite(fullTaxiCost) || fullTaxiCost <= 0) {
    return [];
  }

  if (candidates.length === 0) {
    console.log('[hybrid] no transfer station candidates found');
    return [];
  }

  // 算出每个候选站点的「公交累计 + 打车到终点」成本
  const hybrids = (await Promise.all(
    candidates.map(c => buildHybridFromStation(c.plan, c.station, endLngLat, traffic))
  ))
    .filter(Boolean)
    .filter(h => isFinite(h.cost) && h.cost < fullTaxiCost)
    .sort((a, b) => a.cost - b.cost)
    .slice(0, 5);

  console.log(`[hybrid] candidates=${candidates.length}, taxiThreshold=${fullTaxiCost.toFixed(2)}, kept=${hybrids.length}`);

  return hybrids;
}

// 类别 4：打车→地铁（当起点离地铁站 >1km 时，打车到地铁站比步行省时很多）
async function searchTaxiToTransit(traffic = { speedMps: 8.3 }, result = null, fullTaxiTotal = null) {
  // 起终点位置必须有效
  if (!isValidLocation(startPOI && startPOI.location) || !isValidLocation(endPOI && endPOI.location)) {
    return [];
  }
  if (!result) return [];

  const origin = [startPOI.location.lng, startPOI.location.lat];
  const endLngLat = [endPOI.location.lng, endPOI.location.lat];
  const fullTaxiDist = calculateDistance(origin, endLngLat);
  const fullTaxiCost = Number.isFinite(fullTaxiTotal) && fullTaxiTotal > 0
    ? fullTaxiTotal
    : calculateCost(fullTaxiDist, 'taxi');
  // NaN guard
  if (!isFinite(fullTaxiCost) || fullTaxiCost <= 0) return [];
  const speedMps = traffic.speedMps > 0 ? traffic.speedMps : 8.3;

  const candidates = [];
  const seen = new Set();

  // 遍历前 2 个公交方案，取其首个公交段的 on_station
  result.plans.slice(0, 4).forEach(plan => {
    const segments = plan.segments || [];
    const firstTransitIdx = segments.findIndex(s =>
      s.transit_mode === 'SUBWAY' || s.transit_mode === 'BUS'
    );
    if (firstTransitIdx < 0) return;

    const firstSeg = segments[firstTransitIdx];
    const onStation = firstSeg.transit && firstSeg.transit.on_station;

    // 严格校验：站点必须有有效 location 和 name
    if (!onStation || !isValidLocation(onStation.location) || !onStation.name) return;

    // 去重
    const key = `taxi-${onStation.name}`;
    if (seen.has(key)) return;
    seen.add(key);

    // 计算步行到该站的距离（firstTransitIdx 之前的 walk 段总长）
    const walkDistance = segments
      .slice(0, firstTransitIdx)
      .reduce((sum, s) => sum + (s.distance || 0), 0);

    // 步行太短就没必要打车去站
    if (walkDistance < 800) return;

    candidates.push({ plan, segments, firstSeg, onStation, firstTransitIdx, walkDistance });
  });

  // 异步估算每个候选的 taxi 价格（每段独立 Driving.search，不用统一的 speedMps）
  const builtHybrids = await Promise.all(candidates.map(async c => {
    const stationLngLat = [c.onStation.location.lng, c.onStation.location.lat];

    const driving = await getDrivingTime(origin, stationLngLat, speedMps);
    const taxiDistance = driving.distance;
    if (!isFinite(taxiDistance) || taxiDistance <= 0) return null;

    // 综合步行时间+天气判断打车是否值得
    const taxiCheck = isTaxiWorthIt(taxiDistance);
    console.info(`[打车+公交] 到${c.onStation.name} 路网${Math.round(taxiDistance)}m，判断: ${taxiCheck.worthIt ? '值得' : '跳过'}（步行${taxiCheck.walkTimeMin}min/阈值${taxiCheck.thresholdMin}min）`);
    if (!taxiCheck.worthIt) return null;

    const taxiTimeSec = driving.time;
    const taxiEst = await estimateTaxi(taxiDistance, taxiTimeSec, origin, c.onStation.location);
    console.info(`[打车+公交] ${c.onStation.name} Didi结果: ${taxiEst.source==='didi' ? '¥'+taxiEst.cost+' · '+taxiEst.carType : '本地估算 ¥'+taxiEst.cost}`);
    const taxiCost = taxiEst.cost;
    if (!isFinite(taxiCost)) return null;

    // 时间：打车 + 剩余的公交时间（包含后续所有段）
    const taxiTime = Math.round(taxiTimeSec / 60);
    const remainingTransitTime = Math.round(
      c.segments.slice(c.firstTransitIdx).reduce((sum, s) => sum + (s.time || 0), 0) / 60
    );
    const totalTime = taxiTime + remainingTransitTime;

    const transitCost = c.plan.cost || 2;
    const totalCost = taxiCost + transitCost;

    // 必须比全程打车便宜才有意义
    if (!isFinite(totalCost) || totalCost >= fullTaxiCost) return null;

    // 拆出所有 remaining 段（transit + walk），每段单独显示
    const remainingSegs = c.segments.slice(c.firstTransitIdx);
    const carTypeLabel = taxiEst.carType ? ` · ${taxiEst.carType}` : '';
    const detailSegments = [{
      type: 'taxi', distance: taxiDistance, lineName: `打车${carTypeLabel}到 ${c.onStation.name}`,
      fromStation: startPOI.name, toStation: c.onStation.name
    }];
    const descParts = [];
    remainingSegs.forEach(s => {
      if (s.transit_mode === 'WALK') {
        detailSegments.push({
          type: 'walk', distance: s.distance, time: s.time,
          fromStation: '步行', toStation: '换乘/到达',
        });
      } else {
        const lines = (s.transit && s.transit.lines) || [];
        const line = lines[0] || {};
        const info = parseLineInfo(line.name, s.transit_mode);
        const onName = (s.transit && s.transit.on_station && s.transit.on_station.name) || '上车';
        const offName = (s.transit && s.transit.off_station && s.transit.off_station.name) || '下车';
        const isSubway = s.transit_mode === 'SUBWAY';
        detailSegments.push({
          type: 'transit', mode: s.transit_mode,
          lineName: info.direction ? `${info.line} · ${info.direction}` : info.line,
          fromStation: onName, toStation: offName,
        });
        descParts.push(isSubway ? `🚇 ${info.line}` : `🚌 ${info.line}`);
      }
    });

    const taxiKm = Math.round(taxiDistance / 100) / 10;
    const desc = `🚕 打车${carTypeLabel} ${taxiKm} km 到 ${c.onStation.name} → ${descParts.join(' → ')}`;

    return {
      id: `taxi-to-transit-${c.onStation.name}`,
      category: 'hybrid',
      type: 'hybrid',
      direction: 'taxi-to-transit',
      cost: Math.round(totalCost * 100) / 100,
      time: totalTime,
      distance: taxiDistance + (c.plan.distance || 0),
      segments: detailSegments,
      description: desc,
      dataSource: taxiEst.source,
      answerRate: taxiEst.answerRate,
      didiDurationMinutes: taxiEst.didiDurationMinutes,
      raw: {
        stationName: c.onStation.name,
        segments: remainingSegs, // AMap 原始段，给地图绘制用
        taxiDistance,
        taxiCost,
        transitCost,
        trafficSpeedKmh: Math.round(driving.speedMps * 3.6),
      },
    };
  }));

  return builtHybrids
    .filter(Boolean)
    .sort((a, b) => a.cost - b.cost)
    .slice(0, 4);
}

// 类别 5：打车接驳公共交通，再打车到终点。
// 只替换公交方案两端较长的步行段，公交换乘结构保持不变。
async function searchTaxiTransitTaxi(traffic = { speedMps: 8.3 }, result = null, fullTaxiCost = null) {
  if (!result || !Array.isArray(result.plans)) return [];
  if (!isValidLocation(startPOI?.location) || !isValidLocation(endPOI?.location)) return [];

  const speedMps = traffic.speedMps > 0 ? traffic.speedMps : 8.3;
  const origin = [startPOI.location.lng, startPOI.location.lat];
  const destination = [endPOI.location.lng, endPOI.location.lat];
  const fullDistance = calculateDistance(origin, destination);
  const taxiCeiling = Number.isFinite(fullTaxiCost) && fullTaxiCost > 0
    ? fullTaxiCost
    : estimateTaxiByLocalRules(fullDistance, 0);

  const candidates = result.plans.slice(0, 6).map((plan, planIndex) => {
    const segments = plan.segments || [];
    const transitIndexes = segments
      .map((seg, index) => ({ seg, index }))
      .filter(({ seg }) => seg.transit_mode === 'SUBWAY' || seg.transit_mode === 'BUS');
    if (transitIndexes.length === 0) return null;

    const firstIndex = transitIndexes[0].index;
    const lastIndex = transitIndexes[transitIndexes.length - 1].index;
    const firstTransit = segments[firstIndex];
    const lastTransit = segments[lastIndex];
    const entry = firstTransit.transit?.on_station;
    const exit = lastTransit.transit?.off_station;
    if (!entry?.name || !exit?.name || !isValidLocation(entry.location) || !isValidLocation(exit.location)) return null;

    const initialWalk = segments.slice(0, firstIndex).reduce((sum, seg) => sum + (seg.distance || 0), 0);
    const finalWalk = segments.slice(lastIndex + 1).reduce((sum, seg) => sum + (seg.distance || 0), 0);
    const middleDistance = segments
      .slice(firstIndex, lastIndex + 1)
      .reduce((sum, seg) => sum + (seg.distance || 0), 0);
    if (initialWalk < 500 || finalWalk < 500 || middleDistance < 3000) return null;

    return {
      plan, planIndex, segments, firstIndex, lastIndex, entry, exit,
      accessWalk: initialWalk + finalWalk,
    };
  })
    .filter(Boolean)
    .sort((a, b) => b.accessWalk - a.accessWalk)
    .slice(0, 3);

  const routes = await Promise.all(candidates.map(async candidate => {
    const entryPoint = [candidate.entry.location.lng, candidate.entry.location.lat];
    const exitPoint = [candidate.exit.location.lng, candidate.exit.location.lat];
    // 两段打车分别独立查询实时驾车时间（含各自路况）
    const [driving1, driving2] = await Promise.all([
      getDrivingTime(origin, entryPoint, speedMps),
      getDrivingTime(exitPoint, destination, speedMps),
    ]);
    const firstTaxiDistance = driving1.distance;
    const secondTaxiDistance = driving2.distance;
    if (firstTaxiDistance <= 0 || secondTaxiDistance <= 0) return null;

    // 综合步行时间+天气判断任一端打车是否值得
    const check1 = isTaxiWorthIt(firstTaxiDistance);
    const check2 = isTaxiWorthIt(secondTaxiDistance);
    console.info(`[打车+公交+打车] 前端${Math.round(firstTaxiDistance)}m ${check1.worthIt?'✓':'✗'} 后端${Math.round(secondTaxiDistance)}m ${check2.worthIt?'✓':'✗'}（步行${check1.walkTimeMin}/${check2.walkTimeMin}min 阈值${check1.thresholdMin}min）`);
    if (!check1.worthIt || !check2.worthIt) return null;

    const firstTaxiSeconds = driving1.time;
    const secondTaxiSeconds = driving2.time;
    const [firstEstimate, secondEstimate] = await Promise.all([
      estimateTaxi(firstTaxiDistance, firstTaxiSeconds, origin, candidate.entry.location, {
        fromName: startPOI.name,
        toName: candidate.entry.name,
      }),
      estimateTaxi(secondTaxiDistance, secondTaxiSeconds, candidate.exit.location, destination, {
        fromName: candidate.exit.name,
        toName: endPOI.name,
      }),
    ]);
    console.info(`[打车+公交+打车] Didi: 前端 ${firstEstimate.source==='didi' ? '¥'+firstEstimate.cost+'·'+firstEstimate.carType : '本地¥'+firstEstimate.cost} | 后端 ${secondEstimate.source==='didi' ? '¥'+secondEstimate.cost+'·'+secondEstimate.carType : '本地¥'+secondEstimate.cost}`);

    const taxiCost = firstEstimate.cost + secondEstimate.cost;
    const transitCost = candidate.plan.cost || 2;
    const totalCost = taxiCost + transitCost;
    if (!Number.isFinite(totalCost) || totalCost >= taxiCeiling) return null;

    const car1 = firstEstimate.carType ? ` · ${firstEstimate.carType}` : '';
    const car2 = secondEstimate.carType ? ` · ${secondEstimate.carType}` : '';

    const middleRawSegments = candidate.segments.slice(candidate.firstIndex, candidate.lastIndex + 1);
    const middleTimeSeconds = middleRawSegments.reduce((sum, seg) => sum + (seg.time || 0), 0);
    const detailSegments = [{
      type: 'taxi',
      distance: firstTaxiDistance,
      time: firstTaxiSeconds,
      lineName: `打车${car1}到 ${candidate.entry.name}`,
      fromStation: startPOI.name,
      toStation: candidate.entry.name,
    }];

    middleRawSegments.forEach(seg => {
      if (seg.transit_mode === 'WALK') {
        detailSegments.push({ type: 'walk', distance: seg.distance || 0, time: seg.time || 0 });
        return;
      }
      const line = seg.transit?.lines?.[0] || {};
      const info = parseLineInfo(line.name, seg.transit_mode);
      detailSegments.push({
        type: 'transit',
        mode: seg.transit_mode,
        lineName: info.direction ? `${info.line} · ${info.direction}` : info.line,
        fromStation: seg.transit?.on_station?.name || '上车',
        toStation: seg.transit?.off_station?.name || '下车',
      });
    });

    detailSegments.push({
      type: 'taxi',
      distance: secondTaxiDistance,
      time: secondTaxiSeconds,
      lineName: `打车${car2}到 ${endPOI.name}`,
      fromStation: candidate.exit.name,
      toStation: endPOI.name,
    });

    const transitLabels = detailSegments
      .filter(seg => seg.type === 'transit')
      .map(seg => `${seg.mode === 'SUBWAY' ? '🚇' : '🚌'} ${parseLineInfo(seg.lineName, seg.mode).line}`);
    const dataSource = firstEstimate.source === 'didi' && secondEstimate.source === 'didi' ? 'didi' : 'local';

    return {
      id: `taxi-transit-taxi-${candidate.planIndex}`,
      category: 'hybrid',
      type: 'hybrid',
      direction: 'taxi-transit-taxi',
      cost: Math.round(totalCost * 100) / 100,
      time: Math.max(1, Math.round((firstTaxiSeconds + middleTimeSeconds + secondTaxiSeconds) / 60)),
      distance: firstTaxiDistance + middleRawSegments.reduce((sum, seg) => sum + (seg.distance || 0), 0) + secondTaxiDistance,
      segments: detailSegments,
      description: `🚕${car1} 到 ${candidate.entry.name} → ${transitLabels.join(' → ')} → 🚕${car2} 到终点`,
      dataSource,
      // 两段打车取最差值：最低应答率、最长等待
      answerRate: minOrNull(firstEstimate.answerRate, secondEstimate.answerRate),
      didiDurationMinutes: maxOrNull(firstEstimate.didiDurationMinutes, secondEstimate.didiDurationMinutes),
      raw: {
        segments: middleRawSegments,
        taxiCost,
        taxiCosts: [firstEstimate.cost, secondEstimate.cost],
        transitCost,
        entryStation: candidate.entry,
        exitStation: candidate.exit,
        taxiLegs: [
          { from: origin, to: entryPoint },
          { from: exitPoint, to: destination },
        ],
        trafficSpeedKmh: Math.round(Math.min(driving1.speedMps, driving2.speedMps) * 3.6),
      },
    };
  }));

  return routes.filter(Boolean).sort((a, b) => getDisplayCost(a) - getDisplayCost(b)).slice(0, 4);
}

// 检测打车路线中的拥堵路段
// 阈值：> 3.6 min/km (≈17 km/h) 算中等拥堵；> 5.4 min/km (≈11 km/h) 算严重拥堵
function detectTaxiCongestion(taxiRoute) {
  if (!taxiRoute || !taxiRoute.raw || !Array.isArray(taxiRoute.raw.steps)) return null;
  const steps = taxiRoute.raw.steps;

  let worstRatio = 0;
  let worstStep = null;
  steps.forEach(step => {
    const dist = step.distance || 0; // 米
    const time = step.time || 0;     // 秒
    if (dist < 800) return; // 忽略短段
    const ratio = time / dist;       // 秒/米，越大越堵
    if (ratio > worstRatio) {
      worstRatio = ratio;
      worstStep = step;
    }
  });

  // 严重：> 0.18 s/m ≈ 5.4 min/km ≈ 11 km/h
  // 中等：> 0.12 s/m ≈ 3.6 min/km ≈ 17 km/h
  if (worstRatio > 0.18) return { severity: 'heavy', ratio: worstRatio, step: worstStep };
  if (worstRatio > 0.12) return { severity: 'moderate', ratio: worstRatio, step: worstStep };
  return null;
}

// 收集公交方案中的真实换乘站
// 关键：AMap 返回的公交方案里，bus 段下车站往往落在全程 70%-95% 位置
//（因为前面有步行到站、后面有步行离站把 ratio 推高了）
// 所以放宽到 5%-95%，并跳过「最后一站就是终点」的情况
function collectTransferStations(plan) {
  const segments = plan.segments || [];
  const totalDistance = plan.distance || 1;
  if (totalDistance <= 0) return [];
  const stations = [];

  let acc = 0;
  segments.forEach((seg, idx) => {
    const segStart = acc;
    const segEnd = acc + (seg.distance || 0);
    acc = segEnd;

    if (seg.transit_mode !== 'SUBWAY' && seg.transit_mode !== 'BUS') return;
    if (!seg.transit || !seg.transit.off_station) return;

    const offStation = seg.transit.off_station;
    // 严格校验：必须有有效 location 和 name
    if (!isValidLocation(offStation.location) || !offStation.name) return;

    // 跳过"下车站几乎就是终点"的情况（ratio > 0.97）
    const ratio = segEnd / totalDistance;
    if (!isFinite(ratio) || ratio > 0.97) return;

    // 跳过 segment 太短的（< 100m），这种 off_station 没什么意义
    if ((seg.distance || 0) < 100) return;

    stations.push({
      name: offStation.name,
      location: offStation.location,
      segmentIndex: idx,
      ratio,
      lineName: (seg.transit.lines && seg.transit.lines[0] && seg.transit.lines[0].name) || (seg.transit_mode === 'SUBWAY' ? '地铁' : '公交'),
      transitMode: seg.transit_mode,
      segmentDistance: seg.distance || 0,
      segStartRatio: segStart / totalDistance,
    });
  });

  return stations;
}

// 用指定换乘站构建一个混合方案
// traffic.speedMps —— 来自完整打车路线的「含实时路况」平均车速（m/s）
async function buildHybridFromStation(plan, station, endLngLat, traffic = { speedMps: 8.3 }) {
  // 严格校验 station.location
  if (!isValidLocation(station.location)) return null;

  const segments = plan.segments || [];

  // 公交费用：用 AMap plan.cost 按距离比例折算（lines[0].price 在 JS SDK 中不可靠）
  const transitCost = Math.max((plan.cost || 0) * station.ratio, 2);
  const transitLegs = [];
  for (let i = 0; i <= station.segmentIndex; i++) {
    const s = segments[i];
    if (s.transit_mode === 'SUBWAY' || s.transit_mode === 'BUS') {
      const lines = (s.transit && s.transit.lines) || [];
      const onStation = (s.transit && s.transit.on_station && s.transit.on_station.name) || '';
      const offStation = (s.transit && s.transit.off_station && s.transit.off_station.name) || '';
      transitLegs.push({
        mode: s.transit_mode,
        lineName: (lines[0] && lines[0].name) || (s.transit_mode === 'SUBWAY' ? '地铁' : '公交'),
        price: 0, // 不再逐段显示价格，总价由 transitCost 体现
        fromStation: onStation,
        toStation: offStation,
      });
    }
  }

  // 独立查询实时驾车时间（含路况），不用全程打车的统一 speedMps
  const driving = await getDrivingTime(
    [station.location.lng, station.location.lat],
    endLngLat,
    traffic.speedMps || 8.3
  );
  const taxiDistance = driving.distance;
  // 任何一步计算失败就丢弃这个候选
  if (!isFinite(taxiDistance) || taxiDistance <= 0) return null;

  // 综合步行时间+天气判断打车是否值得
  const taxiCheck = isTaxiWorthIt(taxiDistance);
  console.info(`[公交+打车] ${station.name}→终点 路网${Math.round(taxiDistance)}m，判断: ${taxiCheck.worthIt ? '值得' : '跳过'}（步行${taxiCheck.walkTimeMin}min/阈值${taxiCheck.thresholdMin}min）`);
  if (!taxiCheck.worthIt) return null;

  // 时间：公交耗时按占比 + 打车耗时（实时路况）
  const transitTime = Math.round((plan.time || 0) / 60 * station.ratio);
  const taxiTime = Math.round(driving.time / 60);
  const totalTime = transitTime + taxiTime;
  if (!isFinite(totalTime) || totalTime <= 0) return null;

  // 异步调用滴滴拿真实价格
  const taxiEst = await estimateTaxi(taxiDistance, driving.time, station.location, endPOI.location);
  console.info(`[公交+打车] ${station.name}→终点 Didi: ${taxiEst.source==='didi' ? '¥'+taxiEst.cost+'·'+taxiEst.carType : '本地估算¥'+taxiEst.cost}`);
  const taxiCost = taxiEst.cost;
  if (!isFinite(taxiCost)) return null;

  const totalCost = transitCost + taxiCost;
  const taxiDistanceKm = Math.round(taxiDistance / 100) / 10;

  const speedKmh = Math.round(driving.speedMps * 3.6);
  const stationLineInfo = parseLineInfo(station.lineName, station.transitMode);
  const stationDisplay = stationLineInfo.direction
    ? `${stationLineInfo.line} · ${stationLineInfo.direction}`
    : stationLineInfo.line;
  const carTypeSuffix = taxiEst.carType ? ` · ${taxiEst.carType}` : '';
  return {
    id: `hybrid-${station.segmentIndex}-${station.name}`,
    category: 'hybrid',
    type: 'hybrid',
    cost: Math.round(totalCost * 100) / 100,
    time: totalTime,
    distance: (plan.distance || 0) * station.ratio + taxiDistance,
    segments: [
      ...transitLegs.map(l => ({ ...l, type: 'transit' })),
      { type: 'taxi', distance: taxiDistance, lineName: `打车${carTypeSuffix}到 ${endPOI ? endPOI.name : '目的地'}`,
        fromStation: station.name, toStation: endPOI ? endPOI.name : '目的地' },
    ],
    description: `${station.transitMode === 'SUBWAY' ? '🚇' : '🚌'} ${stationDisplay} 到 ${station.name} → 🚕 打车${carTypeSuffix} ${taxiDistanceKm} km`,
    dataSource: taxiEst.source,
    answerRate: taxiEst.answerRate,
    didiDurationMinutes: taxiEst.didiDurationMinutes,
    raw: { station, taxiDistance, taxiCost, transitCost, trafficSpeedKmh: speedKmh },
  };
}

// 工具函数：计算两点间距离
function calculateDistance(p1, p2) {
  if (!p1 || !p2) return 0;
  const R = 6371000; // 地球半径
  const dLat = (p2[1] - p1[1]) * Math.PI / 180;
  const dLon = (p2[0] - p1[0]) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(p1[1] * Math.PI / 180) * Math.cos(p2[1] * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// 工具函数：获取两点之间的点
function getPointBetween(p1, p2, ratio) {
  return [
    p1[0] + (p2[0] - p1[0]) * ratio,
    p1[1] + (p2[1] - p1[1]) * ratio
  ];
}

// 格式化公交路线描述（清理原始线路名）
function formatTransitDescription(segments) {
  if (!segments || segments.length === 0) return '公共交通路线';

  const steps = [];
  segments.forEach(seg => {
    // 混合方案
    if (seg.mode === 'transit' && seg.viaStation) {
      steps.push(`${seg.icon}到${seg.viaStation}`);
    } else if (seg.mode === 'taxi') {
      steps.push(`🚕打车${Math.round(seg.distance/1000)}km`);
    } else {
      // 普通公交方案
      const mode = seg.transit_mode;
      if (mode === 'WALK') {
        steps.push('🚶 步行');
      } else if (mode === 'SUBWAY' || mode === 'METRO_RAIL') {
        const lines = seg.transit && seg.transit.lines ? seg.transit.lines : [];
        if (lines.length > 0) {
          const info = parseLineInfo(lines[0].name, 'SUBWAY');
          const dir = info.direction ? ` · ${info.direction}` : '';
          steps.push(`🚇 ${info.line}${dir}`);
        } else {
          steps.push('🚇 地铁');
        }
      } else if (mode === 'BUS') {
        const lines = seg.transit && seg.transit.lines ? seg.transit.lines : [];
        if (lines.length > 0) {
          const info = parseLineInfo(lines[0].name, 'BUS');
          const dir = info.direction ? ` · ${info.direction}` : '';
          steps.push(`🚌 ${info.line}${dir}`);
        } else {
          steps.push('🚌 公交');
        }
      }
    }
  });

  return steps.slice(0, 5).join(' → ') + (steps.length > 5 ? '...' : '');
}

// 保存搜索结果到 localStorage，刷新后可恢复
function saveSearchState() {
  try {
    if (allRoutes.length > 0 && startPOI && endPOI) {
      // AMap LngLat 对象用 getter (lng/lat)，JSON.stringify 后变成 {}，
      // 必须先转为 [lng, lat] 数组才能序列化
      const toCoord = p => (p && typeof p.lng === 'number') ? [p.lng, p.lat] : p;
      const toLocation = loc => (loc && typeof loc.lng === 'number') ? { lng: loc.lng, lat: loc.lat } : loc;

      const slimRoutes = allRoutes.map(r => {
        const { raw, ...rest } = r;
        const slimRaw = {};
        if (raw) {
          // walk/ride/taxi 路径：LngLat[] → [[lng,lat],...]
          if (Array.isArray(raw.path)) slimRaw.path = raw.path.map(toCoord);
          // transit 路段：深拷贝并转换其中的 LngLat
          if (Array.isArray(raw.segments)) {
            slimRaw.segments = raw.segments.map(seg => {
              const s = { ...seg, transit: seg.transit ? { ...seg.transit } : undefined };
              if (s.transit?.on_station) s.transit.on_station = { ...s.transit.on_station, location: toLocation(s.transit.on_station.location) };
              if (s.transit?.off_station) s.transit.off_station = { ...s.transit.off_station, location: toLocation(s.transit.off_station.location) };
              if (s.transit?.entrance) s.transit.entrance = { name: s.transit.entrance.name, location: toLocation(s.transit.entrance.location) };
              if (s.transit?.exit) s.transit.exit = { name: s.transit.exit.name, location: toLocation(s.transit.exit.location) };
              // transit.path：公交/地铁段的行驶轨迹坐标
              if (Array.isArray(s.transit?.path)) s.transit.path = s.transit.path.map(toCoord);
              // walking 路径
              if (seg.walking) {
                s.walking = { ...seg.walking };
                if (Array.isArray(seg.walking.path)) s.walking.path = seg.walking.path.map(toCoord);
                if (Array.isArray(seg.walking.steps)) {
                  s.walking.steps = seg.walking.steps.map(step => ({ ...step, path: Array.isArray(step.path) ? step.path.map(toCoord) : step.path }));
                }
              }
              return s;
            });
          }
          if (raw.taxiLegs) slimRaw.taxiLegs = raw.taxiLegs;                 // hybrid 打车段 (已是数组)
          if (raw.endpointLegs) slimRaw.endpointLegs = raw.endpointLegs;     // hybrid 端点 (已是数组)
          if (raw.taxiCost != null) slimRaw.taxiCost = raw.taxiCost;
          if (raw.transitCost != null) slimRaw.transitCost = raw.transitCost;
          if (raw.trafficSpeedKmh != null) slimRaw.trafficSpeedKmh = raw.trafficSpeedKmh;
          if (raw.taxiDistance != null) slimRaw.taxiDistance = raw.taxiDistance;
          if (raw.station) slimRaw.station = raw.station;
        }
        rest.raw = Object.keys(slimRaw).length ? slimRaw : undefined;
        if (Array.isArray(rest.segments)) {
          rest.segments = rest.segments.map(s => { const { raw: sr, ...srest } = s || {}; return srest; });
        }
        return rest;
      });
      localStorage.setItem(SAVED_SEARCH_KEY, JSON.stringify({
        startPOI,
        endPOI,
        allRoutes: slimRoutes,
        sortMode,
        passengerCount,
        _savedAt: Date.now(),
      }));
    }
  } catch (e) { /* quota exceeded, ignore */ }
}

// 恢复上次搜索结果
function restoreSearchState() {
  try {
    const raw = localStorage.getItem(SAVED_SEARCH_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved || !saved.startPOI || !saved.endPOI || !Array.isArray(saved.allRoutes) || saved.allRoutes.length === 0) {
      return false;
    }
    startPOI = saved.startPOI;
    endPOI = saved.endPOI;
    // 回填输入框显示上次选择的地点名
    if (startInput && startPOI) {
      startInput.value = startPOI.name || '';
      startInput.closest('.input-wrapper')?.classList.add('selected');
    }
    if (endInput && endPOI) {
      endInput.value = endPOI.name || '';
      endInput.closest('.input-wrapper')?.classList.add('selected');
    }
    allRoutes = saved.allRoutes;
    sortMode = saved.sortMode || 'balanced';
    passengerCount = saved.passengerCount || 1;
    // 更新 UI 控件状态
    if (passengerCountEl) passengerCountEl.textContent = passengerCount;
    document.querySelectorAll('.mode-option').forEach(b => {
      const active = b.dataset.mode === sortMode;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (map) updateMapMarkers();
    renderResults(allRoutes.slice(0, 14));
    return true;
  } catch (e) {
    return false;
  }
}

// 渲染结果
function renderResults(routes) {
  _lastResults = routes; // 缓存，人数变化时复用
  const resultsHint = document.querySelector('.results-hint');
  const sortLabels = {
    cheapest: '经济成本优先', balanced: '三项综合最优',
    comfortable: '舒适度优先', fastest: '时间成本优先',
  };
  if (resultsHint) resultsHint.textContent = sortLabels[sortMode] || sortLabels.balanced;

  // 叫车可用性 / 难度警告
  const taxiWarningHtml = (() => {
    if (!routes.some(r => r.category === 'taxi' || r.category === 'hybrid')) return '';
    const d = window._taxiDifficulty || {};
    if (!d.available) {
      // 滴滴未返回可用报价
      return `<div class="taxi-availability-warning">
        <i data-lucide="alert-triangle"></i>
        <span>该区域实时叫车数据不可用，打车费用为估算值。建议优先选择<strong>全程公交</strong>方案</span>
      </div>`;
    }
    // 有滴滴报价，但应答率低 → 叫车较难
    const lowRate = d.answerRate != null && d.answerRate < TAXI_DIFFICULTY.lowAnswerRate;
    if (lowRate) {
      return `<div class="taxi-availability-warning">
        <i data-lucide="alert-triangle"></i>
        <span>该区域叫车较难（应答率 ${d.answerRate}%），已自动选取更易叫到的车型。建议优先选择<strong>全程公交</strong>方案</span>
      </div>`;
    }
    return '';
  })();

  if (routes.length === 0) {
    resultsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"><i data-lucide="search-x"></i></div>
        <p class="empty-title">未找到合适的路线</p>
        <p class="empty-hint">请尝试其他地址或调整起终点</p>
      </div>
    `;
    refreshIcons();
    return;
  }

  resultsList.innerHTML = taxiWarningHtml + routes.map(route => {
    const badge = route.badge ? BADGE_META[route.badge] : null;
    const badgeHtml = badge
      ? `<div class="result-badge ${route.badge}"><i data-lucide="${badge.icon}"></i><span>${badge.label}</span></div>`
      : '';
    const cat = CATEGORY_META[route.category] || CATEGORY_META.transit;

    // NaN/undefined 兜底，保证 UI 永远不显示 NaN
    const displayCost = safeNum(getDisplayCost(route), 0);
    const safeTime = safeNum(route.time, 0);
    const distanceKm = Math.round(safeNum(route.distance, 0) / 1000 * 10) / 10;

    // 拥堵警告（仅打车）
    let congestionHtml = '';
    if (route.category === 'taxi' && route.congestion) {
      const sev = route.congestion.severity;
      const ratio = route.congestion.ratio; // s/m
      const minPerKm = Math.round(ratio * 60);
      const icon = sev === 'heavy' ? 'alert-triangle' : 'traffic-cone';
      const label = sev === 'heavy'
        ? `严重拥堵路段 · ${minPerKm} 分钟/km`
        : `部分拥堵 · ${minPerKm} 分钟/km`;
      congestionHtml = `
        <div class="result-warning">
          <i data-lucide="${icon}"></i>
          <span>${label}，可考虑地铁绕过</span>
        </div>
      `;
    }

    // 数据源徽章（打车 / 含打车的 hybrid）
    let sourceBadgeHtml = '';
    if ((route.category === 'taxi' || route.category === 'hybrid') && route.dataSource) {
      const ds = route.dataSource;
      let sourceIcon, sourceLabel, sourceClass;
      if (ds === 'didi') {
        sourceIcon = 'car-taxi-front';
        sourceLabel = '滴滴实时估价';
        sourceClass = 'is-didi';
      } else if (ds === 'amap') {
        sourceIcon = 'map-pin';
        sourceLabel = '高德驾车预估';
        sourceClass = 'is-mcp';
      } else {
        sourceIcon = 'alert-triangle';
        sourceLabel = `叫车不确定 · ${appSettings.city}`;
        sourceClass = 'is-local';
      }
      sourceBadgeHtml = `
        <span class="result-source ${sourceClass}">
          <i data-lucide="${sourceIcon}"></i>
          <span>${sourceLabel}</span>
        </span>
      `;
    }

    return `
      <div class="result-card ${route.badge || ''} ${route.category === 'taxi' && route.congestion ? 'has-warning' : ''}" data-id="${route.id}">
        <div class="result-card-head">
          <div class="result-category">
            <i data-lucide="${cat.icon}"></i>
            <span>${cat.label}</span>
          </div>
          ${badgeHtml}
        </div>
        <div class="result-summary">
          <div class="result-cost">
            <span class="currency">¥</span>${displayCost.toFixed(1)}<span class="unit">元${passengerCount > 1 ? '/人' : ''}</span>
          </div>
          <div class="result-meta">
            <span class="result-time">
              <i data-lucide="clock"></i>${fmtMinutes(safeTime)}
            </span>
            <span class="result-comfort">
              <span>${getComfortLabel(getComfortStars(route))}</span>${renderComfortStars(route)}
              ${getWeatherComfortNote() ? `<span class="weather-note">${getWeatherComfortNote()}</span>` : ''}
            </span>
            <span class="result-distance">${distanceKm} km</span>
          </div>
        </div>
        <div class="result-desc">${descriptionToHtml(route.description || '')}</div>
        <div class="result-footer">
          ${sourceBadgeHtml}
          ${congestionHtml}
        </div>
      </div>
    `;
  }).join('');

  // 卡片点击已通过事件委托处理（见下方 resultsList 上的 click 监听）

  // 自动在地图上画出推荐（第一条）路线
  const bestRoute = routes.find(r => r.badge === 'recommended') || routes[0];
  if (bestRoute) drawRouteOnMap(bestRoute);

  refreshIcons();
}

// 渲染单条路线段
function renderSegment(markerIcon, type, infoLines) {
  return `
    <div class="detail-segment">
      <div class="segment-marker"><i data-lucide="${markerIcon}"></i></div>
      <div class="segment-content">
        <p class="segment-type">${type}</p>
        ${infoLines.map(line => `<p class="segment-info">${line}</p>`).join('')}
      </div>
    </div>
  `;
}

// 兼容 emoji → lucide 名称（用于 hybrid/seg.icon 字段）
function emojiToLucide(emoji) {
  return ICON_MAP[emoji] || 'circle';
}

// 校验一个 AMap LngLat 位置对象是否可用
function isValidLocation(loc) {
  return loc && typeof loc.lng === 'number' && typeof loc.lat === 'number' &&
         !isNaN(loc.lng) && !isNaN(loc.lat);
}

// 从一个值中安全提取数字（NaN/undefined → fallback）
function safeNum(v, fallback = 0) {
  return typeof v === 'number' && !isNaN(v) ? v : fallback;
}

// 解析线路名，提取方向
// 例如 "1号线(苹果园-四惠东)" → { line: "1号线", fromStation: "苹果园", toStation: "四惠东", direction: "往 四惠东方向" }
// 例如 "10号线外环(车道沟-车道沟)" → { line: "10号线外环", direction: "外环方向" }（环线：起终点相同，单独处理）
// 例如 "1号线（苹果园开往四惠东）" → 同箭头格式
function parseLineInfo(lineName, fallbackMode) {
  const fallback = { line: fallbackMode === 'SUBWAY' ? '地铁' : '公交', direction: null };
  if (!lineName) return fallback;

  // 先检测环线（"外环"/"内环"/"环线"）
  const loopMatch = lineName.match(/(.+?线)\s*(外环|内环|环线)/);
  if (loopMatch) {
    return {
      line: lineName.replace(/\s*[（(][^）)]+[）)]\s*/, '').trim(),
      fromStation: null,
      toStation: null,
      direction: `${loopMatch[2]}方向`,
      isLoop: true,
    };
  }

  // 匹配括号内的内容
  const parenMatch = lineName.match(/[（(]([^）)]+)[）)]/);
  if (parenMatch) {
    const inside = parenMatch[1].trim();
    const cleanLine = lineName.replace(/\s*[（(][^）)]+[）)]\s*/, '').trim();

    // "苹果园-四惠东" / "苹果园–四惠东" / "苹果园→四惠东"
    const arrowMatch = inside.match(/^(.+?)\s*[-–→]+\s*(.+)$/);
    if (arrowMatch) {
      const from = arrowMatch[1].trim();
      const to = arrowMatch[2].trim();
      // 起终点相同 → 当作环线处理（不显示 "往 X 方向"）
      if (from === to) {
        return {
          line: cleanLine,
          fromStation: null,
          toStation: null,
          direction: '环线',
          isLoop: true,
        };
      }
      return {
        line: cleanLine,
        fromStation: from,
        toStation: to,
        direction: `往 ${to} 方向`,
      };
    }
    // "苹果园开往四惠东"
    const kwaiMatch = inside.match(/^(.+?)开往(.+)$/);
    if (kwaiMatch) {
      const from = kwaiMatch[1].trim();
      const to = kwaiMatch[2].trim();
      if (from === to) {
        return { line: cleanLine, fromStation: null, toStation: null, direction: '环线', isLoop: true };
      }
      return {
        line: cleanLine,
        fromStation: from,
        toStation: to,
        direction: `往 ${to} 方向`,
      };
    }
  }

  return { line: lineName, direction: null };
}

// 渲染导航时间线单步
function renderNavStep({ icon, badge, title, subtitle, detail, isFirst, isLast }) {
  return `
    <div class="nav-step ${isFirst ? 'is-first' : ''} ${isLast ? 'is-last' : ''}">
      <div class="nav-marker">
        ${badge ? `<span class="nav-badge">${badge}</span>` : ''}
        <i data-lucide="${icon}"></i>
      </div>
      <div class="nav-content">
        ${title ? `<div class="nav-title">${title}</div>` : ''}
        ${subtitle ? `<div class="nav-subtitle">${subtitle}</div>` : ''}
        ${detail ? `<div class="nav-detail">${detail}</div>` : ''}
      </div>
    </div>
  `;
}

// 把米数格式化为"X 米 / X.X km"
function fmtDist(meters) {
  const m = Math.round(meters || 0);
  if (m < 1000) return `${m} 米`;
  return `${(m / 1000).toFixed(1)} km`;
}

// 把秒数格式化为"X 分钟"或"X 小时 Y 分钟"
function fmtTime(seconds) {
  const totalMin = Math.round((seconds || 0) / 60);
  if (totalMin < 1) return '< 1 分钟';
  if (totalMin < 60) return `约 ${totalMin} 分钟`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (mins === 0) return `约 ${hours} 小时`;
  return `约 ${hours} 小时 ${mins} 分钟`;
}

// 把分钟数格式化为"X 分钟"或"X 小时 Y 分钟"（route.time 等字段是分钟）
function fmtMinutes(minutes) {
  return fmtTime((minutes || 0) * 60);
}

// 把 AMap Transfer 的 segments 转换成导航时间线
function buildTransitTimeline(planSegments, startName, endName) {
  const steps = [];
  const segs = planSegments || [];

  // 起始点
  steps.push({
    icon: 'map-pin',
    badge: '起',
    title: startName || '起点',
    subtitle: '出发地',
    detail: '',
    isFirst: true,
  });

  segs.forEach((seg, idx) => {
    const mode = seg.transit_mode;
    const prevSeg = segs[idx - 1];
    const nextSeg = segs[idx + 1];

    if (mode === 'WALK') {
      const steps_arr = (seg.walking && seg.walking.steps) || [];
      const lastStep = steps_arr[steps_arr.length - 1];
      const isLastWalk = idx === segs.length - 1;

      // 找到前后公交段，获取结构化的出入口数据
      const nextTransit = segs.slice(idx + 1).find(s => s.transit_mode === 'SUBWAY' || s.transit_mode === 'BUS');
      const prevTransits = segs.slice(0, idx).filter(s => s.transit_mode === 'SUBWAY' || s.transit_mode === 'BUS');
      const prevTransit = prevTransits[prevTransits.length - 1];

      const nextStation = nextTransit?.transit?.on_station?.name || '';
      const nextEntrance = nextTransit?.transit?.entrance?.name || '';  // 结构化入口名
      const prevStation = prevTransit?.transit?.off_station?.name || '';
      const prevExit = prevTransit?.transit?.exit?.name || '';          // 结构化出口名
      const prevIsSubway = !!(prevTransit && prevTransit.transit_mode === 'SUBWAY');

      // 步行标题
      const walkTitle = isLastWalk
        ? `步行 ${fmtDist(seg.distance)} 至目的地`
        : prevIsSubway
          ? `步行 ${fmtDist(seg.distance)} 换乘`
          : `步行 ${fmtDist(seg.distance)}`;

      // 构造 subtitle：优先用结构化数据，其次用 assist_action
      let walkSubtitle = '';
      if (prevExit && nextStation) {
        // 出站换乘：从 XX口 出站 → 步行至下一站
        const entranceNote = nextEntrance ? `(${nextEntrance})` : '';
        walkSubtitle = `${prevExit}出站 → 步行至「${nextStation}${entranceNote}」换乘`;
      } else if (prevExit) {
        walkSubtitle = `从 ${prevExit} 出站步行${isLastWalk ? '至目的地' : ''}`;
      } else if (nextStation) {
        const entranceNote = nextEntrance ? `(${nextEntrance})` : '';
        walkSubtitle = `步行至「${nextStation}${entranceNote}」进站乘车`;
      } else if (isLastWalk) {
        walkSubtitle = lastStep?.assist_action || lastStep?.instruction || '步行到达目的地';
      } else {
        walkSubtitle = lastStep?.assist_action || lastStep?.instruction || '沿道路步行';
      }

      // detail：显示途经道路
      const roadNames = [...new Set(steps_arr.map(s => s.road).filter(Boolean))];
      const roadDetail = roadNames.length ? `沿 ${roadNames.join(' → ')}` : '';

      steps.push({
        icon: 'footprints',
        title: walkTitle,
        subtitle: walkSubtitle,
        detail: roadDetail || fmtTime(seg.time),
        isLast: isLastWalk,
      });
    } else if (mode === 'SUBWAY' || mode === 'BUS') {
      const lines = (seg.transit && seg.transit.lines) || [];
      const line = lines[0] || {};
      const onStation = (seg.transit && seg.transit.on_station && seg.transit.on_station.name) || '上车点';
      const offStation = (seg.transit && seg.transit.off_station && seg.transit.off_station.name) || '下车点';
      const viaNum = (seg.transit && seg.transit.via_num) || 0;
      const lineInfo = parseLineInfo(line.name, mode);

      // 结构化出入口数据（AMap TransitDetails.entrance / exit）
      const entranceName = seg.transit?.entrance?.name || '';
      const exitName = seg.transit?.exit?.name || '';

      const detailParts = [
        `途经 ${viaNum} 站`,
        fmtTime(seg.time),
        `¥${line.price || (mode === 'SUBWAY' ? 3 : 2)}`,
      ];
      if (exitName) detailParts.push(`${exitName} 出站`);

      // 上车指引
      const onWalkName = (prevSeg && prevSeg.transit_mode === 'WALK') ? onStation : null;
      let extra = '';
      if (onWalkName) {
        const gate = entranceName ? `(${entranceName})` : '';
        extra = `步行至「${onStation}${gate}」进站乘车`;
      }

      steps.push({
        icon: mode === 'SUBWAY' ? 'train-front' : 'bus',
        title: `${lineInfo.line}${lineInfo.direction ? ' · ' + lineInfo.direction : ''}`,
        subtitle: `${onStation} 上车 → ${offStation} 下车`,
        detail: detailParts.join(' · '),
        extra,
      });
    } else if (mode === 'TAXI') {
      const t = seg.transit || {};
      steps.push({
        icon: 'car-taxi-front',
        title: `打车 ${fmtDist(seg.distance)}`,
        subtitle: `${t.sname || '起点'} → ${t.tname || '终点'}`,
        detail: fmtTime(seg.time),
      });
    }
  });

  // 如果最后一段不是 walk，补一个终点 marker
  const last = segs[segs.length - 1];
  if (!last || last.transit_mode !== 'WALK') {
    steps.push({
      icon: 'map-pin-check',
      title: endName || '目的地',
      subtitle: '到达',
      detail: '',
      isLast: true,
    });
  } else {
    // 标记最后一步为 isLast
    steps[steps.length - 1].isLast = true;
  }

  return steps;
}

// 把 hybrid 的 legs 转成导航时间线
function buildHybridTimeline(route) {
  const steps = [];
  const startName = startPOI && startPOI.name;
  const endName = endPOI && endPOI.name;

  steps.push({
    icon: 'map-pin',
    badge: '起',
    title: startName || '起点',
    subtitle: '出发地',
    detail: '',
    isFirst: true,
  });

  route.segments.forEach((seg, idx) => {
    const segType = seg.type || seg.mode;
    const isLastSeg = idx === route.segments.length - 1;

    if (segType === 'taxi') {
      const km = (seg.distance || 0) / 1000;
      const from = seg.fromStation || '上车点';
      const to = seg.toStation || seg.lineName?.replace('打车到 ', '') || '目的地';

      let desc = `${from} → ${to}`;
      if (!isLastSeg) desc += '（换乘）';

      let detail = isLastSeg ? '到达目的地' : '下车换乘';
      if (seg.fromStation && seg.toStation) {
        detail = `从「${from}」上车 · ${detail}`;
      }

      steps.push({
        icon: 'car-taxi-front',
        title: `打车 ${km.toFixed(1)} km`,
        subtitle: desc,
        detail,
      });
    } else if (segType === 'transit') {
      const isSubway = seg.mode === 'SUBWAY' || seg.transitMode === 'SUBWAY';
      const lineInfo = parseLineInfo(seg.lineName, isSubway ? 'SUBWAY' : 'BUS');
      const from = seg.fromStation || '上车';
      const to = seg.toStation || '下车';
      const entrancePart = seg.entrance ? `${seg.entrance}进站 · ` : '';
      const exitPart = seg.exit ? ` · ${seg.exit}出站` : '';

      let detail = isLastSeg ? '到达终点附近，步行至目的地' : '换乘下一段';
      if (seg.entrance || seg.exit) {
        detail = entrancePart + detail + exitPart;
      }

      steps.push({
        icon: isSubway ? 'train-front' : 'bus',
        title: `${lineInfo.line}${lineInfo.direction ? ' · ' + lineInfo.direction : ''}`,
        subtitle: `「${from}」上车 → 「${to}」下车`,
        detail,
      });
    } else if (segType === 'walk') {
      const dist = fmtDist(seg.distance || 0);
      const to = seg.toStation || '';
      const from = seg.fromStation || '';
      let subtitle = '';
      let detail = '';
      if (isLastSeg) {
        subtitle = from ? `从 ${from} 步行到达` : '';
        detail = '到达';
      } else {
        subtitle = to ? `步行至「${to}」进站乘车` : (from ? `从「${from}」出发` : '');
        detail = '换乘';
      }
      steps.push({
        icon: 'footprints',
        title: isLastSeg ? `步行 ${dist} 至目的地` : `步行 ${dist}`,
        subtitle,
        detail,
      });
    } else if (segType === 'ride') {
      const dist = fmtDist(seg.distance || 0);
      const to = seg.toStation || '';
      const from = seg.fromStation || '';
      let subtitle = `${from} → ${to}`;
      let detail = isLastSeg ? '还车后到达' : '还车后换乘';
      if (!from && !to) subtitle = '';
      steps.push({
        icon: 'bike',
        title: `骑行 ${dist}`,
        subtitle,
        detail,
      });
    }
  });

  steps.push({
    icon: 'map-pin-check',
    title: endName || '目的地',
    subtitle: '到达',
    detail: '',
    isLast: true,
  });

  return steps;
}

// 把打车路线的 steps 转成主要道路摘要
function buildTaxiTimeline(route) {
  const startName = startPOI && startPOI.name;
  const endName = endPOI && endPOI.name;
  const steps = [];

  steps.push({
    icon: 'map-pin',
    badge: '起',
    title: startName || '起点',
    subtitle: '上车点',
    detail: '',
    isFirst: true,
  });

  // 从 route.raw.steps 提取主要道路
  const rawSteps = (route.raw && route.raw.steps) || [];
  const mainRoads = [];
  rawSteps.forEach(s => {
    if (s.road && !mainRoads.includes(s.road) && mainRoads.length < 4) {
      mainRoads.push(s.road);
    }
  });

  steps.push({
    icon: 'car-taxi-front',
    title: `打车 ${fmtDist(route.distance)}`,
    subtitle: mainRoads.length > 0
      ? `经 ${mainRoads.slice(0, 3).join(' → ')}`
      : '按导航行驶',
    detail: `${fmtTime((route.raw && route.raw.time) || route.time * 60)} · 含实时路况`,
  });

  if (route.congestion) {
    const sev = route.congestion.severity;
    const minPerKm = Math.round(route.congestion.ratio * 60);
    const roadName = (route.congestion.step && route.congestion.step.road) || '部分路段';
    steps.push({
      icon: sev === 'heavy' ? 'alert-triangle' : 'traffic-cone',
      title: sev === 'heavy' ? `严重拥堵 · ${roadName}` : `缓行 · ${roadName}`,
      subtitle: `约 ${minPerKm} 分钟/km`,
      detail: '可考虑地铁绕过此路段',
      warning: sev === 'heavy' ? 'heavy' : 'moderate',
    });
  }

  steps.push({
    icon: 'map-pin-check',
    title: endName || '目的地',
    subtitle: '下车点',
    detail: '',
    isLast: true,
  });

  return steps;
}

// 把时间线数组渲染为 HTML
function renderTimeline(steps) {
  return `
    <div class="nav-timeline">
      ${steps.map(s => renderNavStep(s)).join('')}
    </div>
  `;
}

// 显示路线详情
// ── 地图路线叠加层管理 ──────────────────────────────────
let _routeOverlays = [];
const mapSection = document.querySelector('.map-section');

function clearRouteOverlays() {
  _routeOverlays.forEach(o => { try { o.setMap(null); } catch (_) {} });
  _routeOverlays = [];
}

function moveMapToDetail(onReady) {
  const detailMap = document.getElementById('route-detail-map');
  if (!detailMap || !mapContainer || !map) return;
  detailMap.appendChild(mapContainer);
  requestAnimationFrame(() => {
    map.resize();
    if (typeof onReady === 'function') onReady();
  });
}

function restoreMapToPage() {
  if (!mapContainer || !mapSection || mapContainer.parentElement === mapSection) return;
  mapSection.appendChild(mapContainer);
  requestAnimationFrame(() => {
    map.resize();
    updateMapMarkers();
  });
}

// 在地图上绘制路线（polyline + 站点标记）
function drawRouteOnMap(route) {
  clearRouteOverlays();
  if (!map || !route) return;

  // 坐标统一转换：支持 {lng,lat}（实时）和 [lng,lat]（缓存）
  const toXY = p => (Array.isArray(p) ? p : (p && typeof p.lng === 'number' ? [p.lng, p.lat] : null));

  const COLORS = {
    SUBWAY: '#16B364', BUS: '#3B82F6', WALK: '#94A3B8', RIDE: '#06B6D4', TAXI: '#F59E0B',
  };
  const ZINDEX_LINE = 10, ZINDEX_STATION = 60;

  // 辅助：画线段（带白色描边，增加层次感）
  function addLine(path, color, opts = {}) {
    if (!Array.isArray(path) || path.length < 2) return;
    const validPath = path.filter(p => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (validPath.length < 2) return;

    const weight = opts.weight || 5;
    const baseOpts = {
      path: validPath, lineJoin: 'round', lineCap: 'round',
      strokeStyle: opts.dashed ? 'dashed' : 'solid',
    };

    // 白色描边（仅实线路线）
    if (!opts.noOutline) {
      const outline = new AMap.Polyline({
        ...baseOpts,
        strokeColor: opts.outlineColor || '#ffffff',
        strokeWeight: weight + 4,
        strokeOpacity: 0.85,
        strokeStyle: 'solid',
        zIndex: ZINDEX_LINE,
        borderWeight: 0,
      });
      outline.setMap(map);
      _routeOverlays.push(outline);
    }

    // 主线
    const line = new AMap.Polyline({
      ...baseOpts,
      strokeColor: color,
      strokeWeight: weight,
      strokeOpacity: opts.opacity || 0.92,
      zIndex: ZINDEX_LINE + 1,
      borderWeight: 0,
    });
    line.setMap(map);
    _routeOverlays.push(line);
  }

  // 辅助：画站点标记
  function addStation(lngLat, name, mode) {
    const color = COLORS[mode] || '#6B7280';
    const size = 18;
    const dotSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <circle cx="${size/2}" cy="${size/2}" r="6" fill="${color}" stroke="white" stroke-width="3"/>
    </svg>`;
    const marker = new AMap.Marker({
      position: lngLat,
      offset: new AMap.Pixel(-size/2, -size/2),
      zIndex: ZINDEX_STATION,
      icon: new AMap.Icon({
        size: new AMap.Size(size, size),
        imageSize: new AMap.Size(size, size),
        image: dotSvg,
      }),
      label: name ? {
        content: `<div style="
          background:rgba(255,255,255,0.95);color:#1e293b;padding:3px 10px;border-radius:6px;
          font-size:12px;font-weight:500;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.12);
          margin-top:6px;line-height:1.3;
        ">${name}</div>`,
        offset: new AMap.Pixel(-35, 14),
      } : undefined,
    });
    marker.setMap(map);
    _routeOverlays.push(marker);
  }

  if (!route) return;

  // ── Transit 路线：按 AMap segments 绘制 ──
  if (route.type === 'transit' && route.raw && Array.isArray(route.raw.segments)) {
    const segs = route.raw.segments;

    let prevPoint = startPOI && isValidLocation(startPOI.location)
      ? [startPOI.location.lng, startPOI.location.lat] : null;

    segs.forEach((seg, i) => {
      const mode = seg.transit_mode;

      if (mode === 'WALK') {
        // 构建步行精确路径：优先 steps[].path → walking.path → 起终点直线
        const walkPath = [];
        if (seg.walking && Array.isArray(seg.walking.steps)) {
          seg.walking.steps.forEach(step => {
            if (step.path && Array.isArray(step.path)) {
              step.path.forEach(p => { const xy = toXY(p); if (xy) walkPath.push(xy); });
            }
          });
        }
        // steps 没有路径时用 walking.path
        if (walkPath.length < 2 && seg.walking && Array.isArray(seg.walking.path)) {
          seg.walking.path.forEach(p => { const xy = toXY(p); if (xy) walkPath.push(xy); });
        }

        // 下一段的 on_station 是 walking 的终点
        const nextSeg = segs[i + 1];
        const nextTransit = nextSeg && nextSeg.transit;
        const walkEnd = (nextTransit && nextTransit.on_station
          && isValidLocation(nextTransit.on_station.location))
          ? [nextTransit.on_station.location.lng, nextTransit.on_station.location.lat]
          : null;

        if (walkPath.length >= 2) {
          addLine(walkPath, COLORS.WALK, { weight: 3, dashed: true, opacity: 0.6, noOutline: true });
          prevPoint = walkPath[walkPath.length - 1];
        } else if (prevPoint && walkEnd) {
          addLine([prevPoint, walkEnd], COLORS.WALK, { weight: 3, dashed: true, opacity: 0.6, noOutline: true });
          prevPoint = walkEnd;
        }
      } else if (mode === 'SUBWAY' || mode === 'BUS') {
        const transit = seg.transit || {};
        const onLoc = transit.on_station && isValidLocation(transit.on_station.location)
          ? [transit.on_station.location.lng, transit.on_station.location.lat] : null;
        const offLoc = transit.off_station && isValidLocation(transit.off_station.location)
          ? [transit.off_station.location.lng, transit.off_station.location.lat] : null;

        // 从上一个点到上车点的步行线
        if (prevPoint && onLoc && (
          !prevPoint[0] || !onLoc[0] ||
          Math.abs(prevPoint[0] - onLoc[0]) > 0.0001 ||
          Math.abs(prevPoint[1] - onLoc[1]) > 0.0001
        )) {
          addLine([prevPoint, onLoc], COLORS.WALK, { weight: 2, dashed: true, opacity: 0.5, noOutline: true });
        }

        // 公交/地铁线路：优先用 transit.path（中间坐标），兜底直线
        const transitPath = transit.path;
        if (Array.isArray(transitPath) && transitPath.length >= 2) {
          const points = transitPath.map(toXY).filter(Boolean);
          if (points.length >= 2) {
            addLine(points, COLORS[mode], { weight: 5 });
          } else if (onLoc && offLoc) {
            addLine([onLoc, offLoc], COLORS[mode], { weight: 5 });
          }
        } else if (onLoc && offLoc) {
          addLine([onLoc, offLoc], COLORS[mode], { weight: 5 });
        }

        // 站点标记
        if (onLoc) {
          addStation(onLoc, transit.on_station.name || '上车', mode);
        }
        if (offLoc) {
          addStation(offLoc, transit.off_station.name || '下车', mode);
        }

        prevPoint = offLoc || prevPoint;
      }
    });

    // 最后一段 → 终点
    if (prevPoint && endPOI && isValidLocation(endPOI.location)) {
      addLine([prevPoint, [endPOI.location.lng, endPOI.location.lat]], COLORS.WALK, { weight: 3, dashed: true, opacity: 0.6 });
    }
  }

  // ── Taxi / Walk / Ride：用 AMap 返回的详细 path ──
  if ((route.type === 'taxi' || route.type === 'walk' || route.type === 'ride') && route.raw) {
    const mode = route.type === 'ride' ? 'RIDE' : route.type === 'taxi' ? 'TAXI' : 'WALK';
    const rawPath = route.raw.path;
    if (Array.isArray(rawPath) && rawPath.length >= 2) {
      const points = rawPath.map(toXY).filter(Boolean);
      addLine(points, COLORS[mode], {
        weight: route.type === 'taxi' ? 6 : route.type === 'ride' ? 5 : 3,
        dashed: route.type === 'walk',
        opacity: route.type === 'walk' ? 0.75 : 0.85,
      });
    } else if (startPOI && endPOI) {
      // 兜底：直线
      addLine(
        [[startPOI.location.lng, startPOI.location.lat], [endPOI.location.lng, endPOI.location.lat]],
        COLORS[mode],
        { weight: route.type === 'taxi' ? 6 : route.type === 'ride' ? 5 : 3, dashed: route.type === 'walk', opacity: 0.75 }
      );
    }
  }

  // ── Hybrid 路线 ──
  if (route.type === 'hybrid') {
    const rawSegs = route.raw && route.raw.segments;
    if ((route.direction === 'taxi-transit-taxi' || route.direction === 'multimodal') && route.raw) {
      (route.raw.endpointLegs || route.raw.taxiLegs || []).forEach(leg => {
        if (Array.isArray(leg.from) && Array.isArray(leg.to)) {
          const mode = String(leg.type || 'taxi').toUpperCase();
          addLine([leg.from, leg.to], COLORS[mode] || COLORS.WALK, {
            weight: mode === 'WALK' ? 3 : 5,
            dashed: mode === 'WALK',
            opacity: mode === 'WALK' ? 0.65 : 0.85,
          });
        }
      });
      (rawSegs || []).forEach(seg => {
        const mode = seg.transit_mode;
        if (mode !== 'SUBWAY' && mode !== 'BUS') return;
        const transit = seg.transit || {};
        const onStation = transit.on_station;
        const offStation = transit.off_station;
        if (!isValidLocation(onStation?.location) || !isValidLocation(offStation?.location)) return;
        const onPoint = [onStation.location.lng, onStation.location.lat];
        const offPoint = [offStation.location.lng, offStation.location.lat];

        // 优先用 transit.path（详细轨迹），兜底直线
        const transitPath = transit.path;
        if (Array.isArray(transitPath) && transitPath.length >= 2) {
          const points = transitPath.map(toXY).filter(Boolean);
          addLine(points.length >= 2 ? points : [onPoint, offPoint], COLORS[mode], { weight: 5 });
        } else {
          addLine([onPoint, offPoint], COLORS[mode], { weight: 5 });
        }

        addStation(onPoint, onStation.name || '上车', mode);
        addStation(offPoint, offStation.name || '下车', mode);
      });
    }

    // 特殊处理 taxi-to-transit：先画打车段
    if (route.direction === 'taxi-to-transit' && rawSegs && startPOI) {
      const firstOn = rawSegs.find(s => s.transit_mode !== 'WALK');
      const onLoc = firstOn && firstOn.transit && firstOn.transit.on_station
        && firstOn.transit.on_station.location;
      if (onLoc && isValidLocation(onLoc)) {
        addLine(
          [[startPOI.location.lng, startPOI.location.lat], [onLoc.lng, onLoc.lat]],
          COLORS.TAXI, { weight: 5 }
        );
        addStation([onLoc.lng, onLoc.lat],
          firstOn.transit.on_station.name || '上车点', firstOn.transit_mode);
      }
    }

    // 画 remaining 段（AMap transit/walk）
    if (rawSegs) {
      const segs = rawSegs;
      let prev = startPOI && isValidLocation(startPOI.location)
        ? [startPOI.location.lng, startPOI.location.lat] : null;

      segs.forEach(seg => {
        if (seg.type === 'taxi' || seg.mode === 'taxi') {
        if (seg.points && Array.isArray(seg.points)) {
          addLine(seg.points, COLORS.TAXI, { weight: 5 });
          prev = seg.points[seg.points.length - 1];
        }
        if (seg.stationLocation && isValidLocation(seg.stationLocation)) {
          addStation([seg.stationLocation.lng, seg.stationLocation.lat],
            seg.stationName || '换乘站', 'BUS');
        }
        if (seg.viaStation && !seg.stationLocation) {
          // label-only station
        }
      } else if (seg.type === 'transit' || seg.mode === 'transit') {
        if (prev && seg.stationLocation && isValidLocation(seg.stationLocation)) {
          addLine([prev, [seg.stationLocation.lng, seg.stationLocation.lat]],
            COLORS.WALK, { weight: 2, dashed: true, opacity: 0.5 });
        }
        if (seg.stationLocation && isValidLocation(seg.stationLocation)) {
          const mode = (seg.transitMode === 'SUBWAY') ? 'SUBWAY' : 'BUS';
          addStation([seg.stationLocation.lng, seg.stationLocation.lat],
            seg.lineName || '乘车', mode);
        }
        prev = null; // 公交段结束后由下一段确定位置
      }
    });
  }
  }

  // 自适应视野（只传有效 overlay）
  const validOverlays = _routeOverlays.filter(o => o && typeof o.setMap === 'function');
  if (validOverlays.length > 0) {
    map.setFitView(validOverlays, false, [60, 60, 60, 60]);
  }
}

// ─────────────────────────────────────────────────────

function showRouteDetail(route) {
  let timelineSteps = [];

  if (route.type === 'transit' && route.raw && route.raw.segments) {
    const startName = startPOI && startPOI.name;
    const endName = endPOI && endPOI.name;
    timelineSteps = buildTransitTimeline(route.raw.segments, startName, endName);
  } else if (route.type === 'taxi') {
    timelineSteps = buildTaxiTimeline(route);
  } else if (route.type === 'hybrid') {
    timelineSteps = buildHybridTimeline(route);
  } else {
    // 回退
    const startName = startPOI && startPOI.name;
    const endName = endPOI && endPOI.name;
    timelineSteps = [
      { icon: 'map-pin', badge: '起', title: startName || '起点', subtitle: '出发地', isFirst: true },
      ...(route.segments || []).map(seg => ({
        icon: seg.icon ? emojiToLucide(seg.icon) : (seg.type === 'ride' ? 'bike' : seg.type === 'walk' ? 'footprints' : 'bus'),
        title: seg.lineName || (seg.type === 'ride' ? '骑行' : seg.type === 'walk' ? '步行' : seg.mode) || '路线',
        subtitle: `${fmtDist(seg.distance)}`,
      })),
      { icon: 'map-pin-check', title: endName || '目的地', subtitle: '到达', isLast: true },
    ];
  }

  const distanceKm = Math.round((route.distance || 0) / 1000 * 10) / 10;
  const weatherNote = getWeatherComfortNote();
  const weatherBanner = weatherNote
    ? `<div class="weather-banner"><i data-lucide="cloud-rain"></i><span>${weatherNote} — 步行/骑行舒适度降低</span></div>`
    : '';
  const trafficNote = (route.category === 'hybrid' && route.raw && route.raw.trafficSpeedKmh)
    ? `<div class="traffic-note"><i data-lucide="traffic-cone"></i><span>当前路况下打车约 <strong>${route.raw.trafficSpeedKmh} km/h</strong>，时间已含堵车</span></div>`
    : (route.category === 'taxi' && route.raw)
    ? `<div class="traffic-note"><i data-lucide="traffic-cone"></i><span>时间基于高德实时路况估算</span></div>`
    : '';

  modalBody.innerHTML = `
    <div class="route-detail">
      <div class="route-detail-map" id="route-detail-map" aria-label="路线地图"></div>
      <div class="detail-header">
        <div class="detail-cost">
          <span class="currency">¥</span>${getDisplayCost(route).toFixed(1)}<span class="unit">元${passengerCount > 1 ? '/人' : ''}</span>
        </div>
        <div class="detail-meta">
          <span><i data-lucide="clock"></i>${fmtMinutes(route.time)}</span>
          <span>${getComfortLabel(getComfortStars(route))} ${renderComfortStars(route)}</span>
          <span><i data-lucide="map-pin"></i>${distanceKm} km</span>
        </div>
      </div>
      ${weatherBanner}
      ${trafficNote}
      ${timelineSteps.length > 0 ? renderTimeline(timelineSteps) : '<p class="empty-hint">暂无详细路线信息</p>'}
    </div>
  `;
  modal.hidden = false;
  modal.style.display = 'flex';
  moveMapToDetail(() => drawRouteOnMap(route));
  refreshIcons();
}

// 事件绑定
gpsBtn.addEventListener('click', async () => {
  try {
    const location = await getCurrentLocation();
    const address = await reverseGeocode(location);
    startInput.value = address;
    startPOI = {
      location: location,
      name: '我的位置',
      address: address
    };
    map.setCenter(location);
    updateMapMarkers();
  } catch (error) {
    alert('获取位置失败: ' + error.message);
  }
});

swapBtn.addEventListener('click', () => {
  const temp = startInput.value;
  startInput.value = endInput.value;
  endInput.value = temp;

  const tempPOI = startPOI;
  startPOI = endPOI;
  endPOI = tempPOI;

  updateMapMarkers();
});

searchBtn.addEventListener('click', searchRoutes);

// 人数选择
const passengerMinus = document.getElementById('passenger-minus');
const passengerPlus = document.getElementById('passenger-plus');
const passengerCountEl = document.getElementById('passenger-count');

passengerMinus.addEventListener('click', () => {
  if (passengerCount > 1) {
    passengerCount--;
    passengerCountEl.textContent = passengerCount;
    if (allRoutes.length > 0) {
      sortRoutes(allRoutes, sortMode);
      allRoutes.forEach(route => { route.badge = null; });
      if (allRoutes[0]) allRoutes[0].badge = 'best';
      renderResults(allRoutes.slice(0, 14));
      saveSearchState();
    }
  }
});

passengerPlus.addEventListener('click', () => {
  if (passengerCount < 10) {
    passengerCount++;
    passengerCountEl.textContent = passengerCount;
    if (allRoutes.length > 0) {
      sortRoutes(allRoutes, sortMode);
      allRoutes.forEach(route => { route.badge = null; });
      if (allRoutes[0]) allRoutes[0].badge = 'best';
      renderResults(allRoutes.slice(0, 14));
      saveSearchState();
    }
  }
});

function closeRouteDetail() {
  modal.hidden = true;
  modal.style.display = 'none';
  clearRouteOverlays();
  restoreMapToPage();
}

closeModal.addEventListener('click', (e) => {
  e.stopPropagation();
  closeRouteDetail();
});

modal.addEventListener('click', (e) => {
  if (e.target === modal || e.target.classList.contains('modal-backdrop')) {
    closeRouteDetail();
  }
});

// 主题切换
const themeToggle = document.getElementById('theme-toggle');
function setTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
  }
  try { localStorage.setItem('theme', theme); } catch (e) {}
  // 同步地图 UI 主题
  setTimeout(() => { try { map && map.getMapStyle && refreshMapStyle(); } catch (e) {} }, 0);
}

// 排序模式切换
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-option');
  if (!btn) return;
  const mode = btn.dataset.mode;
  if (!mode || mode === sortMode) return;

  sortMode = mode;
  document.querySelectorAll('.mode-option').forEach(b => {
    const active = b.dataset.mode === sortMode;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  if (allRoutes.length > 0) {
    sortRoutes(allRoutes, sortMode);
    allRoutes.forEach(route => { route.badge = null; });
    if (allRoutes[0]) allRoutes[0].badge = 'best';
    renderResults(allRoutes.slice(0, 14));
    saveSearchState();
  }
});

function refreshMapStyle() {
  if (!map) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  map.setMapStyle(isDark ? 'amap://styles/dark' : 'amap://styles/light');
}

// ===========================================================================
// 滴滴 MCP 客户端
// ===========================================================================

// 设置存储（localStorage）
const SETTINGS_KEY = 'travel-optimizer-settings';
const DEFAULT_SETTINGS = {
  mcpUrl: 'https://mcp.didichuxing.com/mcp-servers',
  mcpKey: '',
  mcpTool: 'taxi_estimate',
  city: '北京',
  didiEndpoint: 'https://api.udache.com/gulfstream/pre-sale/v1/core/pMultiEstimatePriceV3',
  didiHeaders: {},
  didiBody: {},
};

const MCP_TAXI_CACHE_TTL_MS = 15 * 60 * 1000;
const MCP_COOLDOWN_MS = 5 * 60 * 1000;
const MCP_TAXI_CACHE_STORAGE_KEY = 'travel-optimizer-mcp-taxi-cache-v1';
const MCP_COOLDOWN_STORAGE_KEY = 'travel-optimizer-mcp-cooldown-until';

function isLocalMcpProxy() {
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
}

function getMcpCooldownUntil() {
  return Number(localStorage.getItem(MCP_COOLDOWN_STORAGE_KEY)) || 0;
}

function setMcpCooldown(retryAfterSeconds) {
  const duration = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? retryAfterSeconds * 1000
    : MCP_COOLDOWN_MS;
  const until = Date.now() + duration;
  localStorage.setItem(MCP_COOLDOWN_STORAGE_KEY, String(until));
  return until;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      didiHeaders: parsed.didiHeaders && typeof parsed.didiHeaders === 'object' ? parsed.didiHeaders : {},
      didiBody: parsed.didiBody && typeof parsed.didiBody === 'object' ? parsed.didiBody : {},
    };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
}

let appSettings = loadSettings();

function isMcpConfigured() {
  // 本地代理从服务端环境变量读取 key，浏览器无需持有它。
  if (isLocalMcpProxy()) return !!(appSettings.mcpUrl && appSettings.mcpTool);
  return !!(appSettings.mcpUrl && appSettings.mcpKey && appSettings.mcpTool);
}

// 多城市出租车计价规则（兜底用）
const TAXI_RULES = {
  '北京': { base: 14, baseKm: 3, perKm: 2.3, nightSurcharge: 0.3, perMinLowSpeed: 0.0, returnFeeStartKm: 15 },
  '上海': { base: 16, baseKm: 3, perKm: 2.5, nightSurcharge: 0.3, perMinLowSpeed: 0.0, returnFeeStartKm: 15 },
  '广州': { base: 12, baseKm: 3, perKm: 2.6, nightSurcharge: 0.3, perMinLowSpeed: 0.0, returnFeeStartKm: 15 },
  '深圳': { base: 10, baseKm: 2, perKm: 2.4, nightSurcharge: 0.3, perMinLowSpeed: 0.0, returnFeeStartKm: 15 },
  '杭州': { base: 13, baseKm: 3, perKm: 2.5, nightSurcharge: 0.3, perMinLowSpeed: 0.0, returnFeeStartKm: 15 },
  '成都': { base: 9,  baseKm: 2, perKm: 2.0, nightSurcharge: 0.3, perMinLowSpeed: 0.0, returnFeeStartKm: 15 },
};

// 用本地规则估算打车费（兜底）
function estimateTaxiByLocalRules(distanceMeters, timeSeconds) {
  const rule = TAXI_RULES[appSettings.city] || TAXI_RULES['北京'];
  const distKm = distanceMeters / 1000;
  let cost;
  if (distKm <= rule.baseKm) {
    cost = rule.base;
  } else {
    cost = rule.base + (distKm - rule.baseKm) * rule.perKm;
    // 远途返程费
    if (distKm > rule.returnFeeStartKm) {
      cost += (distKm - rule.returnFeeStartKm) * rule.perKm * 0.5;
    }
  }
  // 夜间加价（23:00 - 5:00）
  const hour = new Date().getHours();
  if (hour >= 23 || hour < 5) {
    cost *= 1 + rule.nightSurcharge;
  }
  return Math.round(cost * 100) / 100;
}

// MCP JSON-RPC 底层请求（method 直接传，可用来调用 tools/call 或 tools/list）
async function mcpRpc(method, params, { timeout = 8000 } = {}) {
  if (!isMcpConfigured()) {
    throw new Error('MCP 未配置');
  }

  const cooldownUntil = getMcpCooldownUntil();
  if (cooldownUntil > Date.now()) {
    const seconds = Math.ceil((cooldownUntil - Date.now()) / 1000);
    throw new Error(`实时价格暂不可用，请在 ${seconds} 秒后再试`);
  }

  const isLocalProxy = isLocalMcpProxy();
  // 本地代理不接收 query key；由 server.js 的 DIDI_MCP_KEY 环境变量保管。
  const url = isLocalProxy
    ? '/mcp-proxy'
    : `${appSettings.mcpUrl}?key=${encodeURIComponent(appSettings.mcpKey)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('Retry-After'));
        setMcpCooldown(retryAfter);
      }
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    // MCP 标准格式
    if (data.error) {
      const message = data.error.message || 'MCP 返回错误';
      if (/(使用限制|超出.*(?:限制|额度)|rate.?limit|quota|too many)/i.test(message)) {
        setMcpCooldown();
      }
      throw new Error(message);
    }

    return data.result;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error('请求超时（' + (timeout / 1000) + '秒）');
    }
    throw err;
  }
}

// 调用滴滴 MCP 工具（便捷封装）
async function callDidiMcp(toolName, args, { timeout = 8000 } = {}) {
  return mcpRpc('tools/call', { name: toolName, arguments: args }, { timeout });
}

// MCP 诊断：列出所有可用工具及参数定义
async function listMcpTools({ timeout = 8000 } = {}) {
  return mcpRpc('tools/list', {}, { timeout });
}

// 从 MCP 返回值中提取最低价格
// 返回 { price, carType, raw }
function parseTaxiEstimateResult(result) {
  if (!result) return null;

  // 优先用 structuredContent.items（滴滴 MCP 实际格式）
  const items = result?.structuredContent?.items;
  if (Array.isArray(items) && items.length > 0) {
    let best = null;
    for (const item of items) {
      const price = parseFloat(item.priceText || item.price);
      if (isNaN(price) || price <= 0) continue;
      if (!best || price < best.price) {
        best = {
          price,
          carType: item.productName || '',
          raw: result,
        };
      }
    }
    return best;
  }

  // 兼容旧格式：content[0].text 中可能是 JSON
  if (Array.isArray(result.content)) {
    const textItem = result.content.find(c => c.type === 'text' && c.text);
    if (textItem) {
      try {
        const payload = JSON.parse(textItem.text);
        if (Array.isArray(payload)) return parseTaxiEstimateResult({ structuredContent: { items: payload } });
      } catch (e) { /* not JSON, ignore */ }
    }
  }

  return null;
}

// MCP 预估结果缓存：内存中复用并持久化 15 分钟，防止重复搜索耗尽配额。
const _taxiEstimateCache = new Map();

function getStoredTaxiEstimate(cacheKey) {
  try {
    const all = JSON.parse(localStorage.getItem(MCP_TAXI_CACHE_STORAGE_KEY) || '{}');
    const entry = all[cacheKey];
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    if (entry) {
      delete all[cacheKey];
      localStorage.setItem(MCP_TAXI_CACHE_STORAGE_KEY, JSON.stringify(all));
    }
  } catch (e) { /* cache is optional */ }
  return null;
}

function storeTaxiEstimate(cacheKey, value) {
  try {
    const all = JSON.parse(localStorage.getItem(MCP_TAXI_CACHE_STORAGE_KEY) || '{}');
    all[cacheKey] = { value, expiresAt: Date.now() + MCP_TAXI_CACHE_TTL_MS };
    localStorage.setItem(MCP_TAXI_CACHE_STORAGE_KEY, JSON.stringify(all));
  } catch (e) { /* cache is optional */ }
}

// 用 MCP 拿打车价格（如果配置了）；失败/未配置都回退到本地规则
async function estimateTaxiViaDeprecatedMcp(distanceMeters, timeSeconds, { allowMcp = true } = {}) {
  if (allowMcp && isMcpConfigured()) {
    // MCP 需要起终点坐标+名称，缺一不可
    const hasFrom = startPOI && isValidLocation(startPOI.location) && startPOI.name;
    const hasTo = endPOI && isValidLocation(endPOI.location) && endPOI.name;

    if (hasFrom && hasTo) {
      const cacheKey = [
        startPOI.location.lat, startPOI.location.lng,
        endPOI.location.lat, endPOI.location.lng,
      ].map(v => v.toFixed(6)).join(',');

      const stored = getStoredTaxiEstimate(cacheKey);
      if (stored) {
        return { ...stored, distance: distanceMeters, time: timeSeconds };
      }

      // 如果已有缓存结果或正在请求中，直接复用
      if (!_taxiEstimateCache.has(cacheKey)) {
        _taxiEstimateCache.set(cacheKey, (async () => {
          try {
            // taxi_estimate 所有参数均为字符串类型
            const args = {
              from_lng: String(startPOI.location.lng),
              from_lat: String(startPOI.location.lat),
              from_name: startPOI.name,
              to_lng: String(endPOI.location.lng),
              to_lat: String(endPOI.location.lat),
              to_name: endPOI.name,
            };

            const result = await callDidiMcp(appSettings.mcpTool, args);
            const parsed = parseTaxiEstimateResult(result);
            if (parsed) {
              const value = {
                cost: parsed.price,
                source: 'mcp',
                carType: parsed.carType,
                raw: null,
              };
              storeTaxiEstimate(cacheKey, value);
              return value;
            }
            console.warn('[taxi] MCP 返回无法解析，回退本地规则');
          } catch (err) {
            console.warn('[taxi] MCP 调用失败，回退本地规则:', err.message);
          }
          return null;
        })());
      }

      const mcpResult = await _taxiEstimateCache.get(cacheKey);
      // Map 仅用于合并同时发起的请求；有效结果已写入带 TTL 的持久缓存。
      _taxiEstimateCache.delete(cacheKey);
      if (mcpResult) {
        return { ...mcpResult, distance: distanceMeters, time: timeSeconds };
      }
    }
  }

  // 回退：本地规则
  return {
    cost: estimateTaxiByLocalRules(distanceMeters, timeSeconds),
    distance: distanceMeters,
    time: timeSeconds,
    source: 'local',
    carType: '',
    raw: null,
  };
}
// ===========================================================================
// 滴滴小程序估价（pMultiEstimatePriceV3）
// ===========================================================================

// 城市名 → 滴滴 city_id 映射
const DIDI_CITY_ID_MAP = {
  '北京': 1, '上海': 4, '广州': 6, '深圳': 7,
  '杭州': 11, '成都': 28, '武汉': 19, '南京': 10,
  '重庆': 89, '天津': 2, '西安': 43, '长沙': 33,
  '郑州': 149, '苏州': 142, '大连': 14, '沈阳': 17,
  '青岛': 30, '厦门': 36, '昆明': 51, '福州': 34,
};

const _didiEstimateCache = new Map();
const _didiEstimateInFlight = new Map();
const DIDI_ESTIMATE_CACHE_TTL_MS = 15 * 60 * 1000;

// 叫车难度阈值（启发式）：应答率低于此或预计等待不短于此 → 判定该区域叫车较难
const TAXI_DIFFICULTY = { lowAnswerRate: 60 };

// 打车最小距离参考值（非硬阈值，实际由 isTaxiWorthIt 综合步行时间+天气判断）
// 全程 ~1000m → 步行约 12 分钟，接驳段 ~800m → 步行约 10 分钟
const TAXI_MIN_FULL_M = 1000;
const TAXI_MIN_LEG_M = 800;

// 对可空数值取最值（null 视为缺失，不参与比较；全 null 返回 null）
function minOrNull(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}
function maxOrNull(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

// 解析滴滴估价 API 响应，提取「实际可叫」的最便宜车型
// 返回 { price, carType, allOptions, skippedCarpool } 或 null
//
// 滴滴 pMultiEstimatePriceV3 响应结构：
//   data.rec_layout[]    — 推荐的车型卡片（优先参考，已是滴滴筛选后的可叫档）
//   data.layout[]        — 全部车型卡片（含快送/跑腿/代驾/包车/宠物等非客运档）
//   data.category_info[] — 类别元数据 { category_id, title, sub_title }
//   data.estimate_data   — { productId: { fee_amount, car_title, combo_type, disabled, ... } }
//
// 每条 layout/rec_layout: { price, category_id, groups[{ products[productId], ... }], theme_data, ... }
//
// 「实际可叫」判定（用户共识：最便宜那档往往是拼车，附近无车叫不到，需升到更贵档）：
//   - 跳过 disabled=1 的档（滴滴自己灰掉的）
//   - 跳过拼车档（combo_type=4 / multi_route_tip_type=carpool / 有 multi_price_list 未拼成价 / carpool_seat_list）
//     拼车的展示价是「拼成」价，未拼成更贵且最易叫不到车
//   - 跳过非客运档（跑腿/快送/代驾/包车/宠物，按车名关键词识别，仅在 layout 兜底路径出现）
function parseDidiEstimateResponse(data) {
  if (!data || Number(data.errno) !== 0) return null;

  const respData = data.data;
  if (!respData) return null;

  // 1. estimate_data：productId → 详情（车名 / 一口价 / 拼车 / disabled 的真相来源）
  const detailByPid = {};
  if (respData.estimate_data && typeof respData.estimate_data === 'object') {
    for (const [pid, d] of Object.entries(respData.estimate_data)) {
      detailByPid[pid] = d;
    }
  }

  // 2. category_id → 名称（兜底用，真实车名优先取 estimate_data.car_title）
  const categoryMap = {};
  if (Array.isArray(respData.category_info)) {
    for (const cat of respData.category_info) {
      if (cat.category_id != null) {
        categoryMap[cat.category_id] = cat.title || cat.sub_title || '';
      }
    }
  }

  const NON_PASSENGER_RE = /跑腿|快送|代驾|包车|宠物/;

  // 某个 productId 对应的车型是否「不可叫」（拼车 / 禁用 / 非客运）
  function isUnbookable(d) {
    if (!d) return false;
    if (Number(d.disabled) === 1) return true;                       // 滴滴明确灰掉
    if (Number(d.combo_type) === 4) return true;                     // 拼车组合
    if (d.multi_route_tip_type === 'carpool') return true;
    if (Array.isArray(d.multi_price_list) && d.multi_price_list.length > 0) return true; // 未拼成/拼成
    if (Array.isArray(d.carpool_seat_list) && d.carpool_seat_list.length > 0) return true;
    if (NON_PASSENGER_RE.test(d.car_title || d.name || '')) return true;
    return false;
  }

  // 从一个 layout/rec_layout 卡片解析出候选车型（可能多产品，如「更多品牌」聚合组）
  function extractFromLayout(layoutArray) {
    if (!Array.isArray(layoutArray)) return [];
    const results = [];
    for (const item of layoutArray) {
      const groups = Array.isArray(item.groups) ? item.groups : [];
      const pids = [];
      for (const g of groups) {
        if (Array.isArray(g.products)) pids.push(...g.products);
      }

      if (pids.length === 0) {
        // 老结构：卡片本身一个价 + 类别名
        const price = parsePrice(item.theme_data?.price ?? item.price);
        if (price == null) continue;
        results.push({
          price,
          carType: categoryMap[item.category_id] || item.sub_category_title || item.title || '',
          productId: null,
          unbookable: false,
        });
        continue;
      }

      for (const pid of pids) {
        const d = detailByPid[pid];
        // 价格优先取该产品在 estimate_data 里的一口价，其次卡片价
        const price = parsePrice(d?.fee_amount ?? d?.price ?? item.theme_data?.price ?? item.price);
        if (price == null) continue;
        const carType = (d && (d.car_title || d.carTitle)) || categoryMap[item.category_id] || item.sub_category_title || '';
        results.push({ price, carType, productId: pid, unbookable: isUnbookable(d) });
      }
    }
    return results;
  }

  function parsePrice(raw) {
    if (raw == null) return null;
    const n = parseFloat(raw);
    if (!isNaN(n) && n > 0) return n;
    const m = String(raw).match(/[\d.]+/);
    return m ? parseFloat(m[0]) : null;
  }

  // 3. 优先 rec_layout（推荐），其次 layout（全部），最后 estimate_data 全量
  let allOptions = extractFromLayout(respData.rec_layout);
  if (allOptions.length === 0) {
    allOptions = extractFromLayout(respData.layout);
  }
  if (allOptions.length === 0) {
    // estimate_data 全量兜底（无 layout 结构时）
    for (const [pid, d] of Object.entries(detailByPid)) {
      const price = parsePrice(d.fee_amount || d.price || d.estimate_price || d.estimatePrice);
      if (price == null) continue;
      allOptions.push({
        price,
        carType: d.car_title || d.name || d.product_name || `车型${pid}`,
        productId: pid,
        unbookable: isUnbookable(d),
      });
    }
  }

  if (allOptions.length === 0) {
    // 诊断：errno=0 但所有数据源为空，大概率是凭证过期
    const estEmpty = !respData.estimate_data || (typeof respData.estimate_data === 'object' && Object.keys(respData.estimate_data).length === 0);
    const layoutEmpty = !Array.isArray(respData.layout) || respData.layout.length === 0;
    const recEmpty = !Array.isArray(respData.rec_layout) || respData.rec_layout.length === 0;
    if (estEmpty && layoutEmpty && recEmpty) {
      console.warn('[滴滴估价] errno=0 但 estimate_data/layout/rec_layout 全部为空，大概率是 token/wsgsig 过期，请重新抓包更新凭证');
    }
    return null;
  }

  // 4. 过滤出「实际可叫」档；全部被过滤时退回原候选（不因过滤而误报凭证过期）
  const bookable = allOptions.filter(o => !o.unbookable);
  const skippedCarpool = allOptions.length - bookable.length;
  const pool = bookable.length ? bookable : allOptions;

  // 按价格升序排列
  pool.sort((a, b) => a.price - b.price);

  // 5. 区域叫车难度信号 + 滴滴行程用时
  //    expect_params.answer_rate           — 应答率（0-100），越低越难叫到车
  //    tab_extra_data.classify.duration    — 滴滴估算行程用时秒数（上车→下车，非等车时间）
  //    tab_extra_data.classify.time_text   — 兜底文本「18分钟」
  //    order_button_info.expect_info_text  — 兜底文本「应答率{38}%」
  let answerRate = null;
  const expectParams = respData.expect_params || {};
  if (Number.isFinite(expectParams.answer_rate)) {
    answerRate = Number(expectParams.answer_rate);
  } else {
    const m = String(respData.order_button_info?.expect_info_text || '').match(/应答率\{(\d+)\}/);
    if (m) answerRate = Number(m[1]);
  }
  // 滴滴自己的行程用时估算（与高德驾车时间互为参考，非等车接驾时间）
  let didiDurationMinutes = null;
  const classify = respData.tab_extra_data?.classify;
  if (classify && Number.isFinite(classify.duration)) {
    didiDurationMinutes = Math.round(Number(classify.duration) / 60);
  } else if (classify && classify.time_text) {
    const m = String(classify.time_text).match(/(\d+)\s*分钟/);
    if (m) didiDurationMinutes = Number(m[1]);
  }

  // 6. 叫车困难时，不选最便宜的（最难叫到），选「容易叫到且便宜」的平衡档
  //    启发式：应答率越低 → 跳过的便宜档越多
  let difficultySkip = 0;
  if (answerRate != null && answerRate < 40) difficultySkip = 2;
  else if (answerRate != null && answerRate < TAXI_DIFFICULTY.lowAnswerRate) difficultySkip = 1;

  // 最多跳过一半（至少保留一个选项，不跳到最贵档）
  const maxSkip = Math.max(0, Math.floor(pool.length / 2) - 1);
  difficultySkip = Math.min(difficultySkip, maxSkip);

  const best = pool[difficultySkip];

  if (skippedCarpool > 0 || difficultySkip > 0) {
    const parts = [];
    if (skippedCarpool > 0) parts.push(`跳过 ${skippedCarpool} 个不可叫档（拼车/禁用/非客运）`);
    if (difficultySkip > 0) parts.push(`叫车困难（应答率${answerRate ?? '?'}%），跳过最便宜 ${difficultySkip} 档`);
    console.info(`[滴滴估价] ${parts.join('；')}，选中「${best.carType}」¥${best.price}`);
  }

  return { ...best, allOptions: pool, skippedCarpool, answerRate, didiDurationMinutes, difficultySkip };
}

// 调用服务端滴滴估价代理，返回 { cost, source, carType, allOptions, raw }
async function getDidiEstimate(fromLocation, toLocation, tripMeta = {}) {
  const from = coordinatePair(fromLocation);
  const to = coordinatePair(toLocation);
  if (!from || !to || !from.every(Number.isFinite) || !to.every(Number.isFinite)) {
    throw new Error('缺少有效的打车起终点坐标');
  }

  const configFingerprint = JSON.stringify({
    endpoint: appSettings.didiEndpoint,
    headers: appSettings.didiHeaders,
    body: appSettings.didiBody,
  });
  const cacheKey = [...from, ...to].map(v => Number(v).toFixed(6)).join(',') + '|' + configFingerprint;

  // 缓存命中
  const cached = _didiEstimateCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.info('[滴滴估价缓存命中]', { from, to, result: cached.value });
    return cached.value;
  }

  // 复用进行中请求
  if (_didiEstimateInFlight.has(cacheKey)) {
    console.info('[滴滴估价复用进行中请求]', { from, to });
    return _didiEstimateInFlight.get(cacheKey);
  }

  const request = (async () => {
    console.info('[滴滴估价请求]', { from, to });

    const cityId = DIDI_CITY_ID_MAP[appSettings.city] || 1;
    const maxRetries = 2;
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = attempt * 1200 + Math.random() * 800;
        console.info(`[滴滴估价] 第 ${attempt} 次重试，等待 ${Math.round(delay)}ms…`);
        await new Promise(r => setTimeout(r, delay));
      }

      const response = await fetch('/didi-estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_lat: from[1],
          from_lng: from[0],
          from_name: tripMeta.fromName || startPOI?.name || '',
          from_address: tripMeta.fromAddress || startPOI?.address || '',
          to_lat: to[1],
          to_lng: to[0],
          to_name: tripMeta.toName || endPOI?.name || '',
          to_address: tripMeta.toAddress || endPOI?.address || '',
          city_id: cityId,
          didi_config: {
            endpoint: appSettings.didiEndpoint,
            headers: appSettings.didiHeaders,
            body: appSettings.didiBody,
          },
        }),
      });

      // 502/504 可重试，其他错误直接抛出
      if (!response.ok) {
        const retryable = response.status === 502 || response.status === 504;
        lastError = new Error(
          retryable
            ? `滴滴估价服务暂不可用（HTTP ${response.status}），正在重试…`
            : `滴滴估价服务异常（HTTP ${response.status}）`
        );
        console.error('[滴滴估价失败]', { status: response.status, retryable, attempt });
        if (retryable && attempt < maxRetries) continue;
        throw lastError;
      }

      const data = await response.json();
      console.info('[滴滴估价响应]', data);

      // 检查业务层错误
      if (data.error) {
        throw new Error(data.error);
      }
      if (data.errno !== undefined && Number(data.errno) !== 0) {
        throw new Error(data.errmsg || `滴滴接口错误（errno=${data.errno}）`);
      }

      const parsed = parseDidiEstimateResponse(data);
      if (!parsed) {
        console.warn('[滴滴估价] 无法解析响应，原始数据:', JSON.stringify(data).slice(0, 500));
        // 检查是否是凭证过期的典型症状
        const respData = data.data;
        const allEmpty = respData &&
          (!respData.estimate_data || Object.keys(respData.estimate_data).length === 0) &&
          (!Array.isArray(respData.layout) || respData.layout.length === 0) &&
          (!Array.isArray(respData.rec_layout) || respData.rec_layout.length === 0);
        // 滴滴有时会通过 toast_tip 返回提示（如"当前城市暂未开通服务"）
        const tip = (respData && respData.toast_tip) ? ` (${respData.toast_tip})` : '';
        throw new Error(
          allEmpty
            ? `滴滴会话凭证可能已过期，请在设置中重新抓包更新 token/wsgsig${tip}`
            : `滴滴返回无法解析的价格数据${tip}`
        );
      }

      const value = {
        cost: parsed.price,
        source: 'didi',
        carType: parsed.carType,
        allOptions: parsed.allOptions,
        answerRate: parsed.answerRate,
        didiDurationMinutes: parsed.didiDurationMinutes,
        raw: null,
      };
      _didiEstimateCache.set(cacheKey, { value, expiresAt: Date.now() + DIDI_ESTIMATE_CACHE_TTL_MS });
      return value;
    }
    // 所有重试都失败
    throw lastError;
  })();

  _didiEstimateInFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    _didiEstimateInFlight.delete(cacheKey);
  }
}

function coordinatePair(location) {
  if (Array.isArray(location)) return location;
  return location && [location.lng, location.lat];
}

async function estimateTaxi(distanceMeters, timeSeconds, fromLocation, toLocation, tripMeta = {}) {
  // 优先使用滴滴实时价格
  try {
    const didiResult = await getDidiEstimate(fromLocation, toLocation, tripMeta);
    return {
      ...didiResult,
      distance: didiResult.distance || distanceMeters,
      time: didiResult.time || timeSeconds,
    };
  } catch (err) {
    console.warn('[taxi] 滴滴估价失败，回退本地规则:', err.message);
  }

  // 回退：本地计价规则
  return {
    cost: estimateTaxiByLocalRules(distanceMeters, timeSeconds),
    distance: distanceMeters,
    time: timeSeconds,
    source: 'local',
    carType: '',
    raw: null,
  };
}

if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    setTheme(current === 'dark' ? 'light' : 'dark');
  });
}

// ===========================================================================
// 设置面板
// ===========================================================================
const settingsModal = document.getElementById('settings-modal');
const settingsBtn = document.getElementById('settings-btn');
const cfgCity = document.getElementById('cfg-city');
const cfgDidiEndpoint = document.getElementById('cfg-didi-endpoint');
const cfgDidiRaw = document.getElementById('cfg-didi-raw');
const cfgParseDidi = document.getElementById('cfg-parse-didi');
const cfgDidiHeaders = document.getElementById('cfg-didi-headers');
const cfgDidiBody = document.getElementById('cfg-didi-body');
const cfgTestDidi = document.getElementById('cfg-test-didi');
const cfgSaveBtn = document.getElementById('cfg-save');
const cfgExport = document.getElementById('cfg-export');
const cfgImportBtn = document.getElementById('cfg-import-btn');
const cfgImportArea = document.getElementById('cfg-import-area');
const cfgImportText = document.getElementById('cfg-import-text');
const cfgImportConfirm = document.getElementById('cfg-import-confirm');
const cfgImportCancel = document.getElementById('cfg-import-cancel');
const didiStatus = document.getElementById('didi-status');
const didiTestResult = document.getElementById('didi-test-result');

function formatSettingsJson(value) {
  return Object.keys(value || {}).length ? JSON.stringify(value, null, 2) : '';
}

function parseSettingsJson(input, label) {
  const raw = (input.value || '').trim();
  if (!raw) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label}不是有效的 JSON`);
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${label}必须是 JSON 对象`);
  }
  return value;
}

const DIDI_CAPTURE_IGNORED_HEADERS = new Set([
  'host', 'connection', 'content-length', 'content-type',
  'accept-encoding', 'xregionkeyvalue', 'didi-header-hint-content', 'didi-header-rid',
]);

function isDynamicDidiBodyKey(key) {
  return key === 'lat' || key === 'lng' || key === 'xpsid' ||
    key === 'stopover_points' || key === 'dest_poi_code' ||
    key.startsWith('choose_') ||
    /^(?:from|to)_(?:lat|lng|poi_id|poi_type|address|name|poi_code)$/.test(key);
}

function decodeCapturedFormValue(value) {
  try {
    // 抓包文本中的 Base64 凭证常含 "+"，不能按 URLSearchParams 的空格规则处理。
    return decodeURIComponent(value);
  } catch (err) {
    return value;
  }
}

function parseDidiCapture(rawCapture) {
  const raw = String(rawCapture || '').trim();
  if (!raw) throw new Error('请先粘贴滴滴请求头和请求体');

  const headers = {};
  const bodyLines = [];
  let endpoint = DEFAULT_SETTINGS.didiEndpoint;
  let readingBody = false;
  let ignoredCount = 0;

  raw.split(/\r?\n/).forEach(sourceLine => {
    const line = sourceLine.trim();
    if (!line) {
      readingBody = true;
      return;
    }

    const urlMatch = line.match(/https:\/\/[^\s]+/i);
    if (!readingBody && urlMatch) {
      try {
        const parsedUrl = new URL(urlMatch[0]);
        if (/(^|\.)udache\.com$/i.test(parsedUrl.hostname) || /(^|\.)didichuxing\.com$/i.test(parsedUrl.hostname)) {
          endpoint = parsedUrl.toString();
        }
      } catch (err) {}
    }

    const headerMatch = !readingBody && line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (headerMatch) {
      const name = headerMatch[1];
      if (DIDI_CAPTURE_IGNORED_HEADERS.has(name.toLowerCase())) {
        ignoredCount++;
      } else {
        headers[name] = headerMatch[2];
      }
      return;
    }

    if (line.includes('=')) {
      readingBody = true;
      bodyLines.push(line);
    }
  });

  const body = {};
  bodyLines.join('').split('&').forEach(pair => {
    if (!pair) return;
    const separator = pair.indexOf('=');
    const rawKey = separator >= 0 ? pair.slice(0, separator) : pair;
    const rawValue = separator >= 0 ? pair.slice(separator + 1) : '';
    const key = decodeCapturedFormValue(rawKey);
    if (!key) return;
    if (isDynamicDidiBodyKey(key)) {
      ignoredCount++;
      return;
    }
    body[key] = decodeCapturedFormValue(rawValue);
  });

  const wsgsigKey = Object.keys(headers).find(key => key.toLowerCase() === 'wsgsig');
  if (!wsgsigKey || !headers[wsgsigKey]) throw new Error('抓包原文中没有找到 wsgsig');
  if (!body.token) throw new Error('抓包原文中没有找到 token');

  return { endpoint, headers, body, ignoredCount };
}

function readDidiSettingsForm() {
  return {
    city: cfgCity.value || '北京',
    didiEndpoint: (cfgDidiEndpoint.value || DEFAULT_SETTINGS.didiEndpoint).trim(),
    didiHeaders: parseSettingsJson(cfgDidiHeaders, '请求头参数'),
    didiBody: parseSettingsJson(cfgDidiBody, '请求体参数'),
  };
}

function fillSettingsForm() {
  cfgCity.value = appSettings.city || DEFAULT_SETTINGS.city;
  cfgDidiEndpoint.value = appSettings.didiEndpoint || DEFAULT_SETTINGS.didiEndpoint;
  cfgDidiRaw.value = '';
  cfgDidiHeaders.value = formatSettingsJson(appSettings.didiHeaders);
  cfgDidiBody.value = formatSettingsJson(appSettings.didiBody);
  didiTestResult.className = 'settings-test-result';
  didiTestResult.textContent = '';
  refreshDidiStatus();
}

function refreshDidiStatus() {
  if (!didiStatus) return;
  const customCount = Object.keys(appSettings.didiHeaders || {}).length +
    Object.keys(appSettings.didiBody || {}).length +
    (appSettings.didiEndpoint !== DEFAULT_SETTINGS.didiEndpoint ? 1 : 0);
  if (customCount > 0) {
    didiStatus.textContent = `自定义 ${customCount} 项`;
    didiStatus.className = 'settings-status is-configured';
  } else {
    didiStatus.textContent = '使用默认';
    didiStatus.className = 'settings-status';
  }
}

function openSettings() {
  fillSettingsForm();
  settingsModal.hidden = false;
  settingsModal.style.display = 'flex';
  refreshIcons();
}

function closeSettings() {
  settingsModal.hidden = true;
  settingsModal.style.display = 'none';
}

if (settingsBtn) settingsBtn.addEventListener('click', openSettings);

document.querySelectorAll('[data-close-settings]').forEach(el => {
  el.addEventListener('click', closeSettings);
});

if (cfgParseDidi) {
  cfgParseDidi.addEventListener('click', () => {
    try {
      const parsed = parseDidiCapture(cfgDidiRaw.value);
      cfgDidiEndpoint.value = parsed.endpoint;
      cfgDidiHeaders.value = formatSettingsJson(parsed.headers);
      cfgDidiBody.value = formatSettingsJson(parsed.body);
      cfgDidiRaw.value = '';
      didiTestResult.className = 'settings-test-result show is-success';
      didiTestResult.textContent = `解析完成：${Object.keys(parsed.headers).length} 个请求头、${Object.keys(parsed.body).length} 个请求体参数，已忽略 ${parsed.ignoredCount} 个动态字段。请先测试，再保存。`;
    } catch (err) {
      didiTestResult.className = 'settings-test-result show is-error';
      didiTestResult.textContent = err.message;
    }
  });
}

if (cfgSaveBtn) {
  cfgSaveBtn.addEventListener('click', () => {
    try {
      appSettings = { ...appSettings, ...readDidiSettingsForm() };
    } catch (err) {
      didiTestResult.className = 'settings-test-result show is-error';
      didiTestResult.textContent = err.message;
      return;
    }
    saveSettings(appSettings);
    _didiEstimateCache.clear();
    _didiEstimateInFlight.clear();
    // 更新搜索插件城市 & 地图中心
    const newCity = appSettings.city || '北京';
    if (_autoCompleteStart) _autoCompleteStart.setCity(newCity);
    if (_autoCompleteEnd) _autoCompleteEnd.setCity(newCity);
    if (_placeSearchStart) _placeSearchStart.setCity(newCity);
    if (_placeSearchEnd) _placeSearchEnd.setCity(newCity);
    if (transfer) transfer.setCity(newCity);
    if (map) {
      map.setCenter(getCityCenter(newCity));
    }

    refreshIcons();
    closeSettings();
  });
}

if (cfgTestDidi) {
  cfgTestDidi.addEventListener('click', async () => {
    const prevSettings = { ...appSettings };
    try {
      appSettings = { ...appSettings, ...readDidiSettingsForm() };
      cfgTestDidi.disabled = true;
      didiTestResult.className = 'settings-test-result show';
      didiTestResult.textContent = '正在测试北京站到三里屯的估价...';
      const result = await getDidiEstimate([116.4273, 39.9047], [116.4551, 39.9322], {
        fromName: '北京站',
        toName: '三里屯',
      });
      didiTestResult.className = 'settings-test-result show is-success';
      didiTestResult.textContent = `连接成功，北京站到三里屯最低约 ¥${result.cost}` +
        (result.carType ? `（${result.carType}）` : '');
    } catch (err) {
      didiTestResult.className = 'settings-test-result show is-error';
      didiTestResult.textContent = err.message;
    } finally {
      appSettings = prevSettings;
      cfgTestDidi.disabled = false;
    }
  });
}

// 导出设置 — 同时尝试剪贴板 + 写入文本框兜底
if (cfgExport) {
  cfgExport.addEventListener('click', () => {
    const exportData = {
      city: appSettings.city,
      didiEndpoint: appSettings.didiEndpoint,
      didiHeaders: appSettings.didiHeaders,
      didiBody: appSettings.didiBody,
      _version: 1,
      _exported: new Date().toISOString(),
    };
    const json = JSON.stringify(exportData, null, 2);
    // 始终写入导入文本框，确保用户一定能拿到
    if (cfgImportText) {
      cfgImportText.value = json;
      cfgImportArea.style.display = 'block';
    }
    // 同时尝试剪贴板
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(() => {
        if (didiTestResult) {
          didiTestResult.className = 'settings-test-result show is-success';
          didiTestResult.textContent = '设置已复制到剪贴板，也可从下方文本框手动复制';
        }
      }).catch(() => {
        if (didiTestResult) {
          didiTestResult.className = 'settings-test-result show';
          didiTestResult.textContent = '自动复制失败，请手动复制下方文本框中的 JSON';
        }
      });
    } else {
      if (didiTestResult) {
        didiTestResult.className = 'settings-test-result show';
        didiTestResult.textContent = '当前浏览器不支持自动复制，请手动复制下方 JSON';
      }
    }
  });
}

// 导入设置 — 点击显示粘贴区
if (cfgImportBtn) {
  cfgImportBtn.addEventListener('click', () => {
    cfgImportArea.style.display = 'block';
    if (cfgImportText) cfgImportText.focus();
  });
}

// 导入确认
if (cfgImportConfirm) {
  cfgImportConfirm.addEventListener('click', () => {
    const raw = (cfgImportText && cfgImportText.value || '').trim();
    if (!raw) {
      if (didiTestResult) {
        didiTestResult.className = 'settings-test-result show is-error';
        didiTestResult.textContent = '请先粘贴导出的设置 JSON';
      }
      return;
    }
    let importData;
    try {
      importData = JSON.parse(raw);
    } catch (err) {
      if (didiTestResult) {
        didiTestResult.className = 'settings-test-result show is-error';
        didiTestResult.textContent = 'JSON 格式无效，请检查复制内容是否完整';
      }
      return;
    }
    if (!importData || typeof importData !== 'object') {
      if (didiTestResult) {
        didiTestResult.className = 'settings-test-result show is-error';
        didiTestResult.textContent = '格式不正确，必须是导出时生成的对象';
      }
      return;
    }
    if (importData.city) appSettings.city = importData.city;
    if (importData.didiEndpoint) appSettings.didiEndpoint = importData.didiEndpoint;
    if (importData.didiHeaders && typeof importData.didiHeaders === 'object') {
      appSettings.didiHeaders = importData.didiHeaders;
    }
    if (importData.didiBody && typeof importData.didiBody === 'object') {
      appSettings.didiBody = importData.didiBody;
    }
    saveSettings(appSettings);
    _didiEstimateCache.clear();
    _didiEstimateInFlight.clear();
    fillSettingsForm();
    cfgImportText.value = '';
    cfgImportArea.style.display = 'none';
    if (didiTestResult) {
      didiTestResult.className = 'settings-test-result show is-success';
      didiTestResult.textContent = '设置导入成功，请点击保存或直接测试连接';
    }
  });
}

// 导入取消
if (cfgImportCancel) {
  cfgImportCancel.addEventListener('click', () => {
    if (cfgImportText) cfgImportText.value = '';
    cfgImportArea.style.display = 'none';
  });
}

// 结果卡片点击 — 用事件委托代替逐卡绑定，避免监听器累积
if (resultsList) {
  resultsList.addEventListener('click', (e) => {
    const card = e.target.closest('.result-card');
    if (!card) return;
    const routeId = card.dataset.id;
    const route = _lastResults.find(r => r.id === routeId);
    if (route) showRouteDetail(route);
  });
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  restoreSearchState();
  // 等 Lucide 加载完成后再渲染图标
  if (window.lucide) {
    refreshIcons();
  } else {
    window.addEventListener('load', refreshIcons);
  }
});
