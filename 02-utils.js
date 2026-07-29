// 02-utils.js — split from app-client.js
// 出行成本优化器
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

function countTaxiSegments(route) {
  if (Number.isFinite(route?.raw?.taxiSegments)) return route.raw.taxiSegments;
  return (route?.segments || []).filter(segment => getSegmentMode(segment) === 'taxi').length;
}


function estimateRideCost(timeSeconds) {
  const billingUnits = Math.max(1, Math.ceil(timeSeconds / (15 * 60)));
  return billingUnits * 1.5;
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


function coordinatePair(location) {
  if (Array.isArray(location)) return location;
  return location && [location.lng, location.lat];
}
