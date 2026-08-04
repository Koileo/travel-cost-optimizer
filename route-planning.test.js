const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '06-route.js'), 'utf8');
const context = {
  isValidLocation: location => Number.isFinite(location?.lng) && Number.isFinite(location?.lat),
  calculateDistance: (from, to) => Math.hypot(to[0] - from[0], to[1] - from[1]) * 1000,
  AMap: {
    LngLat: class LngLat {
      constructor(lng, lat) { this.lng = lng; this.lat = lat; }
      getLng() { return this.lng; }
      getLat() { return this.lat; }
    },
    plugin: () => { throw new Error('driving unavailable'); },
  },
  console: { info() {}, log() {}, warn() {}, error() {} },
  setTimeout,
  clearTimeout,
  __ROUTE_DRIVING_TIMEOUT_MS: 5,
};
vm.createContext(context);
vm.runInContext(`${source}\nglobalThis.routePlanning = { withTaxiPickup, selectHybridStationCandidates, dedupeHybridRoutes, collectTransferStations, createTransitPrefixSegments, createTransitPrefixRawSegments, mergeTransitPlanResults, selectTaxiToTransitCandidates, isMeaningfulEndpointCombination, getTransitConnectionCategory, settleRouteCreations, createRouteId, getDrivingTime, routeCoordinatePair, normalizeRoutePOI };`, context);
const {
  withTaxiPickup,
  selectHybridStationCandidates,
  dedupeHybridRoutes,
  collectTransferStations,
  createTransitPrefixSegments,
  createTransitPrefixRawSegments,
  mergeTransitPlanResults,
  selectTaxiToTransitCandidates,
  isMeaningfulEndpointCombination,
  getTransitConnectionCategory,
  settleRouteCreations,
  createRouteId,
  getDrivingTime,
  routeCoordinatePair,
  normalizeRoutePOI,
} = context.routePlanning;

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

test('公交转打车保留前置步行，并按途经站比例截断公交段', () => {
  const plan = {
    segments: [
      { transit_mode: 'WALK', distance: 600, time: 480 },
      {
        transit_mode: 'SUBWAY',
        distance: 8_000,
        time: 2_400,
        transit: {
          lines: [{ name: '1号线' }],
          on_station: { name: '上车站' },
          off_station: { name: '线路终点' },
        },
      },
    ],
  };
  const segments = createTransitPrefixSegments(plan, {
    name: '中途站',
    segmentIndex: 1,
    segmentFraction: 0.25,
  });

  assert.equal(segments[0].type, 'walk');
  assert.equal(segments[0].distance, 600);
  assert.equal(segments[1].distance, 2_000);
  assert.equal(segments[1].time, 600);
  assert.equal(segments[1].toStation, '中途站');
});

test('多种公交策略交错合并，并按乘车链路去重', () => {
  const plan = (line, time) => ({
    time,
    segments: [{
      transit_mode: 'SUBWAY',
      transit: {
        lines: [{ name: line }],
        on_station: { name: `${line}起点` },
        off_station: { name: `${line}终点` },
      },
    }],
  });
  const duplicate = plan('1号线', 9999);
  const merged = mergeTransitPlanResults([
    { plans: [plan('1号线', 1000), plan('2号线', 1200)] },
    { plans: [duplicate, plan('3号线', 1400)] },
  ]);

  assert.equal(merged.plans.map(item => item.segments[0].transit.lines[0].name).join(','), '1号线,2号线,3号线');
});

test('打车接公交候选包含后续换乘站，而不只包含第一站', () => {
  const transitSegment = (mode, name, lng, distance, viaStops = []) => ({
    transit_mode: mode,
    distance,
    time: distance / 5,
    transit: {
      lines: [{ name }],
      on_station: { name: `${name}上车站`, location: { lng, lat: 0 } },
      off_station: { name: `${name}下车站`, location: { lng: lng + 1, lat: 0 } },
      via_stops: viaStops,
    },
  });
  const result = {
    plans: [{
      distance: 8_600,
      segments: [
        { transit_mode: 'WALK', distance: 600, time: 480 },
        transitSegment('BUS', '公交1路', 0.6, 2_000),
        { transit_mode: 'WALK', distance: 500, time: 400 },
        transitSegment('SUBWAY', '地铁2号线', 2, 5_500, [
          { name: '地铁中途站', location: { lng: 2.5, lat: 0 } },
        ]),
      ],
    }],
  };
  const candidates = selectTaxiToTransitCandidates(result, [0, 0]);

  assert.ok(candidates.some(candidate => candidate.onStation.name === '公交1路上车站'));
  assert.ok(candidates.some(candidate => candidate.onStation.name === '地铁2号线上车站'));
  assert.ok(candidates.some(candidate => candidate.onStation.name === '地铁中途站'));
});

test('只有含打车段的接驳路线才会被归为混合方案', () => {
  assert.equal(isMeaningfulEndpointCombination({ type: 'ride' }, { type: 'walk' }), true);
  assert.equal(isMeaningfulEndpointCombination({ type: 'walk' }, { type: 'walk' }), false);
  assert.equal(
    getTransitConnectionCategory({ type: 'ride', taxiSegments: 0 }, { type: 'walk', taxiSegments: 0 }),
    'transit-ride'
  );
  assert.equal(
    getTransitConnectionCategory({ type: 'taxi', taxiSegments: 1 }, { type: 'walk', taxiSegments: 0 }),
    'hybrid'
  );
});

test('单个路线来源失败时保留其他已创建结果', async () => {
  const results = await settleRouteCreations([
    Promise.resolve(['公交']),
    Promise.reject(new Error('混合候选失败')),
    Promise.resolve(['打车']),
  ], '测试路线');

  assert.equal(results[0][0], '公交');
  assert.equal(results[1], null);
  assert.equal(results[2][0], '打车');
});

test('混合路线 ID 会编码站名并区分不同公交骨架', () => {
  const first = createRouteId('hybrid', 0, 2, '换乘"站');
  const second = createRouteId('hybrid', 1, 2, '换乘"站');

  assert.notEqual(first, second);
  assert.ok(!first.includes('"'));
});

test('途经站转打车时原始公交段和轨迹会截断到换乘站', () => {
  const plan = {
    segments: [{
      transit_mode: 'SUBWAY',
      distance: 4_000,
      time: 1_200,
      transit: {
        path: [[0, 0], [1, 0], [2, 0], [3, 0]],
        on_station: { name: '起始站', location: { lng: 0, lat: 0 } },
        off_station: { name: '线路终点', location: { lng: 3, lat: 0 } },
        via_stops: [
          { name: '换乘站', location: { lng: 1, lat: 0 } },
          { name: '后续站', location: { lng: 2, lat: 0 } },
        ],
      },
    }],
  };
  const rawSegments = createTransitPrefixRawSegments(plan, {
    name: '换乘站',
    location: { lng: 1, lat: 0 },
    segmentIndex: 0,
    segmentFraction: 1 / 3,
    source: 'via',
    viaIndex: 0,
  });
  const segment = JSON.parse(JSON.stringify(rawSegments[0]));

  assert.equal(segment.distance, 4_000 / 3);
  assert.equal(segment.time, 400);
  assert.equal(segment.transit.off_station.name, '换乘站');
  assert.equal(segment.transit.via_stops.length, 0);
  assert.deepEqual(segment.transit.path.at(-1), [1, 0]);
});

test('驾车 SDK 初始化失败时混合方案使用可完成的直线估算', async () => {
  const result = await getDrivingTime([0, 0], [3, 4], 10);

  assert.equal(result.distance, 5_000);
  assert.equal(result.time, 500);
  assert.deepEqual(JSON.parse(JSON.stringify(result.path)), [[0, 0], [3, 4]]);
});

test('缓存恢复会把数组和旧版高德内部坐标统一为普通位置对象', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalizeRoutePOI({ name: '数组地点', location: [116.4, 39.9] }))),
    { name: '数组地点', location: { lng: 116.4, lat: 39.9 } }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalizeRoutePOI({ name: '旧缓存', location: { KL: 121.4, kT: 31.2 } }))),
    { name: '旧缓存', location: { lng: 121.4, lat: 31.2 } }
  );
  assert.deepEqual(JSON.parse(JSON.stringify(routeCoordinatePair({
    getLng: () => 113.2,
    getLat: () => 23.1,
  }))), [113.2, 23.1]);
  const rehydrated = normalizeRoutePOI({ name: '恢复地点', location: [114.0, 22.5] }, true);
  assert.equal(rehydrated.location.constructor.name, 'LngLat');
  assert.deepEqual(JSON.parse(JSON.stringify(routeCoordinatePair(rehydrated.location))), [114, 22.5]);
});
