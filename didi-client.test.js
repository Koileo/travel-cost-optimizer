const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '05-didi.js'), 'utf8');

function createClientContext(fetch) {
  const context = {
    __DIDI_TEST_MIN_INTERVAL_MS: 0,
    __DIDI_TEST_REQUEST_BUDGET: 8,
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
    `${source}\nglobalThis.didiClient = { getDidiEstimate, beginDidiSearchBatch, resetDidiRequestState, recordDidiResponseStatus, reserveDidiRequestBudget };`,
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

test('单次搜索最多预留八个实时滴滴报价', () => {
  const client = createClientContext(async () => successfulResponse());
  client.beginDidiSearchBatch();
  for (let index = 0; index < 8; index++) {
    assert.doesNotThrow(() => client.reserveDidiRequestBudget());
  }
  assert.throws(
    () => client.reserveDidiRequestBudget(),
    error => error.code === 'DIDI_BUDGET_EXHAUSTED'
  );
});
