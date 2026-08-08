// 06-route.js — 路线查询
// 出行成本优化器
async function searchRoutes() {
  if (!startPOI || !endPOI) {
    alert('请输入起点和终点');
    return;
  }

  // 滴滴报价短时缓存 3 分钟；在保证价格新鲜度的同时避免立即重复请求。

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
  clearTimeout(_routeExpiryTimer);
  _routeExpiryTimer = null;
  _drivingTimeCache.clear();
  _drivingFallbackWarningShown = false;
  beginDidiSearchBatch();

  try {
    // 各基础路网只查询一次；接驳方案复用公共交通主干。
    const [baseRouteResults, weatherData] = await Promise.all([
      settleRouteCreations([
        searchFullTaxi(),
        searchTransitPlans(),
        searchFullWalk(),
        searchFullRide(),
      ], '基础路线'),
      fetchWeather(appSettings.city || '北京'),
    ]);
    const taxiRoutes = Array.isArray(baseRouteResults[0]) ? baseRouteResults[0] : [];
    const transitResult = baseRouteResults[1]?.plans ? baseRouteResults[1] : null;
    const walkingRoutes = Array.isArray(baseRouteResults[2]) ? baseRouteResults[2] : [];
    const ridingRoutes = Array.isArray(baseRouteResults[3]) ? baseRouteResults[3] : [];
    // 高德 Transfer 并发过高会让额外定向规划返回 error；基础公交完成后再分批探索端点附近站。
    const endpointExpansion = await searchEndpointExpandedTransitPlans();
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
    // 端点附近地铁站是独立发现的，不依赖高德对“起点→终点”的默认公交骨架。
    // 各类混合方案只合并与自身方向匹配的扩展骨架，避免把未闭合路线当成全程公交。
    const transitToTaxiResult = mergeTransitPlanResults([
      transitResult,
      endpointExpansion.destinationResult,
    ], 28);
    const taxiToTransitResult = mergeTransitPlanResults([
      transitResult,
      endpointExpansion.originResult,
    ], 28);
    const taxiTransitTaxiResult = mergeTransitPlanResults([
      transitResult,
      endpointExpansion.originResult,
      endpointExpansion.destinationResult,
    ], 32);
    const [
      multimodalRoutes,
      busThenTaxiRoutes,
      taxiToTransitRoutes,
      taxiTransitTaxiRoutes,
    ] = (await settleRouteCreations([
      searchTransitCombinations(traffic, transitResult),
      searchBusThenTaxi(traffic, transitToTaxiResult, fullTaxiCost),
      searchTaxiToTransit(traffic, taxiToTransitResult, fullTaxiCost),
      searchTaxiTransitTaxi(traffic, taxiTransitTaxiResult, fullTaxiCost),
    ], '混合方案')).map(routes => Array.isArray(routes) ? routes : []);
    const hybridRoutes = dedupeHybridRoutes([
      ...multimodalRoutes,
      ...busThenTaxiRoutes,
      ...taxiToTransitRoutes,
      ...taxiTransitTaxiRoutes,
    ]);
    console.info('[路线候选]', {
      transit: transitRoutes.length,
      walk: walkingRoutes.length,
      ride: ridingRoutes.length,
      taxi: taxiRoutes.length,
      endpointCombinations: multimodalRoutes.length,
      transitToTaxi: busThenTaxiRoutes.length,
      taxiToTransit: taxiToTransitRoutes.length,
      taxiTransitTaxi: taxiTransitTaxiRoutes.length,
      hybridAfterDedupe: hybridRoutes.length,
    });
    allRoutes = filterPracticalRoutes([
      ...transitRoutes,
      ...walkingRoutes,
      ...ridingRoutes,
      ...taxiRoutes,
      ...hybridRoutes,
    ]).filter(route => countTaxiSegments(route) <= 2);
    routeDataFetchedAt = allRoutes.length > 0 ? Date.now() : 0;

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
    allRoutes = optimizeRoutePortfolio(allRoutes);

    // 给"当前模式最优"打上 best 徽章
    if (allRoutes.length > 0) {
      allRoutes[0].badge = 'best';
    }

    renderResults(selectRoutesForDisplay(allRoutes));
    saveSearchState();
  } catch (error) {
    console.error('查询失败:', error);
    allRoutes = [];
    _lastResults = [];
    routeDataFetchedAt = 0;
    saveSearchInputsOnly();
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

const ROUTE_RESULT_TTL_MS = globalThis.__ROUTE_TEST_RESULT_TTL_MS ?? 3 * 60 * 1000;

function isRouteResultFresh(fetchedAt, now = Date.now()) {
  const timestamp = Number(fetchedAt);
  const age = now - timestamp;
  return Number.isFinite(timestamp) && timestamp > 0 && age >= 0 && age < ROUTE_RESULT_TTL_MS;
}

// 检测打车路线中的拥堵路段。
// 超过 3.6 分钟/公里标记为拥堵，超过 5.4 分钟/公里标记为严重拥堵。
function detectTaxiCongestion(taxiRoute) {
  if (!taxiRoute?.raw || !Array.isArray(taxiRoute.raw.steps)) return null;

  let worstRatio = 0;
  let worstStep = null;
  taxiRoute.raw.steps.forEach(step => {
    const distance = Number(step.distance) || 0;
    const time = Number(step.time) || 0;
    if (distance < 800) return;

    const ratio = time / distance; // 秒/米，越大越拥堵
    if (ratio > worstRatio) {
      worstRatio = ratio;
      worstStep = step;
    }
  });

  if (worstRatio > 0.18) return { severity: 'heavy', ratio: worstRatio, step: worstStep };
  if (worstRatio > 0.12) return { severity: 'moderate', ratio: worstRatio, step: worstStep };
  return null;
}

// 从完整打车路线里提取「含实时路况」的平均车速（m/s）

function extractTrafficFactor(taxiRoute) {
  if (!taxiRoute || !taxiRoute.raw) return { speedMps: 8.3 }; // 默认 30 km/h 兜底
  const r = taxiRoute.raw;
  const distance = r.distance || 0; // 米
  const time = r.time || 0;        // 秒
  if (distance <= 0 || time <= 0) return { speedMps: 8.3 };
  return { speedMps: distance / time, distance, time };
}

// 针对单个打车段的实时驾车时间查询（含路况），用于混合方案中的每段打车
// 替代之前所有段共用一个 speedMps 的近似算法
async function getDrivingTime(from, to, fallbackSpeedMps = 8.3) {
  const pointKey = point => {
    const pair = routeCoordinatePair(point);
    return pair?.length === 2
      ? `${Number(pair[0]).toFixed(5)},${Number(pair[1]).toFixed(5)}`
      : '';
  };
  const cacheKey = `${pointKey(from)}>${pointKey(to)}`;
  if (_drivingTimeCache.has(cacheKey)) return _drivingTimeCache.get(cacheKey);

  const request = new Promise((resolve) => {
    let settled = false;
    const fallbackSpeed = Number.isFinite(fallbackSpeedMps) && fallbackSpeedMps > 0
      ? fallbackSpeedMps : 8.3;
    const fallback = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const fromPair = routeCoordinatePair(from);
      const toPair = routeCoordinatePair(to);
      const distance = fromPair && toPair ? calculateDistance(fromPair, toPair) : 0;
      if (reason && !_drivingFallbackWarningShown) {
        console.warn('[混合路线] 驾车规划不可用，相关候选改用直线估算:', reason);
        _drivingFallbackWarningShown = true;
      }
      resolve({
        time: distance > 0 ? Math.max(1, Math.round(distance / fallbackSpeed)) : 0,
        distance,
        speedMps: fallbackSpeed,
        path: fromPair && toPair ? [fromPair, toPair] : [],
      });
    };
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(
      () => fallback('请求超时'),
      globalThis.__ROUTE_DRIVING_TIMEOUT_MS ?? 8000
    );

    try {
      AMap.plugin('AMap.Driving', () => {
        try {
          const driving = new AMap.Driving({ panel: null });
          const origin = Array.isArray(from) ? new AMap.LngLat(from[0], from[1]) : from;
          const destination = Array.isArray(to) ? new AMap.LngLat(to[0], to[1]) : to;
          driving.search(origin, destination, (status, result) => {
            if (status === 'complete' && result?.routes?.length > 0) {
              const route = result.routes[0];
              const distance = Number(route.distance) || 0;
              const time = Number(route.time) || 0;
              if (distance > 0 && time > 0) {
                const path = Array.isArray(route.path) && route.path.length >= 2
                  ? route.path
                  : (Array.isArray(route.steps)
                    ? route.steps.flatMap(step => Array.isArray(step.path) ? step.path : [])
                    : []);
                finish({ time, distance, speedMps: distance / time, path });
                return;
              }
            }
            fallback(`状态 ${status || 'unknown'}`);
          });
        } catch (error) {
          fallback(error.message);
        }
      });
    } catch (error) {
      fallback(error.message);
    }
  });
  _drivingTimeCache.set(cacheKey, request);
  return request;
}

function routeCoordinatePair(point) {
  if (Array.isArray(point) && point.length >= 2) {
    const lng = Number(point[0]), lat = Number(point[1]);
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
  }
  if (point && typeof point.getLng === 'function' && typeof point.getLat === 'function') {
    const lng = Number(point.getLng()), lat = Number(point.getLat());
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
  }
  // 兼容旧缓存中 AMap.LngLat 序列化后的内部字段。
  const lng = Number(point?.lng ?? point?.KL);
  const lat = Number(point?.lat ?? point?.kT);
  return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
}

function normalizeRoutePOI(poi, rehydrate = false) {
  if (!poi) return null;
  const location = routeCoordinatePair(poi.location);
  if (!location) return null;
  const normalizedLocation = rehydrate && typeof globalThis.AMap?.LngLat === 'function'
    ? new globalThis.AMap.LngLat(location[0], location[1])
    : { lng: location[0], lat: location[1] };
  return {
    ...poi,
    location: normalizedLocation,
  };
}

const _drivingTimeCache = new Map();
let _drivingFallbackWarningShown = false;

// 路线来源彼此独立：某个 SDK 回调或单个混合候选失败时，保留其余已创建路线。
async function settleRouteCreations(promises, label = '路线') {
  const settled = await Promise.allSettled(promises);
  return settled.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    console.warn(`[${label}] 第 ${index + 1} 项创建失败，已跳过:`, result.reason);
    return null;
  });
}

function createRouteId(prefix, ...parts) {
  const safeParts = parts.map(part => encodeURIComponent(String(part ?? '')));
  return [prefix, ...safeParts].join('-');
}

function getTransitPlanSignature(plan) {
  return (plan?.segments || [])
    .filter(segment => segment.transit_mode === 'SUBWAY' || segment.transit_mode === 'BUS')
    .map(segment => {
      const transit = segment.transit || {};
      return [
        segment.transit_mode,
        transit.lines?.[0]?.name || '',
        transit.on_station?.name || '',
        transit.off_station?.name || '',
      ].join(':');
    })
    .join('|');
}

// 多策略结果按每个策略的名次交错合并，让“最快、最省、少走路、少换乘、舒适”都能提供骨架。
function mergeTransitPlanResults(results, limit = 16) {
  const validResults = results.filter(result => Array.isArray(result?.plans));
  const merged = [];
  const seen = new Set();
  const maxPlanCount = Math.max(0, ...validResults.map(result => result.plans.length));

  for (let planIndex = 0; planIndex < maxPlanCount && merged.length < limit; planIndex++) {
    for (const result of validResults) {
      const plan = result.plans[planIndex];
      if (!plan) continue;
      const signature = getTransitPlanSignature(plan);
      if (!signature || seen.has(signature)) continue;
      seen.add(signature);
      merged.push(plan);
      if (merged.length >= limit) break;
    }
  }

  if (!merged.length) return null;
  return { ...validResults[0], plans: merged };
}

const ENDPOINT_STATION_SEARCH_RADIUS_M = 6_000;
const ENDPOINT_STATION_LIMIT = 3;

function normalizeNearbyStationName(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/地铁站.*$/u, '')
    .replace(/[-－—·]?[A-H]?\d*号?(?:出)?口.*$/iu, '')
    .replace(/站$/u, '')
    .replace(/[-－—·]+$/u, '')
    .trim();
}

// PlaceSearch 经常把同一站的多个出入口分别返回。按站名合并，只保留离端点最近的入口，
// 再选取少量不同站点用于扩展公交骨架，控制额外规划请求数量。
function selectNearbyStationPOIs(
  pois,
  endpoint,
  limit = ENDPOINT_STATION_LIMIT,
  { minDistance = 450, maxDistance = ENDPOINT_STATION_SEARCH_RADIUS_M } = {}
) {
  const end = routeCoordinatePair(endpoint);
  if (!end || !Array.isArray(pois)) return [];
  const bestByStation = new Map();

  pois.forEach(poi => {
    const point = routeCoordinatePair(poi?.location);
    const stationName = normalizeNearbyStationName(poi?.name);
    if (!point || !stationName) return;
    const distance = calculateDistance(end, point);
    if (!Number.isFinite(distance) || distance < minDistance || distance > maxDistance) return;
    const candidate = {
      ...poi,
      name: poi.name || `${stationName}地铁站`,
      stationName,
      location: { lng: point[0], lat: point[1] },
      endpointDistance: distance,
    };
    const previous = bestByStation.get(stationName);
    if (!previous || distance < previous.endpointDistance) bestByStation.set(stationName, candidate);
  });

  return [...bestByStation.values()]
    .sort((a, b) => a.endpointDistance - b.endpointDistance || a.stationName.localeCompare(b.stationName, 'zh-CN'))
    .slice(0, limit);
}

function searchNearbySubwayStations(endpoint) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => finish([]), 6_000);

    try {
      AMap.plugin('AMap.PlaceSearch', () => {
        if (settled) return;
        try {
          const search = new AMap.PlaceSearch({
            city: appSettings.city || '北京',
            citylimit: true,
            type: '地铁站',
            pageSize: 20,
            pageIndex: 1,
            extensions: 'all',
          });
          search.searchNearBy('地铁站', endpoint, ENDPOINT_STATION_SEARCH_RADIUS_M, (status, result) => {
            const pois = status === 'complete' ? result?.poiList?.pois : [];
            finish(selectNearbyStationPOIs(pois, endpoint));
          });
        } catch (error) {
          console.warn('[端点扩展] 附近地铁站搜索失败:', error);
          finish([]);
        }
      });
    } catch (error) {
      console.warn('[端点扩展] 地铁站插件不可用:', error);
      finish([]);
    }
  });
}

function searchTransitToEndpointStation(from, to, side, target) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => finish(null), 8_000);

    try {
      const fromPair = routeCoordinatePair(from);
      const toPair = routeCoordinatePair(to);
      if (!fromPair || !toPair) return finish(null);
      const planner = new AMap.Transfer({
        city: appSettings.city || '北京',
        policy: AMap.TransferPolicy?.LEAST_TIME ?? 0,
        nightflag: true,
        panel: null,
      });
      planner.search(
        new AMap.LngLat(fromPair[0], fromPair[1]),
        new AMap.LngLat(toPair[0], toPair[1]),
        (status, result) => {
          if (status !== 'complete' || !result?.plans?.length) {
            console.info(
              `[端点扩展] ${side === 'origin' ? '起点侧' : '终点侧'}「${target.stationName || target.name}」` +
              `定向规划状态=${status || 'unknown'}`
            );
            return finish(null);
          }
          const plans = result.plans.slice(0, 2).map(plan => ({
            ...plan,
            _endpointExpansionSide: side,
            _endpointExpansionTarget: {
              name: target.stationName || target.name,
              location: target.location,
              endpointDistance: target.endpointDistance,
            },
          }));
          finish({ ...result, plans });
        }
      );
    } catch (error) {
      console.warn('[端点扩展] 定向公交规划失败:', error);
      finish(null);
    }
  });
}

// 额外探索端点周围的地铁站：
//   起点附近站 → 规划“该站到终点”，供“打车→地铁/公交”使用；
//   终点附近站 → 规划“起点到该站”，供“地铁/公交→打车”使用。
// 这些骨架不加入全程公交列表，只参与混合方案生成。
async function searchEndpointExpandedTransitPlans() {
  if (!isValidLocation(startPOI?.location) || !isValidLocation(endPOI?.location)) {
    return { originResult: null, destinationResult: null };
  }
  const origin = routeCoordinatePair(startPOI.location);
  const destination = routeCoordinatePair(endPOI.location);
  if (!origin || !destination || calculateDistance(origin, destination) < 2_500) {
    return { originResult: null, destinationResult: null };
  }

  const [originStations, destinationStations] = await Promise.all([
    searchNearbySubwayStations(startPOI.location),
    searchNearbySubwayStations(endPOI.location),
  ]);
  const tasks = [
    ...originStations.map(station => ({
      side: 'origin', station, from: station.location, to: endPOI.location,
    })),
    ...destinationStations.map(station => ({
      side: 'destination', station, from: startPOI.location, to: station.location,
    })),
  ];
  const completed = [];
  for (let index = 0; index < tasks.length; index += 2) {
    const batch = tasks.slice(index, index + 2);
    completed.push(...await Promise.all(batch.map(task =>
      searchTransitToEndpointStation(task.from, task.to, task.side, task.station)
    )));
  }
  const originSearches = completed.filter(result => result?.plans?.[0]?._endpointExpansionSide === 'origin');
  const destinationSearches = completed.filter(result => result?.plans?.[0]?._endpointExpansionSide === 'destination');

  const originResult = mergeTransitPlanResults(originSearches, 10);
  const destinationResult = mergeTransitPlanResults(destinationSearches, 10);
  console.info(
    `[端点扩展] 起点侧站=${originStations.map(station => station.stationName).join('/') || '无'}` +
    `（${originResult?.plans?.length || 0} 条骨架）；` +
    `终点侧站=${destinationStations.map(station => station.stationName).join('/') || '无'}` +
    `（${destinationResult?.plans?.length || 0} 条骨架）`
  );
  return { originResult, destinationResult };
}

async function searchTransitPlans() {
  const policy = AMap.TransferPolicy || {};
  const policies = [
    policy.LEAST_TIME ?? 0,
    policy.LEAST_FEE ?? 1,
    policy.LEAST_TRANSFER ?? 2,
    policy.LEAST_WALK ?? 3,
    policy.MOST_COMFORT ?? 4,
  ];
  const uniquePolicies = [...new Set(policies)];
  const searches = uniquePolicies.map(currentPolicy => new Promise(resolve => {
    try {
      const planner = new AMap.Transfer({
        city: appSettings.city || '北京',
        policy: currentPolicy,
        nightflag: true,
        panel: null,
      });
      planner.search(startPOI.location, endPOI.location, (status, result) => {
        resolve(status === 'complete' && result?.plans?.length ? result : null);
      });
    } catch (error) {
      console.warn(`[公交策略 ${currentPolicy}] 查询初始化失败:`, error);
      resolve(null);
    }
  }));
  return mergeTransitPlanResults(await Promise.all(searches));
}

// 类别 1：全程公交/地铁（地铁优先，同时保留少量纯公交方案）
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
  const upTo12 = result.plans.slice(0, 12);
  return [
    ...upTo12.filter(hasSubway),
    ...upTo12.filter(r => !hasSubway(r)).slice(0, 2),
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
              time: Math.round(withTaxiPickup(time) / 60),
              distance,
              segments: [{ type: 'taxi', distance, time: withTaxiPickup(time), lineName: `全程打车${carTypeLabel}` }],
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

// 接驳打车的路线时间必须包含叫车/上车缓冲；否则混合方案会系统性地显得过快。
const TAXI_PICKUP_SECONDS = 5 * 60;

function withTaxiPickup(seconds, taxiSegments = 1) {
  return seconds + TAXI_PICKUP_SECONDS * taxiSegments;
}

// 高德会给出许多途经站。先挑出具有代表性的站点，避免一次查询发起几十个实时估价。
function selectHybridStationCandidates(candidates, limit = 12, destination = null, speedMps = 8.3) {
  const ranked = candidates
    .filter(({ station }) => station.ratio >= 0.12 && (station.ratio <= 0.94 || station.endpointExpanded))
    .sort((a, b) => {
      const score = candidate => {
        const { station, plan } = candidate;
        const point = routeCoordinatePair(station.location);
        const end = routeCoordinatePair(destination);
        const remainingTransitSeconds = Math.max(0, (plan?.time || 0) - (station.prefixTime || 0));
        const taxiDistance = point && end ? calculateDistance(point, end) : 0;
        const estimatedTaxiSeconds = taxiDistance > 0
          ? taxiDistance / Math.max(3, speedMps) + TAXI_PICKUP_SECONDS
          : remainingTransitSeconds;
        // 先找真正能跳过慢段、节省时间的换乘点，再兼顾地铁稳定性与线路覆盖。
        const timeSavedMinutes = (remainingTransitSeconds - estimatedTaxiSeconds) / 60;
        const taxiBurden = taxiDistance / 1000 * 0.08;
        return -timeSavedMinutes * 0.18 + taxiBurden + Math.abs(station.ratio - 0.65) * 0.25 -
          (station.transitMode === 'SUBWAY' ? 0.12 : 0) -
          (station.endpointExpanded ? 0.55 : 0);
      };
      return score(a) - score(b);
    });
  const seenCorridors = new Set();
  const diverse = ranked.filter(candidate => {
    const corridor = getTransitPlanSignature(candidate.plan);
    if (!corridor || seenCorridors.has(corridor)) return false;
    seenCorridors.add(corridor);
    return true;
  });
  return [
    ...diverse,
    ...ranked.filter(candidate => !diverse.includes(candidate)),
  ].slice(0, limit);
}

function selectTaxiToTransitCandidates(result, origin, limit = 12, speedMps = 8.3) {
  const candidates = [];
  const seen = new Set();

  (result?.plans || []).forEach((plan, planIndex) => {
    const segments = plan.segments || [];
    const firstTransitIndex = segments.findIndex(segment =>
      segment.transit_mode === 'SUBWAY' || segment.transit_mode === 'BUS'
    );
    segments.forEach((segment, segmentIndex) => {
      if (segment.transit_mode !== 'SUBWAY' && segment.transit_mode !== 'BUS') return;
      const viaStops = Array.isArray(segment.transit?.via_stops) ? segment.transit.via_stops :
        (Array.isArray(segment.transit?.viaStops) ? segment.transit.viaStops : []);
      const boardingStops = [
        { station: segment.transit?.on_station, fraction: 0, viaIndex: -1 },
        ...viaStops.map((station, viaIndex) => ({
          station,
          fraction: (viaIndex + 1) / (viaStops.length + 1),
          viaIndex,
        })),
      ];

      boardingStops.forEach(({ station, fraction, viaIndex }) => {
        if (!station?.name || !isValidLocation(station.location)) return;
        const partialSegment = fraction === 0 ? segment : {
          ...segment,
          distance: (segment.distance || 0) * (1 - fraction),
          time: (segment.time || 0) * (1 - fraction),
          transit: {
            ...segment.transit,
            on_station: station,
            via_stops: viaStops.slice(viaIndex + 1),
          },
        };
        const remainingSegments = [partialSegment, ...segments.slice(segmentIndex + 1)];
        const remainingDistance = remainingSegments.reduce((sum, item) => sum + (item.distance || 0), 0);
        if (remainingDistance < 1200) return;
        const directDistance = calculateDistance(origin, [station.location.lng, station.location.lat]);
        if (directDistance < 450) return;

        const suffixSignature = getTransitPlanSignature({ segments: remainingSegments });
        const key = `${station.name}|${suffixSignature}`;
        if (seen.has(key)) return;
        seen.add(key);

        const previousDistance = segments
          .slice(0, segmentIndex)
          .reduce((sum, item) => sum + (item.distance || 0), 0);
        const previousTime = segments
          .slice(0, segmentIndex)
          .reduce((sum, item) => sum + (item.time || 0), 0);
        candidates.push({
          plan,
          planIndex,
          firstTransitIdx: segmentIndex,
          onStation: station,
          remainingSegments,
          directDistance,
          remainingDistance,
          replacedPrefixDistance: previousDistance + (segment.distance || 0) * fraction,
          replacedPrefixTime: previousTime + (segment.time || 0) * fraction,
          endpointExpanded: plan._endpointExpansionSide === 'origin' &&
            segmentIndex === firstTransitIndex && fraction === 0,
          isSubway: segment.transit_mode === 'SUBWAY',
          corridorKey: [
            segment.transit_mode,
            segment.transit?.lines?.[0]?.name || '',
            segment.transit?.off_station?.name || '',
          ].join(':'),
        });
      });
    });
  });

  const ranked = candidates.sort((a, b) => {
    const score = candidate => {
      const taxiSeconds = candidate.directDistance / Math.max(3, speedMps) + TAXI_PICKUP_SECONDS;
      const timeSavedMinutes = (candidate.replacedPrefixTime - taxiSeconds) / 60;
      return candidate.directDistance / 1000 * 0.12 -
        timeSavedMinutes * 0.2 -
        Math.min(candidate.remainingDistance, 12000) / 8000 -
        (candidate.isSubway ? 0.35 : 0) -
        (candidate.endpointExpanded ? 0.55 : 0);
    };
    return score(a) - score(b);
  });
  const seenCorridors = new Set();
  const diverse = ranked.filter(candidate => {
    if (seenCorridors.has(candidate.corridorKey)) return false;
    seenCorridors.add(candidate.corridorKey);
    return true;
  });
  return [
    ...diverse,
    ...ranked.filter(candidate => !diverse.includes(candidate)),
  ].slice(0, limit);
}

function isMeaningfulEndpointCombination(access, egress) {
  return access?.type !== 'walk' || egress?.type !== 'walk';
}

// “混合”在产品中专指含打车的方案；公交/地铁接驳骑行单独归为“公交 + 骑行”。
function getTransitConnectionCategory(access, egress) {
  const taxiSegments = (access?.taxiSegments || 0) + (egress?.taxiSegments || 0);
  return taxiSegments > 0 ? 'hybrid' : 'transit-ride';
}

// 同一组接驳站与线路可能由多个高德 plan 重复返回；只保留成本/时间更优的一条。
function dedupeHybridRoutes(routes) {
  const bestBySignature = new Map();
  for (const route of routes) {
    const signature = (route.segments || []).map(segment => {
      if (segment.type === 'taxi') return `taxi:${segment.fromStation || ''}>${segment.toStation || ''}`;
      if (segment.type === 'transit') return `transit:${segment.lineName || ''}:${segment.fromStation || ''}>${segment.toStation || ''}`;
      return segment.type || 'other';
    }).join('|');
    const previous = bestBySignature.get(signature);
    if (!previous || route.cost < previous.cost || (route.cost === previous.cost && route.time < previous.time)) {
      bestBySignature.set(signature, route);
    }
  }
  return [...bestBySignature.values()];
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
    if (!taxiCheck.worthIt) {
      console.info(`[接驳打车] 跳过此段打车`);
    } else {
      const drivingTime = driving.time;
      const estimate = await estimateTaxi(taxiDistance, drivingTime, from, to, { fromName, toName });
      const carTypeSuffix = estimate.carType ? ` · ${estimate.carType}` : '';
      // 每一段独立估价，Didi 或本地兜底都会为这一段单独计算起步价。
      variants.push({
        type: 'taxi', icon: '🚕', label: `打车${carTypeSuffix}`, distance: taxiDistance,
        time: withTaxiPickup(drivingTime), cost: estimate.cost, taxiCost: estimate.cost,
        taxiSegments: 1, dataSource: estimate.source,
        answerRate: estimate.answerRate, didiDurationMinutes: estimate.didiDurationMinutes,
        segment: { type: 'taxi', distance: taxiDistance, time: withTaxiPickup(drivingTime), fromStation: fromName, toStation: toName },
        mapLeg: { type: 'taxi', from, to, path: driving.path },
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

  const planRoutes = await settleRouteCreations(result.plans.slice(0, 10).map(async (plan, planIndex) => {
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
    if (middleDistance < 600) return [];

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
        // walk+walk 就是高德原始公交方案；骑行接驳和打车接驳分别独立展示。
        if (!isMeaningfulEndpointCombination(access, egress)) return;
        const taxiSegments = access.taxiSegments + egress.taxiSegments;
        if (taxiSegments > 2) return;
        const category = getTransitConnectionCategory(access, egress);

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
          id: createRouteId('multimodal', planIndex, access.type, egress.type),
          category, type: 'hybrid', direction: 'multimodal',
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
  }), '公交两端接驳候选');

  return dedupeHybridRoutes(planRoutes.filter(Array.isArray).flat());
}

async function searchBusThenTaxi(traffic = { speedMps: 8.3 }, result = null, fullTaxiTotal = null) {
  if (!isValidLocation(startPOI && startPOI.location) || !isValidLocation(endPOI && endPOI.location)) {
    return [];
  }
  if (!result) return [];

  // 从多策略公交骨架中收集真实的公交/地铁下车站。
  const candidates = [];
  const seen = new Set();
  result.plans.slice(0, 12).forEach((plan, planIndex) => {
    collectTransferStations(plan, {
      includeTerminal: plan._endpointExpansionSide === 'destination',
    }).forEach(s => {
      const prefixSignature = getTransitPlanSignature({
        segments: (plan.segments || []).slice(0, s.segmentIndex + 1),
      });
      const key = `${s.name}|${prefixSignature}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push({ plan, planIndex, station: s });
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
  const selectedCandidates = selectHybridStationCandidates(
    candidates,
    12,
    endLngLat,
    traffic.speedMps || 8.3
  );
  const hybrids = (await settleRouteCreations(
    selectedCandidates.map(c => buildHybridFromStation(
      c.plan, c.station, endLngLat, traffic, c.planIndex
    )),
    '公交转打车候选'
  ))
    .filter(Boolean)
    .filter(h => isFinite(h.cost) && h.cost <= getHybridCostCeiling(fullTaxiCost))
    .sort((a, b) => a.cost - b.cost)
    .slice(0, 12);

  console.log(`[hybrid] candidates=${candidates.length}, selected=${selectedCandidates.length}, taxiThreshold=${fullTaxiCost.toFixed(2)}, kept=${hybrids.length}`);

  return hybrids;
}

// 类别 4：打车→公交主干，可直接接入首站、后续换乘站或线路途经站。
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

  // 不只看首个上车站，也允许打车跳过慢公交/绕路换乘，直接接入后续地铁或公交主干。
  const candidates = selectTaxiToTransitCandidates(result, origin, 12, speedMps);

  // 异步估算每个候选的 taxi 价格（每段独立 Driving.search，不用统一的 speedMps）
  const builtHybrids = await settleRouteCreations(candidates.map(async c => {
    const stationLngLat = [c.onStation.location.lng, c.onStation.location.lat];

    const driving = await getDrivingTime(origin, stationLngLat, speedMps);
    const taxiDistance = driving.distance;
    if (!isFinite(taxiDistance) || taxiDistance <= 0) return null;

    // 综合步行时间+天气判断打车是否值得
    const isExpandedAccess = c.endpointExpanded && taxiDistance >= 450;
    if (!isTaxiWorthIt(taxiDistance).worthIt && !isExpandedAccess && c.replacedPrefixTime < 15 * 60) {
      console.info(`[打车+公交] 跳过`);
      return null;
    }

    const taxiTimeSec = driving.time;
    const taxiEst = await estimateTaxi(taxiDistance, taxiTimeSec, origin, c.onStation.location);
    const taxiCost = taxiEst.cost;
    if (!isFinite(taxiCost)) return null;

    // 时间：打车 + 剩余的公交时间（包含后续所有段）
    const taxiTime = Math.round(withTaxiPickup(taxiTimeSec) / 60);
    const remainingTransitTime = Math.round(
      c.remainingSegments.reduce((sum, s) => sum + (s.time || 0), 0) / 60
    );
    const totalTime = taxiTime + remainingTransitTime;

    const remainingShare = c.remainingDistance / Math.max(c.plan.distance || c.remainingDistance, 1);
    const transitCost = Math.max(2, (c.plan.cost || 2) * remainingShare);
    const totalCost = taxiCost + transitCost;

    // 只过滤明显缺乏价格竞争力的异常候选，合理溢价交给综合排序判断。
    if (!isFinite(totalCost) || totalCost > getHybridCostCeiling(fullTaxiCost)) return null;

    // 拆出所有 remaining 段（transit + walk），每段单独显示
    const remainingSegs = c.remainingSegments;
    const remainingDistance = remainingSegs.reduce((sum, segment) => sum + (segment.distance || 0), 0);
    const carTypeLabel = taxiEst.carType ? ` · ${taxiEst.carType}` : '';
    const detailSegments = [{
      type: 'taxi', distance: taxiDistance, time: withTaxiPickup(taxiTimeSec), lineName: `打车${carTypeLabel}到 ${c.onStation.name}`,
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
          transitMode: s.transit_mode,
          distance: s.distance || 0,
          time: s.time || 0,
          lineName: info.direction ? `${info.line} · ${info.direction}` : info.line,
          fromStation: onName, toStation: offName,
        });
        descParts.push(isSubway ? `🚇 ${info.line}` : `🚌 ${info.line}`);
      }
    });

    const taxiKm = Math.round(taxiDistance / 100) / 10;
    const desc = `🚕 打车${carTypeLabel} ${taxiKm} km 到 ${c.onStation.name} → ${descParts.join(' → ')}`;

    return {
      id: createRouteId(
        'taxi-to-transit',
        c.planIndex,
        c.firstTransitIdx,
        c.onStation.name,
        c.onStation.location.lng,
        c.onStation.location.lat
      ),
      category: 'hybrid',
      type: 'hybrid',
      direction: 'taxi-to-transit',
      endpointExpanded: c.endpointExpanded,
      cost: Math.round(totalCost * 100) / 100,
      time: totalTime,
      // 原 plan.distance 包含已被打车替代的起点步行段，这里只计剩余公交链路。
      distance: taxiDistance + remainingDistance,
      segments: detailSegments,
      description: desc,
      dataSource: taxiEst.source,
      answerRate: taxiEst.answerRate,
      didiDurationMinutes: taxiEst.didiDurationMinutes,
      raw: {
        stationName: c.onStation.name,
        segments: remainingSegs, // AMap 原始段，给地图绘制用
        taxiLegs: [{ from: origin, to: stationLngLat, path: driving.path, type: 'taxi' }],
        taxiDistance,
        taxiCost,
        transitCost,
        trafficSpeedKmh: Math.round(driving.speedMps * 3.6),
      },
    };
  }), '打车转公交候选');

  return builtHybrids
    .filter(Boolean)
    .sort((a, b) => a.cost - b.cost)
    .slice(0, 6);
}


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

  const candidates = result.plans.slice(0, 8).map((plan, planIndex) => {
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
    const expansionSide = plan._endpointExpansionSide;
    const expandedDistance = Number(plan._endpointExpansionTarget?.endpointDistance) || 0;
    const effectiveInitialAccess = expansionSide === 'origin' ? expandedDistance : initialWalk;
    const effectiveFinalAccess = expansionSide === 'destination' ? expandedDistance : finalWalk;
    if (effectiveInitialAccess < 350 || effectiveFinalAccess < 350 || middleDistance < 2000) return null;

    return {
      plan, planIndex, segments, firstIndex, lastIndex, entry, exit,
      initialWalk,
      finalWalk,
      accessWalk: effectiveInitialAccess + effectiveFinalAccess,
      endpointExpanded: !!expansionSide,
    };
  })
    .filter(Boolean)
    .sort((a, b) => b.accessWalk - a.accessWalk)
    .slice(0, 5);

  const routes = await settleRouteCreations(candidates.map(async candidate => {
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
    const firstLegWorthIt = isTaxiWorthIt(firstTaxiDistance).worthIt || candidate.initialWalk >= 600;
    const secondLegWorthIt = isTaxiWorthIt(secondTaxiDistance).worthIt || candidate.finalWalk >= 600;
    if (!firstLegWorthIt || !secondLegWorthIt) {
      console.info(`[打车+公交+打车] 有一段不划算，跳过`);
      return null;
    }

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

    const taxiCost = firstEstimate.cost + secondEstimate.cost;
    const transitCost = candidate.plan.cost || 2;
    const totalCost = taxiCost + transitCost;
    if (!Number.isFinite(totalCost) || totalCost > getHybridCostCeiling(taxiCeiling)) return null;

    const car1 = firstEstimate.carType ? ` · ${firstEstimate.carType}` : '';
    const car2 = secondEstimate.carType ? ` · ${secondEstimate.carType}` : '';

    const middleRawSegments = candidate.segments.slice(candidate.firstIndex, candidate.lastIndex + 1);
    const middleTimeSeconds = middleRawSegments.reduce((sum, seg) => sum + (seg.time || 0), 0);
    const detailSegments = [{
      type: 'taxi',
      distance: firstTaxiDistance,
      time: withTaxiPickup(firstTaxiSeconds),
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
        transitMode: seg.transit_mode,
        distance: seg.distance || 0,
        time: seg.time || 0,
        lineName: info.direction ? `${info.line} · ${info.direction}` : info.line,
        fromStation: seg.transit?.on_station?.name || '上车',
        toStation: seg.transit?.off_station?.name || '下车',
      });
    });

    detailSegments.push({
      type: 'taxi',
      distance: secondTaxiDistance,
      time: withTaxiPickup(secondTaxiSeconds),
      lineName: `打车${car2}到 ${endPOI.name}`,
      fromStation: candidate.exit.name,
      toStation: endPOI.name,
    });

    const transitLabels = detailSegments
      .filter(seg => seg.type === 'transit')
      .map(seg => `${seg.mode === 'SUBWAY' ? '🚇' : '🚌'} ${parseLineInfo(seg.lineName, seg.mode).line}`);
    const dataSource = firstEstimate.source === 'didi' && secondEstimate.source === 'didi' ? 'didi' : 'local';

    return {
      id: createRouteId('taxi-transit-taxi', candidate.planIndex, candidate.entry.name, candidate.exit.name),
      category: 'hybrid',
      type: 'hybrid',
      direction: 'taxi-transit-taxi',
      endpointExpanded: candidate.endpointExpanded,
      cost: Math.round(totalCost * 100) / 100,
      time: Math.max(1, Math.round(withTaxiPickup(firstTaxiSeconds + middleTimeSeconds + secondTaxiSeconds, 2) / 60)),
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
          { from: origin, to: entryPoint, path: driving1.path, type: 'taxi' },
          { from: exitPoint, to: destination, path: driving2.path, type: 'taxi' },
        ],
        trafficSpeedKmh: Math.round(Math.min(driving1.speedMps, driving2.speedMps) * 3.6),
      },
    };
  }), '打车公交打车候选');

  return routes.filter(Boolean).sort((a, b) => getDisplayCost(a) - getDisplayCost(b)).slice(0, 6);
}

// 混合方案不必严格低于全程打车：略贵一些但显著减少步行时仍有参考价值。
function getHybridCostCeiling(fullTaxiCost) {
  return fullTaxiCost + Math.max(12, fullTaxiCost * 0.3);
}

// 检测打车路线中的拥堵路段
// 阈值：> 3.6 min/km (≈17 km/h) 算中等拥堵；> 5.4 min/km (≈11 km/h) 算严重拥堵

function collectTransferStations(plan, { includeTerminal = false } = {}) {
  const segments = plan.segments || [];
  const totalDistance = plan.distance || 1;
  if (totalDistance <= 0) return [];
  const stations = [];
  const lastTransitIndex = segments.reduce(
    (last, segment, index) =>
      segment.transit_mode === 'SUBWAY' || segment.transit_mode === 'BUS' ? index : last,
    -1
  );

  let acc = 0;
  let elapsedTime = 0;
  segments.forEach((seg, idx) => {
    const segStart = acc;
    const segStartTime = elapsedTime;
    const segEnd = acc + (seg.distance || 0);
    acc = segEnd;
    elapsedTime += seg.time || 0;

    if (seg.transit_mode !== 'SUBWAY' && seg.transit_mode !== 'BUS') return;
    if (!seg.transit || (seg.distance || 0) < 100) return;

    const lineName = (seg.transit.lines && seg.transit.lines[0] && seg.transit.lines[0].name) ||
      (seg.transit_mode === 'SUBWAY' ? '地铁' : '公交');
    const seenInSegment = new Set();
    const addStation = (stop, fraction, source, viaIndex = -1) => {
      if (!stop?.name || !isValidLocation(stop.location)) return;
      const normalizedFraction = Math.max(0, Math.min(1, fraction));
      const ratio = (segStart + (seg.distance || 0) * normalizedFraction) / totalDistance;
      const endpointExpanded = includeTerminal && source === 'off' && idx === lastTransitIndex;
      if (!isFinite(ratio) || ratio <= 0.04 || (ratio >= 0.97 && !endpointExpanded)) return;
      const key = `${stop.name}|${Math.round(normalizedFraction * 1000)}`;
      if (seenInSegment.has(key)) return;
      seenInSegment.add(key);
      stations.push({
        name: stop.name,
        location: stop.location,
        segmentIndex: idx,
        segmentFraction: normalizedFraction,
        prefixDistance: segStart + (seg.distance || 0) * normalizedFraction,
        prefixTime: segStartTime + (seg.time || 0) * normalizedFraction,
        ratio,
        lineName,
        transitMode: seg.transit_mode,
        segmentDistance: seg.distance || 0,
        source,
        viaIndex,
        endpointExpanded,
      });
    };

    // via_stops 是 SDK 返回的线路途经站；此前只使用 off_station，遗漏了大多数可接驳点。
    const viaStops = Array.isArray(seg.transit.via_stops) ? seg.transit.via_stops :
      (Array.isArray(seg.transit.viaStops) ? seg.transit.viaStops : []);
    viaStops.forEach((stop, viaIndex) => addStation(
      stop,
      (viaIndex + 1) / (viaStops.length + 1),
      'via',
      viaIndex
    ));
    addStation(seg.transit.off_station, 1, 'off');
  });

  return stations;
}

function createTransitPrefixSegments(plan, station) {
  const prefixSegments = [];
  const segments = plan?.segments || [];

  for (let index = 0; index <= station.segmentIndex; index++) {
    const segment = segments[index];
    if (!segment) continue;
    const fraction = index === station.segmentIndex ? (station.segmentFraction ?? 1) : 1;

    if (segment.transit_mode === 'WALK') {
      prefixSegments.push({
        type: 'walk',
        distance: (segment.distance || 0) * fraction,
        time: (segment.time || 0) * fraction,
      });
      continue;
    }
    if (segment.transit_mode !== 'SUBWAY' && segment.transit_mode !== 'BUS') continue;

    const lines = segment.transit?.lines || [];
    prefixSegments.push({
      type: 'transit',
      mode: segment.transit_mode,
      transitMode: segment.transit_mode,
      lineName: lines[0]?.name || (segment.transit_mode === 'SUBWAY' ? '地铁' : '公交'),
      price: 0,
      distance: (segment.distance || 0) * fraction,
      time: (segment.time || 0) * fraction,
      fromStation: segment.transit?.on_station?.name || '',
      toStation: index === station.segmentIndex && fraction < 1
        ? station.name
        : (segment.transit?.off_station?.name || ''),
    });
  }
  return prefixSegments;
}

// 公交转打车若发生在线路途经站，原始公交轨迹也必须截断到该站；
// 否则详情地图会继续画到线路终点，再折返到打车起点。
function createTransitPrefixRawSegments(plan, station) {
  const fraction = Math.max(0, Math.min(1, station.segmentFraction ?? 1));
  const targetPoint = routeCoordinatePair(station.location);
  const prefix = (plan?.segments || []).slice(0, station.segmentIndex + 1);

  return prefix.map((segment, index) => {
    if (index !== station.segmentIndex || fraction >= 1 || !segment?.transit) return segment;

    const transit = { ...segment.transit };
    transit.off_station = {
      ...(transit.off_station || {}),
      name: station.name,
      location: station.location,
    };
    transit.destination = station.location;

    if (station.source === 'via' && station.viaIndex >= 0) {
      if (Array.isArray(transit.via_stops)) {
        transit.via_stops = transit.via_stops.slice(0, station.viaIndex);
      }
      if (Array.isArray(transit.viaStops)) {
        transit.viaStops = transit.viaStops.slice(0, station.viaIndex);
      }
    }

    const truncatePath = value => {
      const path = typeof value === 'string'
        ? value.split(';').map(pair => pair.split(',').map(Number))
        : value;
      if (!Array.isArray(path) || path.length < 2 || !targetPoint) return value;

      let nearestIndex = Math.max(1, Math.round((path.length - 1) * fraction));
      let nearestDistance = Infinity;
      path.forEach((point, pathIndex) => {
        const pair = routeCoordinatePair(point);
        if (!pair) return;
        const distance = (pair[0] - targetPoint[0]) ** 2 + (pair[1] - targetPoint[1]) ** 2;
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = pathIndex;
        }
      });

      const truncated = path.slice(0, Math.max(1, nearestIndex) + 1);
      const lastPoint = routeCoordinatePair(truncated[truncated.length - 1]);
      if (!lastPoint || Math.abs(lastPoint[0] - targetPoint[0]) > 1e-7 ||
          Math.abs(lastPoint[1] - targetPoint[1]) > 1e-7) {
        truncated.push(station.location);
      }
      return truncated;
    };

    if (transit.path != null) transit.path = truncatePath(transit.path);
    if (transit.polyline != null) transit.polyline = truncatePath(transit.polyline);
    return {
      ...segment,
      distance: (segment.distance || 0) * fraction,
      time: (segment.time || 0) * fraction,
      transit,
    };
  });
}

// 用指定换乘站构建一个混合方案
// traffic.speedMps —— 来自完整打车路线的「含实时路况」平均车速（m/s）
async function buildHybridFromStation(
  plan,
  station,
  endLngLat,
  traffic = { speedMps: 8.3 },
  planIndex = 0
) {
  // 严格校验 station.location
  if (!isValidLocation(station.location)) return null;

  // 公交费用：用 AMap plan.cost 按距离比例折算（lines[0].price 在 JS SDK 中不可靠）
  const transitCost = Math.max((plan.cost || 0) * station.ratio, 2);
  const prefixSegments = createTransitPrefixSegments(plan, station);

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
  const isExpandedEgress = station.endpointExpanded && taxiDistance >= 450;
  if (!isTaxiWorthIt(taxiDistance).worthIt && !isExpandedEgress) {
    console.info(`[公交+打车] 跳过`);
    return null;
  }

  // 时间：公交耗时按占比 + 打车耗时（实时路况）
  const transitTime = Math.round((station.prefixTime ?? (plan.time || 0) * station.ratio) / 60);
  const taxiTime = Math.round(withTaxiPickup(driving.time) / 60);
  const totalTime = transitTime + taxiTime;
  if (!isFinite(totalTime) || totalTime <= 0) return null;

  // 异步调用滴滴拿真实价格
  const taxiEst = await estimateTaxi(taxiDistance, driving.time, station.location, endPOI.location);
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
    id: createRouteId(
      'hybrid',
      planIndex,
      station.segmentIndex,
      station.name,
      station.location.lng,
      station.location.lat
    ),
    category: 'hybrid',
    type: 'hybrid',
    direction: 'transit-to-taxi',
    endpointExpanded: station.endpointExpanded,
    cost: Math.round(totalCost * 100) / 100,
    time: totalTime,
    distance: (station.prefixDistance ?? (plan.distance || 0) * station.ratio) + taxiDistance,
    segments: [
      ...prefixSegments,
      { type: 'taxi', distance: taxiDistance, time: withTaxiPickup(driving.time), lineName: `打车${carTypeSuffix}到 ${endPOI ? endPOI.name : '目的地'}`,
        fromStation: station.name, toStation: endPOI ? endPOI.name : '目的地' },
    ],
    description: `${station.transitMode === 'SUBWAY' ? '🚇' : '🚌'} ${stationDisplay} 到 ${station.name} → 🚕 打车${carTypeSuffix} ${taxiDistanceKm} km`,
    dataSource: taxiEst.source,
    answerRate: taxiEst.answerRate,
    didiDurationMinutes: taxiEst.didiDurationMinutes,
    raw: {
      station,
      // 保留高德原始公交段，地图才能按真实轨迹绘制公交/步行部分。
      segments: createTransitPrefixRawSegments(plan, station),
      taxiLegs: [{
        from: [station.location.lng, station.location.lat],
        to: endLngLat,
        path: driving.path,
        type: 'taxi',
      }],
      taxiDistance, taxiCost, transitCost, trafficSpeedKmh: speedKmh,
    },
  };
}
