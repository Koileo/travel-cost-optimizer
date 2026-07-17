// Vercel serverless: /api/amap-driving.js
const https = require('https');
const { URL } = require('url');

const AMAP_WEB_SERVICE_KEY = process.env.AMAP_WEB_SERVICE_KEY || '';

module.exports = function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  if (!AMAP_WEB_SERVICE_KEY) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ error: '未配置 AMAP_WEB_SERVICE_KEY' }));
  }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let p;
    try { p = JSON.parse(body); } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: 'JSON 无效' }));
    }
    const ok = pt => Array.isArray(pt) && pt.length === 2 && pt.every(v => Number.isFinite(Number(v)));
    if (!ok(p.origin) || !ok(p.destination)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: '坐标无效' }));
    }

    const pt = v => `${Number(v[0]).toFixed(6)},${Number(v[1]).toFixed(6)}`;
    const u = new URL('https://restapi.amap.com/v3/direction/driving?' + new URLSearchParams({
      key: AMAP_WEB_SERVICE_KEY, origin: pt(p.origin), destination: pt(p.destination),
      strategy: '10', extensions: 'all', output: 'JSON',
    }));

    https.get({ hostname: u.hostname, port: 443, path: u.pathname + u.search }, pr => {
      res.writeHead(pr.statusCode, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': pr.headers['content-type'] || 'application/json',
      });
      let d = ''; pr.on('data', c => d += c); pr.on('end', () => res.end(d));
    }).on('error', e => {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    });
  });
};
