// Vercel 入口：静态文件服务 + API 代理
const http = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

const AMAP_KEY = process.env.AMAP_WEB_SERVICE_KEY || '';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// 预加载静态文件到内存，避免运行时读盘问题
const STATIC = {};
['index.html','app-client.js','styles.css','sw.js','manifest.json'].forEach(name => {
  try { STATIC[name] = fs.readFileSync(path.join(__dirname, name), 'utf-8'); }
  catch (_) { /* will try cwd below */ }
});
// Vercel 编译后 __dirname 可能变了，用 cwd 兜底
if (Object.keys(STATIC).length < 5) {
  ['index.html','app-client.js','styles.css','sw.js','manifest.json'].forEach(name => {
    if (!STATIC[name]) {
      try { STATIC[name] = fs.readFileSync(path.join(process.cwd(), name), 'utf-8'); } catch (_) {}
    }
  });
}

function serveStatic(url, res) {
  const file = url === '/' ? 'index.html' : url.replace(/^\//, '').split('?')[0];
  const content = STATIC[file];
  if (!content) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`404: ${file} (cached: ${Object.keys(STATIC).join(', ')})`);
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain', 'Cache-Control': 'no-cache' });
  res.end(content);
}

// ── 高德驾车代理 ──
function amapDriving(req, res) {
  if (!AMAP_KEY) { res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify({ error: '未配置 AMAP_WEB_SERVICE_KEY' })); }
  let body = ''; req.on('data', c => body += c);
  req.on('end', () => {
    let p; try { p = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end(JSON.stringify({ error: 'JSON 无效' })); }
    const ok = pt => Array.isArray(pt) && pt.length === 2 && pt.every(v => Number.isFinite(Number(v)));
    if (!ok(p.origin) || !ok(p.destination)) { res.writeHead(400); return res.end(JSON.stringify({ error: '坐标无效' })); }
    const pt = v => `${Number(v[0]).toFixed(6)},${Number(v[1]).toFixed(6)}`;
    const u = new URL('https://restapi.amap.com/v3/direction/driving?' + new URLSearchParams({ key: AMAP_KEY, origin: pt(p.origin), destination: pt(p.destination), strategy: '10', extensions: 'all', output: 'JSON' }));
    http.get({ hostname: u.hostname, port: 443, path: u.pathname + u.search }, pr => {
      res.writeHead(pr.statusCode, { 'Access-Control-Allow-Origin': '*', 'Content-Type': pr.headers['content-type'] || 'application/json' });
      let d = ''; pr.on('data', c => d += c); pr.on('end', () => res.end(d));
    }).on('error', e => { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
  });
}

// ── 滴滴估价代理 ──
const hexId = n => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');

function didiEstimate(req, res) {
  let body = ''; req.on('data', c => { if (body.length < 65536) body += c; });
  req.on('end', () => {
    let p; try { p = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end(JSON.stringify({ error: 'JSON 无效' })); }
    const vc = v => v !== undefined && v !== null && Number.isFinite(Number(v));
    if (!vc(p.from_lat) || !vc(p.from_lng) || !vc(p.to_lat) || !vc(p.to_lng)) { res.writeHead(400); return res.end(JSON.stringify({ error: '坐标不完整' })); }
    const cc = (p.didi_config && typeof p.didi_config === 'object') ? p.didi_config : {};
    const cb = (!Array.isArray(cc.body) && typeof cc.body === 'object') ? cc.body : {};
    const ch = (!Array.isArray(cc.headers) && typeof cc.headers === 'object') ? cc.headers : {};

    let t;
    try { t = new URL(cc.endpoint || 'https://api.udache.com/gulfstream/pre-sale/v1/core/pMultiEstimatePriceV3');
      if (t.protocol !== 'https:' || !/(^|\.)udache\.com$/i.test(t.hostname) && !/(^|\.)didichuxing\.com$/i.test(t.hostname)) throw new Error();
    } catch (_) { res.writeHead(400); return res.end(JSON.stringify({ error: '域名不允许' })); }

    const ps = new URLSearchParams();
    ps.append('token', process.env.DIDI_TOKEN || '');
    ps.append('access_key_id', '9'); ps.append('appversion', '7.2.55'); ps.append('channel', '1100000002');
    ps.append('client_type', '201'); ps.append('platform_type', '3');
    ps.append('lat', String(p.from_lat)); ps.append('lng', String(p.from_lng));
    ps.append('from_lat', String(p.from_lat)); ps.append('from_lng', String(p.from_lng));
    ps.append('from_address', p.from_address || ''); ps.append('from_name', p.from_name || '');
    ps.append('to_lat', String(p.to_lat)); ps.append('to_lng', String(p.to_lng));
    ps.append('to_name', p.to_name || ''); ps.append('to_address', p.to_address || '');
    ps.append('user_type', '1'); ps.append('tab_id', 'classify'); ps.append('xprod_version', '7.2.55');
    ps.append('brand', 'iPhone'); ps.append('mobile_operating_system', 'ios'); ps.append('model', 'iPhone 17<iPhone18,3>');
    ps.append('maptype', 'soso'); ps.append('origin_id', '1'); ps.append('terminal_id', '0');
    ps.append('from', 'xwebapp'); ps.append('order_type', '0'); ps.append('menu_id', 'dache_anycar');
    ps.append('pixels', '1206*2622'); ps.append('screen_scale', '3'); ps.append('page_type', '0');
    ps.append('departure_time', '0'); ps.append('payments_type', '-1');
    ps.append('luxury_select_carlevels', '[]'); ps.append('route_preference_type', '0');
    ps.append('ddfp', process.env.DIDI_DDFP || '');
    ps.append('call_car_phone_encode', process.env.DIDI_CALL_CAR_PHONE_ENCODE || '');
    ps.append('sec_session_id', process.env.DIDI_SEC_SESSION_ID || '');
    ps.append('dfp_ddfp', process.env.DIDI_DFP_DDFP || '');
    ps.append('biz_appid', '35009'); ps.append('from_poi_code', ''); ps.append('dest_poi_code', p.dest_poi_code || '');
    ps.append('stopover_points', ''); ps.append('tab_list', '[{"tab_id":"classify","default_select":true}]');
    ps.append('preferred_route_id', ''); ps.append('form_height', '508.02');
    ps.append('from_poi_id', p.from_poi_id || `${Date.now()}${Math.floor(Math.random()*10000)}`);
    ps.append('from_poi_type', p.from_poi_type || 'cfcross_first');
    ps.append('to_poi_id', p.to_poi_id || `${Date.now()}${Math.floor(Math.random()*10000)}`);
    ps.append('to_poi_type', p.to_poi_type || 'ud_history');
    ['xpsid','choose_f_searchid','choose_t_searchid'].forEach(k => ps.set(k, hexId(32)));

    for (const [k, v] of Object.entries(cb)) {
      if (/^[A-Za-z0-9_.-]{1,80}$/.test(k) && ['string','number','boolean'].includes(typeof v)) ps.set(k, String(v));
    }

    const hdrs = {
      'host': t.host, 'connection': 'keep-alive',
      'xregionkeyvalue': String(p.city_id || 1), 'xregionkeyname': 'passenger',
      'content-type': 'application/x-www-form-urlencoded',
      'wsgsig': process.env.DIDI_WSGSIG || '',
      'secdd-authentication': process.env.DIDI_SECDD_AUTH || '',
      'secdd-challenge': '3|2.0.47||||||', 'didi-header-rid': hexId(32),
      'didi-header-hint-content': JSON.stringify({ lang: 'zh-CN', Cityid: Number(p.city_id)||1 }),
      'accept-encoding': 'gzip, deflate, br',
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.74(0x18004a30) NetType/4G Language/zh_CN',
      'referer': 'https://servicewechat.com/wxaf35009675aa0b2a/1190/page-frame.html',
    };
    const bh = new Set(['host','connection','content-length','transfer-encoding','content-type','accept-encoding']);
    for (const [rk, rv] of Object.entries(ch)) {
      const n = rk.toLowerCase();
      if (!bh.has(n) && /^[a-z0-9-]{1,80}$/.test(n) && ['string','number','boolean'].includes(typeof rv)) hdrs[n] = String(rv);
    }
    if (!ps.get('token') || !hdrs['wsgsig']) { res.writeHead(503); return res.end(JSON.stringify({ error: '缺少 token/wsgsig' })); }
    const data = ps.toString(); hdrs['content-length'] = Buffer.byteLength(data);

    const pr = http.request({ hostname: t.hostname, port: 443, path: t.pathname + t.search, method: 'POST', headers: hdrs }, proxyRes => {
      let stream = proxyRes;
      const enc = proxyRes.headers['content-encoding'];
      if (enc === 'gzip') stream = proxyRes.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = proxyRes.pipe(zlib.createInflate());
      else if (enc === 'br') stream = proxyRes.pipe(zlib.createBrotliDecompress());
      const chunks = []; stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        res.writeHead(proxyRes.statusCode, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8' });
        res.end(Buffer.concat(chunks));
      });
    });
    pr.on('error', e => { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
    pr.write(data); pr.end();
  });
}

// ── 主处理器 ──
function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  if (req.url === '/didi-estimate') return didiEstimate(req, res);
  if (req.url === '/amap-driving') return amapDriving(req, res);
  serveStatic(req.url, res);
}

module.exports = handler;
