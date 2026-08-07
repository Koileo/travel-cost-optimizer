const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '05-didi.js'), 'utf8');

function createClientContext(fetch) {
  const context = {
    __DIDI_TEST_MIN_INTERVAL_MS: 0,
    appSettings: { city: '北京', didiEndpoint: '', didiHeaders: {}, didiBody: {} },
    startPOI: { name: '起点', address: '' },
    endPOI: { name: '终点', address: '' },
    console: { info() {}, warn() {}, error() {} },
    fetch,
    queueMicrotask,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(
    `${source}\nglobalThis.didiClient = { getDidiEstimate, beginDidiSearchBatch, resetDidiRequestState, recordDidiResponseStatus, cacheTtlMs: DIDI_ESTIMATE_CACHE_TTL_MS };`,
    context
  );
  return context.didiClient;
}

function successfulResponse() {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        errno: 0,
        data: {
          estimate_data: {
            product: { fee_amount: 18, car_title: '快车' },
          },
        },
      };
    },
  };
}

test('滴滴估价队列严格串行执行不同路段请求', async () => {
  let active = 0;
  let maxActive = 0;
  let requestCount = 0;
  const client = createClientContext(async () => {
    requestCount++;
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return successfulResponse();
  });

  client.beginDidiSearchBatch();
  await Promise.all([
    client.getDidiEstimate([0, 0], [1, 1]),
    client.getDidiEstimate([0, 0], [2, 2]),
    client.getDidiEstimate([0, 0], [3, 3]),
  ]);

  assert.equal(requestCount, 3);
  assert.equal(maxActive, 1);
});

test('首次 520 就会打开滴滴估价熔断', () => {
  const client = createClientContext(async () => successfulResponse());
  client.resetDidiRequestState();
  assert.throws(
    () => client.recordDidiResponseStatus(520),
    error => error.code === 'DIDI_CIRCUIT_OPEN' && error.status === 520
  );
});

test('单次搜索超过八个不同路段时仍全部请求滴滴实时报价', async () => {
  let requestCount = 0;
  const client = createClientContext(async () => {
    requestCount++;
    return successfulResponse();
  });
  client.beginDidiSearchBatch();
  await Promise.all(Array.from({ length: 12 }, (_, index) =>
    client.getDidiEstimate([0, 0], [index + 1, index + 1])
  ));
  assert.equal(requestCount, 12);
});

test('滴滴实时价格只缓存三分钟', () => {
  const client = createClientContext(async () => successfulResponse());
  assert.equal(client.cacheTtlMs, 3 * 60 * 1000);
});
