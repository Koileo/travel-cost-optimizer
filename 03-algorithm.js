// 03-algorithm.js — 路线算法
// 出行成本优化器
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

function assignParetoRanks(routes) {
  const metrics = routes.map(route => ({
    cost: toRouteMetric(getDisplayCost(route)),
    time: toRouteMetric(route.time, { positive: true }),
    comfort: toRouteMetric(getComfortCost(route)),
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

function toRouteMetric(value, { positive = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (positive && number <= 0)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return number;
}

// 将“比当前最优多出来的损失”映射到 0~1。
// 与 min-max 不同，这个分数不会因为多出一条极端候选路线而整体漂移。
function normalizeRouteRegret(value, best, scale) {
  if (!Number.isFinite(value) || value === Number.MAX_SAFE_INTEGER) return 1;
  const regret = Math.max(0, value - best);
  return 1 - Math.exp(-regret / Math.max(1, scale));
}

function getRouteReliabilityPenalty(route) {
  if (countTaxiSegments(route) === 0) return 0;

  let penalty = route.dataSource && route.dataSource !== 'didi' ? 0.035 : 0;
  const answerRate = Number(route.answerRate);
  if (Number.isFinite(answerRate) && answerRate < 80) {
    penalty += Math.min(0.12, (80 - answerRate) / 250);
  }
  return penalty;
}

const ROUTE_MODE_WEIGHTS = {
  cheapest: { cost: 0.68, time: 0.18, comfort: 0.14 },
  fastest: { cost: 0.16, time: 0.69, comfort: 0.15 },
  comfortable: { cost: 0.17, time: 0.18, comfort: 0.65 },
  balanced: { cost: 0.36, time: 0.34, comfort: 0.3 },
};

// 三目标排序：按相对最优方案的“后悔值”计算，Pareto 层级和叫车可靠性用于校正。
function sortRoutes(routes, mode = 'balanced') {
  if (!routes || routes.length <= 1) return;

  assignParetoRanks(routes);

  const costs = routes.map(r => toRouteMetric(getDisplayCost(r)));
  const times = routes.map(r => toRouteMetric(r.time, { positive: true }));
  const comforts = routes.map(r => toRouteMetric(getComfortCost(r)));
  const minCost = Math.min(...costs);
  const minTime = Math.min(...times);
  const minComfort = Math.min(...comforts);
  const weights = ROUTE_MODE_WEIGHTS[mode] || ROUTE_MODE_WEIGHTS.balanced;

  const indexed = routes.map((route, index) => {
    const costRegret = normalizeRouteRegret(costs[index], minCost, Math.max(12, minCost * 0.55));
    const timeRegret = normalizeRouteRegret(times[index], minTime, Math.max(18, minTime * 0.5));
    const comfortRegret = normalizeRouteRegret(comforts[index], minComfort, Math.max(12, minComfort * 0.5));
    const paretoPenalty = Math.min(route.paretoRank || 0, 3) * 0.09;
    const reliabilityPenalty = getRouteReliabilityPenalty(route);
    const score =
      costRegret * weights.cost +
      timeRegret * weights.time +
      comfortRegret * weights.comfort +
      paretoPenalty +
      reliabilityPenalty;

    route.routeScore = Math.round(score * 10000) / 10000;
    route.scoreBreakdown = {
      cost: Math.round(costRegret * 1000) / 1000,
      time: Math.round(timeRegret * 1000) / 1000,
      comfort: Math.round(comfortRegret * 1000) / 1000,
      reliability: Math.round(reliabilityPenalty * 1000) / 1000,
    };
    return { route, score, originalIndex: index };
  });

  // 明确的逐级决胜规则让相同分数在刷新、人数变化后仍保持稳定。
  indexed.sort((a, b) =>
    a.score - b.score ||
    (a.route.paretoRank || 0) - (b.route.paretoRank || 0) ||
    times[a.originalIndex] - times[b.originalIndex] ||
    costs[a.originalIndex] - costs[b.originalIndex] ||
    String(a.route.id || '').localeCompare(String(b.route.id || ''), 'zh-CN')
  );
  routes.length = 0;
  routes.push(...indexed.map(item => item.route));
}

function isCompetitiveDisplayRoute(route, bestScore) {
  const score = Number(route?.routeScore);
  if (!Number.isFinite(score) || !Number.isFinite(bestScore)) return true;
  // 允许不同取舍的方案进入列表，但不为明显劣于首选的方案强行补位。
  return score <= bestScore + 0.78 && (route.paretoRank || 0) <= 4;
}

// 在保持全局排名的前提下，为“有竞争力”的混合方案保留展示席位。
function selectRoutesForDisplay(routes, limit = 18) {
  if (!Array.isArray(routes) || limit <= 0) return [];
  const rankedRoutes = routes.slice();
  const rankByRoute = new Map(rankedRoutes.map((route, index) => [route, index]));
  const selected = rankedRoutes.slice(0, limit);
  const bestScore = Number(rankedRoutes[0]?.routeScore);
  const competitiveHybrids = rankedRoutes.filter(route =>
    route.category === 'hybrid' && isCompetitiveDisplayRoute(route, bestScore)
  );
  const patternOf = route => {
    const modes = (route.segments || [])
      .map(segment => getSegmentMode(segment))
      .filter((mode, index, allModes) => index === 0 || mode !== allModes[index - 1])
      .join('-');
    return `${route.direction || 'hybrid'}:${modes}`;
  };
  const seenPatterns = new Set();
  const diverseHybrids = competitiveHybrids.filter(route => {
    const pattern = patternOf(route);
    if (seenPatterns.has(pattern)) return false;
    seenPatterns.add(pattern);
    return true;
  });
  const hybridRoutes = [
    ...diverseHybrids,
    ...competitiveHybrids.filter(route => !diverseHybrids.includes(route)),
  ];
  // 产品核心是混合方案，最多展示 14 条，同时为基础出行方式保留至少三个席位。
  const targetHybridCount = Math.min(14, hybridRoutes.length, Math.max(0, limit - 3));
  let currentHybridCount = selected.filter(route => route.category === 'hybrid').length;
  if (currentHybridCount >= targetHybridCount) return selected;

  const selectedRoutes = new Set(selected);
  for (const hybrid of hybridRoutes) {
    if (currentHybridCount >= targetHybridCount) break;
    if (selectedRoutes.has(hybrid)) continue;

    // 保留第一名，优先替换排名靠后的非混合方案。
    const replaceIndex = selected.map((route, index) => ({ route, index }))
      .reverse()
      .find(({ route, index }) => index > 0 && route.category !== 'hybrid')?.index;
    if (replaceIndex == null) break;
    selectedRoutes.delete(selected[replaceIndex]);
    selected[replaceIndex] = hybrid;
    selectedRoutes.add(hybrid);
    currentHybridCount++;
  }
  // 补位后仍严格按全局排名展示，避免较差方案出现在较优方案之前。
  return selected.sort((a, b) => rankByRoute.get(a) - rankByRoute.get(b));
}


function calculateWalkingDistance(points) {
  let totalDistance = 0;
  for (let i = 0; i < points.length - 1; i++) {
    totalDistance += map.getDistance(points[i], points[i + 1]);
  }
  return totalDistance;
}
