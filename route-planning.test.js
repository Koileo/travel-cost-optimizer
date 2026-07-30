const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '06-route.js'), 'utf8');
const context = {
  isValidLocation: location => Number.isFinite(location?.lng) && Number.isFinite(location?.lat),
};
vm.createContext(context);
vm.runInContext(`${source}\nglobalThis.routePlanning = { withTaxiPickup, selectHybridStationCandidates, dedupeHybridRoutes, collectTransferStations };`, context);
const { withTaxiPickup, selectHybridStationCandidates, dedupeHybridRoutes, collectTransferStations } = context.routePlanning;

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
  assert.ok(selected.length <= 12);
  assert.ok(selected.every(({ station }) => station.ratio >= 0.12 && station.ratio <= 0.94));
});

test('途经站会成为公交加打车的候选，并保留其线路进度', () => {
  const plan = {
    distance: 10_000,
    segments: [{
      distance: 8_000,
      time: 2_400,
      transit_mode: 'SUBWAY',
      transit: {
        lines: [{ name: '1号线' }],
        via_stops: [
          { name: '中间站 A', location: { lng: 116.4, lat: 39.9 } },
          { name: '中间站 B', location: { lng: 116.41, lat: 39.91 } },
        ],
        off_station: { name: '终点站', location: { lng: 116.42, lat: 39.92 } },
      },
    }],
  };
  const stations = collectTransferStations(plan);
  assert.equal(stations.map(station => station.name).join(','), '中间站 A,中间站 B,终点站');
  assert.ok(stations[0].segmentFraction < 1);
  assert.ok(stations[0].prefixTime < stations[2].prefixTime);
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
