const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '07-ui.js'), 'utf8');

function createCacheContext() {
  const scheduled = [];
  const storage = new Map();
  const context = {
    Date: class extends Date { static now() { return 1_000; } },
    ROUTE_RESULT_TTL_MS: 300,
    SAVED_SEARCH_KEY: 'saved-search',
    _routeExpiryTimer: null,
    routeDataFetchedAt: 100,
    allRoutes: [{ id: 'stale' }],
    _lastResults: [{ id: 'stale' }],
    startPOI: { name: '起点', location: [1, 2] },
    endPOI: { name: '终点', location: [3, 4] },
    sortMode: 'balanced',
    passengerCount: 1,
    resultsList: { innerHTML: '' },
    modal: { hidden: true },
    map: null,
    window: {},
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    localStorage: {
      setItem: (key, value) => storage.set(key, value),
      getItem: key => storage.get(key) || null,
    },
    normalizeRoutePOI: poi => ({
      ...poi,
      location: { lng: poi.location[0], lat: poi.location[1] },
    }),
    isRouteResultFresh: () => false,
    clearRouteOverlays() {},
    updateMapMarkers() {},
    setTimeout: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    clearTimeout() {},
  };
  vm.createContext(context);
  vm.runInContext(
    `${source}\nglobalThis.routeCacheUI = { expireRouteResults, scheduleRouteExpiry };`,
    context
  );
  return { context, scheduled, storage, cacheUI: context.routeCacheUI };
}

test('页面中的路线按原始获取时间安排过期', () => {
  const { cacheUI, scheduled } = createCacheContext();
  cacheUI.scheduleRouteExpiry(900);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 250);
});

test('路线过期后清空结果但保留起终点', () => {
  const { context, storage, cacheUI } = createCacheContext();
  cacheUI.expireRouteResults();

  assert.equal(context.allRoutes.length, 0);
  assert.equal(context._lastResults.length, 0);
  assert.equal(context.routeDataFetchedAt, 0);
  assert.match(context.resultsList.innerHTML, /路线数据已过期/);

  const saved = JSON.parse(storage.get('saved-search'));
  assert.equal(saved.startPOI.name, '起点');
  assert.equal(saved.endPOI.name, '终点');
  assert.deepEqual(saved.allRoutes, []);
});
