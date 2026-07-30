// 05-didi.js — Didi MCP proxy + API estimate
// 出行成本优化器

// MCP constants
const MCP_COOLDOWN_STORAGE_KEY = 'travel-optimizer-mcp-cooldown';
const MCP_COOLDOWN_MS = 30000;

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

function isMcpConfigured() {
  if (isLocalMcpProxy()) return !!(appSettings.mcpUrl && appSettings.mcpTool);
  return !!(appSettings.mcpUrl && appSettings.mcpKey && appSettings.mcpTool);
}


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

