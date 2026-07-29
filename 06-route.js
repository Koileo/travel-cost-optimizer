// 06-route.js — split from app-client.js
// 出行成本优化器
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
  return new Promise((resolve) => {
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
        // 回退：直线距离 / 默认速度
        const dist = calculateDistance(from, to);
        resolve({ time: Math.round(dist / fallbackSpeedMps), distance: dist, speedMps: fallbackSpeedMps });
      });
    });
  });
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
    if (!taxiCheck.worthIt) {
      console.info(`[接驳打车] 跳过此段打车`);
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
    if (!isTaxiWorthIt(taxiDistance).worthIt) {
      console.info(`[打车+公交] 跳过`);
      return null;
    }

    const taxiTimeSec = driving.time;
    const taxiEst = await estimateTaxi(taxiDistance, taxiTimeSec, origin, c.onStation.location);
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
    if (!isTaxiWorthIt(firstTaxiDistance).worthIt || !isTaxiWorthIt(secondTaxiDistance).worthIt) {
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
  if (!isTaxiWorthIt(taxiDistance).worthIt) {
    console.info(`[公交+打车] 跳过`);
    return null;
  }

  // 时间：公交耗时按占比 + 打车耗时（实时路况）
  const transitTime = Math.round((plan.time || 0) / 60 * station.ratio);
  const taxiTime = Math.round(driving.time / 60);
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

