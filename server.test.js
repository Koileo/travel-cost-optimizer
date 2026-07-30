const { EventEmitter } = require('events');
const assert = require('node:assert/strict');
const test = require('node:test');

const handlers = [['application handler', require('./app')]];

function request(handler, url, method = 'GET', body = '') {
  return new Promise(resolve => {
    const req = new EventEmitter();
    req.url = url;
    req.method = method;
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
        this.headersSent = true;
      },
      end(chunk = '') {
        resolve({ status: this.status || 200, body: String(chunk) });
      },
    };
    handler(req, res);
    if (body) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
}

for (const [name, handler] of handlers) {
  test(`${name} only exposes public static assets`, async () => {
    const home = await request(handler, '/');
    assert.equal(home.status, 200);
    assert.match(home.body, /出行成本优化/);

    const clientScript = await request(handler, '/app-client-entry.js');
    assert.equal(clientScript.status, 200);

    for (const path of ['/app.js', '/server.js', '/%2e%2e/.env', '/nope.js']) {
      assert.equal((await request(handler, path)).status, 404, path);
    }
  });
}
