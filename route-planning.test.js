const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '06-route.js'), 'utf8');
const context = {};
vm.createContext(context);
vm.runInContext(`${source}\nglobalThis.routePlanning = { withTaxiPickup, selectHybridStationCandidates, dedupeHybridRoutes };`, context);
const { withTaxiPickup, selectHybridStationCandidates, dedupeHybridRoutes } = context.routePlanning;

test('接驳打车时间包含接驾缓冲', () => {
  assert.equal(withTaxiPickup(12 * 60), 17 * 60);
  assert.equal(withTaxiPickup(12 * 60, 2), 22 * 60);
});

test('混合候选站点排除过近端点并限制实时估价数量', () => {
  const candidates = Array.from({ length: 14 }, (_, index) => ({
    station: {
      ratio: (index + 1) / 16,
      transitMode: index % 2 ? 'BUS' : 'SUBWAY',
      segmentDistance: 500 + index * 200,
    },
  }));
  const selected = selectHybridStationCandidates(candidates);
  assert.ok(selected.length <= 8);
  assert.ok(selected.every(({ station }) => station.ratio >= 0.25 && station.ratio <= 0.9));
});

test('相同接驳链路只保留成本更低的混合方案', () => {
  const route = (id, cost, time) => ({
    id, cost, time,
    segments: [
      { type: 'taxi', fromStation: '起点', toStation: '地铁站' },
      { type: 'transit', lineName: '1号线', fromStation: '地铁站', toStation: '换乘站' },
    ],
  });
  const unique = dedupeHybridRoutes([route('slow', 18, 35), route('best', 16, 42)]);
  assert.equal(unique.map(item => item.id).join(','), 'best');
});
