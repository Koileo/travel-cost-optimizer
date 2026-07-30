const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '04-map.js'), 'utf8');
const context = {};
vm.createContext(context);
vm.runInContext(`${source}\nglobalThis.mapRouting = { mapCoordinatePair, normalizeMapPath, getSegmentMapPath, getRouteMapPath };`, context);

const { mapCoordinatePair, normalizeMapPath, getSegmentMapPath, getRouteMapPath } = context.mapRouting;
const plain = value => JSON.parse(JSON.stringify(value));

test('兼容高德 LngLat、数组和字符串坐标', () => {
  assert.deepEqual(plain(mapCoordinatePair({ lng: 116.4, lat: 39.9 })), [116.4, 39.9]);
  assert.deepEqual(plain(mapCoordinatePair([116.4, 39.9])), [116.4, 39.9]);
  assert.deepEqual(plain(normalizeMapPath('116.4,39.9;116.41,39.91')), [[116.4, 39.9], [116.41, 39.91]]);
});

test('公交和步行都优先读取 Transfer 的 segment.transit.path', () => {
  const segment = {
    transit_mode: 'WALK',
    transit: { path: [{ lng: 116.4, lat: 39.9 }, { lng: 116.41, lat: 39.91 }] },
    walking: { path: [[0, 0], [1, 1]] },
  };
  assert.deepEqual(plain(getSegmentMapPath(segment)), [[116.4, 39.9], [116.41, 39.91]]);
});

test('驾车路线没有顶层 path 时使用 steps 轨迹', () => {
  const route = { steps: [{ path: [[116.4, 39.9], [116.405, 39.905]] }, { path: [[116.405, 39.905], [116.41, 39.91]] }] };
  assert.deepEqual(plain(getRouteMapPath(route)), [[116.4, 39.9], [116.405, 39.905], [116.405, 39.905], [116.41, 39.91]]);
});
