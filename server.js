const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// 本地开发配置：读取项目根目录 .env，且不覆盖已由系统注入的环境变量。
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const [, name, rawValue] = match;
    process.env[name] = rawValue.replace(/^(['"])(.*)\1$/, '$2');
  }
}

loadEnvFile();

const PORT = process.env.PORT || 3000;
const AMAP_WEB_SERVICE_KEY = process.env.AMAP_WEB_SERVICE_KEY || '';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const STATIC_FILES = [
  'index.html',
  'app.js',
  'styles.css',
  'sw.js',
  'manifest.json',
];

function serveStatic(url, res) {
  let filePath = url === '/' ? 'index.html' : url.replace(/^\//, '');
  const fullPath = path.join(__dirname, filePath);

  if (!fs.existsSync(fullPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  const ext = path.extname(fullPath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const content = fs.readFileSync(fullPath);

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.end(content);
}

function proxyAmapDriving(req, res) {
  // Key 只保存在服务端环境变量，避免出现在浏览器、URL 和访问日志中。
  if (!AMAP_WEB_SERVICE_KEY) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: '服务端未配置 AMAP_WEB_SERVICE_KEY' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body);
      const valid = point => Array.isArray(point) && point.length === 2 && point.every(v => Number.isFinite(Number(v)));
      if (!valid(payload.origin) || !valid(payload.destination)) throw new Error('invalid coordinates');
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'origin 和 destination 必须是有效坐标' }));
      return;
    }

    const point = values => `${Number(values[0]).toFixed(6)},${Number(values[1]).toFixed(6)}`;
    const origin = point(payload.origin);
    const destination = point(payload.destination);
    const targetUrl = 'https://restapi.amap.com/v3/direction/driving?' + new URLSearchParams({
      key: AMAP_WEB_SERVICE_KEY,
      origin,
      destination,
      strategy: '10',
      extensions: 'all',
      output: 'JSON',
    }).toString();
    const target = new URL(targetUrl);

    const options = {
      hostname: target.hostname,
      port: 443,
      path: target.pathname + target.search,
      method: 'GET',
    };

    console.log('[高德驾车 →]', { origin, destination, strategy: '10', extensions: 'all' });

    const proxyReq = https.request(options, proxyRes => {
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };

      const headers = {
        ...corsHeaders,
        'Content-Type': proxyRes.headers['content-type'] || 'application/json',
      };

      res.writeHead(proxyRes.statusCode, headers);

      let responseBody = '';
      proxyRes.on('data', chunk => { responseBody += chunk; });
      proxyRes.on('end', () => {
        let summary = { httpStatus: proxyRes.statusCode };
        try {
          const payload = JSON.parse(responseBody);
          const path = payload.route?.paths?.[0];
          summary = {
            ...summary,
            status: payload.status,
            info: payload.info,
            infocode: payload.infocode,
            taxiCost: payload.route?.taxi_cost,
            distance: path?.distance,
            duration: path?.duration,
          };
        } catch (err) {
          summary.bodyPreview = responseBody.slice(0, 300);
        }
        console.log('[高德驾车 ←]', summary);
        res.end(responseBody);
      });
    });

    proxyReq.on('error', err => {
      console.error('[高德驾车 ERROR]', err.message);
      res.writeHead(502, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({
        error: `代理请求失败: ${err.message}`,
      }));
    });

    proxyReq.end();
  });
}

// 滴滴小程序估价代理：将客户端的坐标请求转为滴滴 pMultiEstimatePriceV3 接口调用。
// 会话级参数优先使用设置页覆盖值，缺失项再从环境变量和内置默认值读取。
function proxyDidiEstimate(req, res) {
  let body = '';
  let bodyTooLarge = false;
  req.on('data', chunk => {
    if (bodyTooLarge) return;
    body += chunk;
    if (body.length > 64 * 1024) {
      bodyTooLarge = true;
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: '请求配置过大' }));
    }
  });
  req.on('end', () => {
    if (bodyTooLarge) return;
    let payload;
    try {
      payload = JSON.parse(body);
      const validCoord = v => v !== undefined && v !== null && Number.isFinite(Number(v));
      if (!validCoord(payload.from_lat) || !validCoord(payload.from_lng) ||
          !validCoord(payload.to_lat) || !validCoord(payload.to_lng)) {
        throw new Error('invalid coordinates');
      }
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: '缺少有效的起终点坐标' }));
      return;
    }

    // 辅助：生成随机 hex 串（模拟小程序生成的 request-id 等）
    const hexId = (len) => Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join('');

    const fromLat = String(payload.from_lat);
    const fromLng = String(payload.from_lng);
    const toLat = String(payload.to_lat);
    const toLng = String(payload.to_lng);
    const cityId = String(payload.city_id || 1);
    const customConfig = payload.didi_config && typeof payload.didi_config === 'object'
      ? payload.didi_config
      : {};
    const customBody = customConfig.body && !Array.isArray(customConfig.body) && typeof customConfig.body === 'object'
      ? customConfig.body
      : {};
    const customHeaders = customConfig.headers && !Array.isArray(customConfig.headers) && typeof customConfig.headers === 'object'
      ? customConfig.headers
      : {};

    let target;
    try {
      target = new URL(customConfig.endpoint || 'https://api.udache.com/gulfstream/pre-sale/v1/core/pMultiEstimatePriceV3');
      const allowedHost = /(^|\.)udache\.com$/i.test(target.hostname) || /(^|\.)didichuxing\.com$/i.test(target.hostname);
      if (target.protocol !== 'https:' || !allowedHost || target.username || target.password) {
        throw new Error('unsupported endpoint');
      }
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: '滴滴接口地址无效或域名不在允许范围内' }));
      return;
    }

    // 构造请求体（application/x-www-form-urlencoded）
    const params = new URLSearchParams();
    params.append('lang', 'zh-CN');
    params.append('token', process.env.DIDI_TOKEN || '');
    params.append('access_key_id', '9');
    params.append('appversion', '7.2.55');
    params.append('channel', '1100000002');
    params.append('_ds', '');
    params.append('app_version', '7.2.55');
    params.append('client_type', '201');
    params.append('platform_type', '3');
    params.append('lat', fromLat);
    params.append('lng', fromLng);
    params.append('from_lat', fromLat);
    params.append('from_lng', fromLng);
    params.append('from_poi_id', payload.from_poi_id || `${Date.now()}${Math.floor(Math.random() * 10000)}_wx4g04jpgr_${Math.floor(Math.random() * 900000000 + 100000000)}_100`);
    params.append('from_poi_type', payload.from_poi_type || 'cfcross_first');
    params.append('from_address', payload.from_address || '');
    params.append('from_name', payload.from_name || '');
    params.append('choose_f_searchid', hexId(32));
    params.append('to_lat', toLat);
    params.append('to_lng', toLng);
    params.append('to_name', payload.to_name || '');
    params.append('to_poi_id', payload.to_poi_id || `${Date.now()}${Math.floor(Math.random() * 10000)}`);
    params.append('to_poi_type', payload.to_poi_type || 'ud_history');
    params.append('to_address', payload.to_address || '');
    params.append('choose_t_searchid', hexId(32));
    params.append('user_type', '1');
    params.append('tab_id', 'classify');
    params.append('xprod_version', '7.2.55');
    params.append('stopover_points', '');
    params.append('tab_list', '[{"tab_id":"classify","default_select":true}]');
    params.append('xpsid', hexId(32));
    params.append('brand', 'iPhone');
    params.append('mobile_operating_system', 'ios');
    params.append('model', 'iPhone 17<iPhone18,3>');
    params.append('maptype', 'soso');
    params.append('ddfp', process.env.DIDI_DDFP || '');
    params.append('origin_id', '1');
    params.append('terminal_id', '0');
    params.append('from', 'xwebapp');
    params.append('order_type', '0');
    params.append('preferred_route_id', '');
    params.append('menu_id', 'dache_anycar');
    params.append('pixels', '1206*2622');
    params.append('screen_scale', '3');
    params.append('page_type', '0');
    params.append('departure_time', '0');
    params.append('payments_type', '-1');
    params.append('luxury_select_carlevels', '[]');
    params.append('route_preference_type', '0');
    params.append('call_car_phone_encode', process.env.DIDI_CALL_CAR_PHONE_ENCODE || '');
    params.append('form_height', '508.02');
    params.append('from_poi_code', '');
    params.append('dest_poi_code', payload.dest_poi_code || '');
    params.append('sec_session_id', process.env.DIDI_SEC_SESSION_ID || '');
    params.append('dfp_ddfp', process.env.DIDI_DFP_DDFP || '');
    params.append('biz_appid', '35009');

    // 设置页传入的固定参数覆盖服务端默认值；动态行程参数始终由本次请求生成。
    for (const [key, value] of Object.entries(customBody)) {
      if (/^[A-Za-z0-9_.-]{1,80}$/.test(key) && ['string', 'number', 'boolean'].includes(typeof value)) {
        params.set(key, String(value));
      }
    }
    const dynamicBody = {
      lat: fromLat,
      lng: fromLng,
      from_lat: fromLat,
      from_lng: fromLng,
      from_address: payload.from_address || '',
      from_name: payload.from_name || '',
      to_lat: toLat,
      to_lng: toLng,
      to_name: payload.to_name || '',
      to_address: payload.to_address || '',
      choose_f_searchid: hexId(32),
      choose_t_searchid: hexId(32),
      xpsid: hexId(32),
    };
    for (const [key, value] of Object.entries(dynamicBody)) params.set(key, value);

    const postData = params.toString();

    // 构造请求头
    const requestHeaders = {
      'host': target.host,
      'connection': 'keep-alive',
      'xregionkeyvalue': cityId,
      'wsgsig': process.env.DIDI_WSGSIG || '',
      'content-type': 'application/x-www-form-urlencoded',
      'xregionkeyname': 'passenger',
      'secdd-challenge': '3|2.0.47||||||',
      'didi-header-hint-content': JSON.stringify({ lang: 'zh-CN', Cityid: Number(cityId) }),
      'secdd-authentication': process.env.DIDI_SECDD_AUTH || '',
      'didi-header-rid': hexId(32),
      'accept-encoding': 'gzip, deflate, br',
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.74(0x18004a30) NetType/4G Language/zh_CN',
      'referer': 'https://servicewechat.com/wxaf35009675aa0b2a/1190/page-frame.html',
    };

    const blockedHeaders = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'content-type', 'accept-encoding']);
    for (const [rawName, value] of Object.entries(customHeaders)) {
      const name = rawName.toLowerCase();
      if (!blockedHeaders.has(name) && /^[a-z0-9-]{1,80}$/.test(name) && ['string', 'number', 'boolean'].includes(typeof value)) {
        requestHeaders[name] = String(value);
      }
    }
    requestHeaders['content-length'] = Buffer.byteLength(postData);

    if (!params.get('token') || !requestHeaders.wsgsig) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: '缺少滴滴 token 或 wsgsig，请在设置或 .env 中配置' }));
      return;
    }

    const options = {
      hostname: target.hostname,
      port: 443,
      path: target.pathname + target.search,
      method: 'POST',
      headers: requestHeaders,
    };

    console.log('[滴滴估价 →]', { from: `${fromLat},${fromLng}`, to: `${toLat},${toLng}`, cityId });

    const proxyReq = https.request(options, proxyRes => {
      // 处理可能的压缩响应
      let responseStream = proxyRes;
      const encoding = proxyRes.headers['content-encoding'];
      if (encoding === 'gzip') {
        responseStream = proxyRes.pipe(zlib.createGunzip());
      } else if (encoding === 'deflate') {
        responseStream = proxyRes.pipe(zlib.createInflate());
      } else if (encoding === 'br') {
        responseStream = proxyRes.pipe(zlib.createBrotliDecompress());
      }

      const chunks = [];
      responseStream.on('data', chunk => { chunks.push(chunk); });
      responseStream.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf-8');

        const corsHeaders = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Content-Type': 'application/json; charset=utf-8',
        };

        let summary = { httpStatus: proxyRes.statusCode };
        try {
          const data = JSON.parse(responseBody);
          summary.errno = data.errno;
          summary.errmsg = data.errmsg;
          // 打印 data 层的所有 key，方便定位价格数据结构
          if (data.data) {
            summary.dataKeys = Object.keys(data.data);
            // 打印前两层结构
            const preview = {};
            for (const [k, v] of Object.entries(data.data)) {
              if (Array.isArray(v)) {
                preview[k] = `Array[${v.length}]` + (v.length > 0 ? ' keys=' + Object.keys(v[0]).join(',') : '');
              } else if (v && typeof v === 'object') {
                preview[k] = 'Object keys=' + Object.keys(v).join(',');
              } else {
                preview[k] = v;
              }
            }
            summary.dataPreview = preview;
          }
          // 打印完整响应供调试（首次调试用，确认结构后可删除）
          console.log('[滴滴估价 完整响应]', responseBody.slice(0, 3000));
        } catch (e) {
          summary.bodyPreview = responseBody.slice(0, 300);
        }
        console.log('[滴滴估价 ←]', summary);

        res.writeHead(proxyRes.statusCode, corsHeaders);
        res.end(responseBody);
      });
    });

    proxyReq.on('error', err => {
      console.error('[滴滴估价 ERROR]', err.message);
      res.writeHead(502, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ error: `滴滴代理请求失败: ${err.message}` }));
    });

    proxyReq.write(postData);
    proxyReq.end();
  });
}

// 抽取的请求处理函数，同时支撑本地 http.createServer 和 Vercel serverless 部署
function handleRequest(req, res) {
  console.log(`${req.method} ${req.url}`);

  // CORS 预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // 高德驾车路径规划代理
  if (req.url === '/amap-driving') {
    proxyAmapDriving(req, res);
    return;
  }

  // 滴滴小程序估价代理
  if (req.url === '/didi-estimate') {
    proxyDidiEstimate(req, res);
    return;
  }

  // 静态文件服务
  serveStatic(req.url, res);
}

// Vercel serverless 导出
module.exports = handleRequest;

// 本地开发：直接启动 HTTP 服务器
if (require.main === module) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`🚕 出行成本优化器已启动: http://localhost:${PORT}`);
    console.log(`   高德驾车代理: http://localhost:${PORT}/amap-driving (使用 AMAP_WEB_SERVICE_KEY 环境变量)`);
    console.log(`   滴滴估价代理: http://localhost:${PORT}/didi-estimate (支持设置页覆盖或环境变量)`);
  });
}
