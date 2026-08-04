// 04-map.js — 地图与路线展示
// 出行成本优化器
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

// 高德不同路线插件返回的坐标格式并不完全一致：JS SDK 通常返回
// LngLat[]，缓存结果会变成 [lng, lat][]，部分 Web 服务结果则是
// "lng,lat;lng,lat"。地图绘制统一在这里做归一化，避免因为字段格式
// 差异退化成起终点直线。
function mapCoordinatePair(point) {
  if (Array.isArray(point) && point.length >= 2) {
    const lng = Number(point[0]), lat = Number(point[1]);
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
  }
  if (point && typeof point.getLng === 'function' && typeof point.getLat === 'function') {
    const lng = Number(point.getLng()), lat = Number(point.getLat());
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
  }
  const legacyLng = point?.lng ?? point?.KL;
  const legacyLat = point?.lat ?? point?.kT;
  if (point && Number.isFinite(Number(legacyLng)) && Number.isFinite(Number(legacyLat))) {
    return [Number(legacyLng), Number(legacyLat)];
  }
  return null;
}

function normalizeMapPath(value) {
  if (typeof value === 'string') {
    return value.split(';').map(pair => {
      const [lng, lat] = pair.split(',').map(Number);
      return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
    }).filter(Boolean);
  }
  return Array.isArray(value) ? value.map(mapCoordinatePair).filter(Boolean) : [];
}

function getSegmentMapPath(segment) {
  const transit = segment?.transit || {};
  const walking = segment?.walking || {};
  const directCandidates = [
    transit.path, transit.polyline,
    segment?.path, segment?.polyline,
    walking.path, walking.polyline,
  ];
  for (const candidate of directCandidates) {
    const path = normalizeMapPath(candidate);
    if (path.length >= 2) return path;
  }

  // 兼容旧版/代理结果：步行步骤的轨迹字段可能叫 path 或 polyline。
  const steps = Array.isArray(walking.steps) ? walking.steps : [];
  const stepPath = steps.flatMap(step => normalizeMapPath(step?.path || step?.polyline));
  return stepPath.length >= 2 ? stepPath : [];
}

function getRouteMapPath(route) {
  const directCandidates = [route?.path, route?.polyline];
  for (const candidate of directCandidates) {
    const path = normalizeMapPath(candidate);
    if (path.length >= 2) return path;
  }
  const steps = Array.isArray(route?.steps) ? route.steps : [];
  const stepPath = steps.flatMap(step => normalizeMapPath(step?.path || step?.polyline));
  return stepPath.length >= 2 ? stepPath : [];
}

// 徽章配置

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

  // 默认阈值：步行超过此分钟数 → 打车值得
  let thresholdMin = isFullTrip ? 12 : 10;

  // 恶劣天气降低阈值
  if (penalty.walkBonus >= 2.0)       thresholdMin = 4;  // 极寒/酷热/暴雨 → 走 4 分钟就打车
  else if (penalty.walkBonus >= 1.5)  thresholdMin = 6;  // 寒冷/炎热/大雨
  else if (penalty.walkBonus >= 0.5)  thresholdMin = 8;  // 偏冷/偏热/中雨

  const worthIt = effectiveWalkMin >= thresholdMin;

  if (!worthIt) {
    const reason = penalty.label ? `（${penalty.label}也不值得）` : '';
    console.info(`[打车判断] ${Math.round(distanceMeters)}m → 步行约 ${Math.round(effectiveWalkMin)} 分钟 < ${thresholdMin} 分钟阈值${reason}，打车不划算`);
  }

  return { worthIt, walkTimeMin: Math.round(effectiveWalkMin), reason: penalty.label, thresholdMin };
}


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

  // 坐标统一转换：支持 SDK LngLat、{lng,lat}（实时）和 [lng,lat]（缓存）
  const toXY = mapCoordinatePair;

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
        // 高德 Transfer 的精确轨迹位于 seg.transit.path（包括 WALK），
        // 兼容旧结果中的 walking.path / walking.steps[].path。
        const walkPath = getSegmentMapPath(seg);

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
      } else if (mode === 'SUBWAY' || mode === 'BUS' || mode === 'METRO_RAIL') {
        const transit = seg.transit || {};
        const colorMode = mode === 'METRO_RAIL' ? 'SUBWAY' : mode;
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

        // 公交/地铁线路：优先用高德真实轨迹，只有结果确实没有轨迹时才直线兜底。
        const transitPath = getSegmentMapPath(seg);
        if (transitPath.length >= 2) {
          addLine(transitPath, COLORS[colorMode], { weight: 5 });
        } else if (onLoc && offLoc) {
          addLine([onLoc, offLoc], COLORS[colorMode], { weight: 5 });
        }

        // 站点标记
        if (onLoc) {
          addStation(onLoc, transit.on_station.name || '上车', colorMode);
        }
        if (offLoc) {
          addStation(offLoc, transit.off_station.name || '下车', colorMode);
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
    const rawPath = getRouteMapPath(route.raw);
    if (rawPath.length >= 2) {
      addLine(rawPath, COLORS[mode], {
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
    const startPoint = startPOI && isValidLocation(startPOI.location)
      ? [startPOI.location.lng, startPOI.location.lat] : null;
    const endPoint = endPOI && isValidLocation(endPOI.location)
      ? [endPOI.location.lng, endPOI.location.lat] : null;

    const samePoint = (a, b) => a && b && Math.abs(a[0] - b[0]) < 0.00001 && Math.abs(a[1] - b[1]) < 0.00001;

    // 混合方案里的打车/步行/骑行段现在保留了规划返回的 path；旧缓存没有 path
    // 时仍保留 from/to 直线作为最后兜底。
    const drawEndpointLeg = leg => {
      const from = toXY(leg?.from);
      const to = toXY(leg?.to);
      if (!from || !to) return;
      const mode = String(leg.type || 'taxi').toUpperCase();
      const path = getRouteMapPath({ path: leg.path, polyline: leg.polyline, steps: leg.steps });
      const linePath = path.length >= 2 ? path : [from, to];
      addLine(linePath, COLORS[mode] || COLORS.WALK, {
        weight: mode === 'WALK' ? 3 : 5,
        dashed: mode === 'WALK',
        opacity: mode === 'WALK' ? 0.65 : 0.85,
        noOutline: mode === 'WALK',
      });
    };

    // 统一绘制高德 Transfer 原始段。关键是 WALK 也读取 segment.transit.path，
    // 否则起点到地铁站、换乘步行和终点接驳都会变成直线。
    const drawRawTransitSegments = (segments, initialPoint = null, finalPoint = null) => {
      let prev = initialPoint;
      (segments || []).forEach((seg, index, all) => {
        const mode = seg.transit_mode;
        const transit = seg.transit || {};
        const path = getSegmentMapPath(seg);

        if (mode === 'WALK') {
          const nextTransit = all[index + 1]?.transit;
          const nextLocation = nextTransit?.on_station?.location || transit.destination;
          const walkEnd = toXY(nextLocation) || finalPoint;
          if (path.length >= 2) {
            addLine(path, COLORS.WALK, { weight: 3, dashed: true, opacity: 0.65, noOutline: true });
            prev = path[path.length - 1];
          } else if (prev && walkEnd) {
            addLine([prev, walkEnd], COLORS.WALK, { weight: 3, dashed: true, opacity: 0.65, noOutline: true });
            prev = walkEnd;
          }
          return;
        }

        if (mode !== 'SUBWAY' && mode !== 'BUS' && mode !== 'METRO_RAIL') return;
        const onStation = transit.on_station;
        const offStation = transit.off_station;
        const onPoint = toXY(onStation?.location || transit.origin);
        const offPoint = toXY(offStation?.location || transit.destination);
        const linePath = path.length >= 2 ? path : (onPoint && offPoint ? [onPoint, offPoint] : []);
        if (linePath.length >= 2) {
          const colorMode = mode === 'METRO_RAIL' ? 'SUBWAY' : mode;
          addLine(linePath, COLORS[colorMode], { weight: 5 });
          prev = linePath[linePath.length - 1];
        }
        if (onPoint) addStation(onPoint, onStation?.name || '上车', mode === 'METRO_RAIL' ? 'SUBWAY' : mode);
        if (offPoint) addStation(offPoint, offStation?.name || '下车', mode === 'METRO_RAIL' ? 'SUBWAY' : mode);
        if (offPoint) prev = offPoint;
      });
      if (finalPoint && prev && !samePoint(prev, finalPoint)) {
        addLine([prev, finalPoint], COLORS.WALK, { weight: 3, dashed: true, opacity: 0.65, noOutline: true });
      }
    };

    if (route.raw) {
      (route.raw.endpointLegs || route.raw.taxiLegs || []).forEach(drawEndpointLeg);
      drawRawTransitSegments(rawSegs, route.direction === 'transit-to-taxi' ? startPoint : null, null);

      // 兼容旧缓存：当时没有保存 taxiLegs，按方案方向补画接驳段。
      if (!(route.raw.endpointLegs || route.raw.taxiLegs || []).length) {
        if (route.direction === 'taxi-to-transit' && startPoint) {
          const first = (rawSegs || []).find(seg => seg.transit_mode === 'SUBWAY' || seg.transit_mode === 'BUS');
          const target = toXY(first?.transit?.on_station?.location);
          if (target) drawEndpointLeg({ type: 'taxi', from: startPoint, to: target });
        } else if (route.direction === 'transit-to-taxi' && endPoint) {
          const station = toXY(route.raw.station?.location);
          if (station) drawEndpointLeg({ type: 'taxi', from: station, to: endPoint });
        }
      }
    }
  }

  // 自适应视野（只传有效 overlay）
  const validOverlays = _routeOverlays.filter(o => o && typeof o.setMap === 'function');
  if (validOverlays.length > 0) {
    map.setFitView(validOverlays, false, [60, 60, 60, 60]);
  }
}

// ─────────────────────────────────────────────────────

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

function refreshMapStyle() {
  if (!map) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  map.setMapStyle(isDark ? 'amap://styles/dark' : 'amap://styles/light');
}

// ===========================================================================
// 设置存储
// ===========================================================================

// 设置存储（localStorage）
const SETTINGS_KEY = 'travel-optimizer-settings';
const DEFAULT_SETTINGS = {
  city: '北京',
  didiEndpoint: 'https://api.udache.com/gulfstream/pre-sale/v1/core/pMultiEstimatePriceV3',
  didiHeaders: {},
  didiBody: {},
};
