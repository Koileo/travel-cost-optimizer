// 07-ui.js — 界面渲染
// 出行成本优化器
const BADGE_META = {
  best: { label: '当前最优', icon: 'award' },
  fast: { label: '最快', icon: 'zap' },
  recommended: { label: '推荐', icon: 'thumbs-up' },
};

const CATEGORY_META = {
  transit: { label: '全程公交', icon: 'bus' },
  'transit-ride': { label: '公交 + 骑行', icon: 'bike' },
  taxi: { label: '全程打车', icon: 'car-taxi-front' },
  hybrid: { label: '混合', icon: 'shuffle' },
  walk: { label: '全程步行', icon: 'footprints' },
  ride: { label: '全程骑行', icon: 'bike' },
};

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}


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

function saveSearchInputsOnly() {
  try {
    const savedStartPOI = normalizeRoutePOI(startPOI);
    const savedEndPOI = normalizeRoutePOI(endPOI);
    if (!savedStartPOI || !savedEndPOI) return;
    localStorage.setItem(SAVED_SEARCH_KEY, JSON.stringify({
      startPOI: savedStartPOI,
      endPOI: savedEndPOI,
      allRoutes: [],
      sortMode,
      passengerCount,
      routeFetchedAt: 0,
      _savedAt: Date.now(),
    }));
  } catch (error) { /* quota exceeded, ignore */ }
}

function renderExpiredRouteState() {
  const resultsHint = document.querySelector('.results-hint');
  if (resultsHint) resultsHint.textContent = '等待重新查询';
  resultsList.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon"><i data-lucide="refresh-cw"></i></div>
      <p class="empty-title">路线数据已过期</p>
      <p class="empty-hint">打车价格和拥堵情况可能已变化，请重新查询</p>
      <button class="retry-btn" onclick="searchRoutes()">
        <i data-lucide="search"></i>
        <span>重新查询</span>
      </button>
    </div>
  `;
  refreshIcons();
}

function expireRouteResults() {
  if (isRouteResultFresh(routeDataFetchedAt)) {
    scheduleRouteExpiry(routeDataFetchedAt);
    return;
  }
  clearTimeout(_routeExpiryTimer);
  _routeExpiryTimer = null;
  allRoutes = [];
  _lastResults = [];
  routeDataFetchedAt = 0;
  if (modal && !modal.hidden) closeRouteDetail();
  else {
    clearRouteOverlays();
    if (map) updateMapMarkers();
  }
  renderExpiredRouteState();
  saveSearchInputsOnly();
}

function scheduleRouteExpiry(fetchedAt = routeDataFetchedAt) {
  clearTimeout(_routeExpiryTimer);
  _routeExpiryTimer = null;
  const timestamp = Number(fetchedAt);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return;
  const remaining = timestamp + ROUTE_RESULT_TTL_MS - Date.now();
  if (remaining <= 0) {
    expireRouteResults();
    return;
  }
  _routeExpiryTimer = setTimeout(expireRouteResults, remaining + 50);
}


function saveSearchState() {
  try {
    if (allRoutes.length > 0 && startPOI && endPOI) {
      // 高德坐标实例和轨迹先转成普通坐标，避免缓存恢复后丢失坐标方法。
      const toCoord = p => routeCoordinatePair(p) || p;
      const toLeg = leg => {
        if (!leg) return leg;
        return {
          ...leg,
          from: toCoord(leg.from),
          to: toCoord(leg.to),
          path: Array.isArray(leg.path) ? leg.path.map(toCoord) : leg.path,
        };
      };
      const toLocation = loc => {
        const pair = routeCoordinatePair(loc);
        return pair ? { lng: pair[0], lat: pair[1] } : loc;
      };
      const savedStartPOI = normalizeRoutePOI(startPOI);
      const savedEndPOI = normalizeRoutePOI(endPOI);
      if (!savedStartPOI || !savedEndPOI) return;
      if (!routeDataFetchedAt) routeDataFetchedAt = Date.now();
      // 页面内过期不能依赖 localStorage 写入成功。
      scheduleRouteExpiry(routeDataFetchedAt);

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
          if (raw.taxiLegs) slimRaw.taxiLegs = raw.taxiLegs.map(toLeg);       // hybrid 打车段
          if (raw.endpointLegs) slimRaw.endpointLegs = raw.endpointLegs.map(toLeg); // hybrid 端点
          if (raw.taxiCost != null) slimRaw.taxiCost = raw.taxiCost;
          if (raw.transitCost != null) slimRaw.transitCost = raw.transitCost;
          if (raw.trafficSpeedKmh != null) slimRaw.trafficSpeedKmh = raw.trafficSpeedKmh;
          if (raw.taxiDistance != null) slimRaw.taxiDistance = raw.taxiDistance;
          if (raw.station) {
            slimRaw.station = {
              ...raw.station,
              location: toLocation(raw.station.location),
            };
          }
        }
        rest.raw = Object.keys(slimRaw).length ? slimRaw : undefined;
        if (Array.isArray(rest.segments)) {
          rest.segments = rest.segments.map(s => { const { raw: sr, ...srest } = s || {}; return srest; });
        }
        return rest;
      });
      localStorage.setItem(SAVED_SEARCH_KEY, JSON.stringify({
        startPOI: savedStartPOI,
        endPOI: savedEndPOI,
        allRoutes: slimRoutes,
        sortMode,
        passengerCount,
        routeFetchedAt: routeDataFetchedAt,
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
    if (!saved || !saved.startPOI || !saved.endPOI) {
      return false;
    }
    // 高德路线插件不接受 JSON 恢复出的普通对象，需重新构造成 LngLat。
    const restoredStartPOI = normalizeRoutePOI(saved.startPOI, true);
    const restoredEndPOI = normalizeRoutePOI(saved.endPOI, true);
    if (!restoredStartPOI || !restoredEndPOI) return false;
    startPOI = restoredStartPOI;
    endPOI = restoredEndPOI;
    // 回填输入框显示上次选择的地点名
    if (startInput && startPOI) {
      startInput.value = startPOI.name || '';
      startInput.closest('.input-wrapper')?.classList.add('selected');
    }
    if (endInput && endPOI) {
      endInput.value = endPOI.name || '';
      endInput.closest('.input-wrapper')?.classList.add('selected');
    }
    sortMode = saved.sortMode || 'balanced';
    passengerCount = saved.passengerCount || 1;
    if (passengerCountEl) passengerCountEl.textContent = passengerCount;
    document.querySelectorAll('.mode-option').forEach(b => {
      const active = b.dataset.mode === sortMode;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (map) updateMapMarkers();

    if (!Array.isArray(saved.allRoutes) || saved.allRoutes.length === 0) return false;
    routeDataFetchedAt = Number(saved.routeFetchedAt ?? saved._savedAt) || 0;
    if (!isRouteResultFresh(routeDataFetchedAt)) {
      expireRouteResults();
      return false;
    }
    // 旧缓存也必须经过当前版本的可行性校验，避免恢复曾经保存的超长步行/骑行路线。
    allRoutes = filterPracticalRoutes(saved.allRoutes);
    if (allRoutes.length === 0) return false;
    // 缓存可能来自旧版评分模型，恢复时按当前规则重新计算，避免沿用过期顺序。
    sortRoutes(allRoutes, sortMode);
    allRoutes = optimizeRoutePortfolio(allRoutes);
    allRoutes.forEach(route => { route.badge = null; });
    if (allRoutes[0]) allRoutes[0].badge = 'best';
    renderResults(selectRoutesForDisplay(allRoutes));
    scheduleRouteExpiry(routeDataFetchedAt);
    return true;
  } catch (e) {
    return false;
  }
}


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
    if (!routes.some(route => countTaxiSegments(route) > 0)) return '';
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
        sourceClass = 'is-amap';
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
        ${route.insight ? `<div class="result-insight"><i data-lucide="lightbulb"></i><span>${route.insight}</span></div>` : ''}
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
  return routeCoordinatePair(loc) !== null;
}

// 从一个值中安全提取数字（NaN/undefined → fallback）
function safeNum(v, fallback = 0) {
  return typeof v === 'number' && !isNaN(v) ? v : fallback;
}

// 解析线路名，提取方向
// 例如 "1号线(苹果园-四惠东)" → { line: "1号线", fromStation: "苹果园", toStation: "四惠东", direction: "往 四惠东方向" }
// 例如 "10号线外环(车道沟-车道沟)" → { line: "10号线外环", direction: "外环方向" }（环线：起终点相同，单独处理）
// 例如 "1号线（苹果园开往四惠东）" → 同箭头格式

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
let _routeFitTimer = null;
let _routeMapResizeObserver = null;
const mapSection = document.querySelector('.map-section');

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

function closeRouteDetail() {
  modal.hidden = true;
  modal.style.display = 'none';
  clearRouteOverlays();
  restoreMapToPage();
}
