// 03-algorithm.js — split from app-client.js
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


function calculateWalkingDistance(points) {
  let totalDistance = 0;
  for (let i = 0; i < points.length - 1; i++) {
    totalDistance += map.getDistance(points[i], points[i + 1]);
  }
  return totalDistance;
}
