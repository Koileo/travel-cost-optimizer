const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '03-algorithm.js'), 'utf8');
const context = {
  COMFORT_WEIGHTS: { walk: 1 },
  _currentWeather: null,
  countTaxiSegments: route => route.taxiSegments || 0,
  getDisplayCost: route => route.cost,
  getWeatherPenalty: () => ({ walkBonus: 0, rideBonus: 0, label: '' }),
  getSegmentMode: segment => segment.type,
  getSegmentMinutes: segment => segment.time / 60,
};
vm.createContext(context);
vm.runInContext(
  `${source}\nglobalThis.routeAlgorithm = { sortRoutes, selectRoutesForDisplay };`,
  context
);
const { sortRoutes, selectRoutesForDisplay } = context.routeAlgorithm;

function route(id, cost, time, comfort, extra = {}) {
  return {
    id,
    cost,
    time,
    comfort,
    category: 'transit',
    segments: [{ type: 'walk', time: comfort * 60 }],
    ...extra,
  };
}

test('被全面支配的路线不会排到支配它的路线之前', () => {
  const routes = [
    route('dominated', 30, 60, 45),
    route('better', 20, 45, 30),
    route('fast', 45, 25, 20),
  ];
  sortRoutes(routes, 'balanced');
  assert.ok(routes.findIndex(item => item.id === 'better') < routes.findIndex(item => item.id === 'dominated'));
  assert.ok(routes.find(item => item.id === 'dominated').paretoRank > 0);
});

test('新增极端差候选不会改变原有路线的相对顺序', () => {
  const base = [
    route('cheap', 6, 55, 38),
    route('balanced', 18, 36, 24),
    route('comfortable', 42, 30, 12),
  ];
  const withOutlier = [...base.map(item => ({ ...item })), route('outlier', 10000, 10000, 10000)];
  const withoutOutlier = base.map(item => ({ ...item }));

  sortRoutes(withoutOutlier, 'balanced');
  sortRoutes(withOutlier, 'balanced');

  assert.deepEqual(
    withOutlier.filter(item => item.id !== 'outlier').map(item => item.id),
    withoutOutlier.map(item => item.id)
  );
  assert.equal(withOutlier.at(-1).id, 'outlier');
});

test('经济、时间、舒适模式分别优先对应维度', () => {
  const candidates = [
    route('cheap', 0, 80, 50),
    route('fast', 45, 20, 28),
    route('comfortable', 38, 42, 5),
  ];
  const firstFor = mode => {
    const routes = candidates.map(item => ({
      ...item,
      segments: item.segments.map(segment => ({ ...segment })),
    }));
    sortRoutes(routes, mode);
    return routes[0].id;
  };

  assert.equal(firstFor('cheapest'), 'cheap');
  assert.equal(firstFor('fastest'), 'fast');
  assert.equal(firstFor('comfortable'), 'comfortable');
});

test('展示补位只选择有竞争力的混合方案并保持全局顺序', () => {
  const routes = Array.from({ length: 18 }, (_, index) => ({
    id: `route-${index}`,
    category: index >= 14 ? 'hybrid' : 'transit',
    routeScore: index < 17 ? index * 0.03 : 1.2,
    paretoRank: index < 17 ? 1 : 3,
  }));
  const displayed = selectRoutesForDisplay(routes, 14);

  assert.ok(displayed.some(item => item.id === 'route-14'));
  assert.ok(!displayed.some(item => item.id === 'route-17'));
  assert.deepEqual(
    displayed.map(item => routes.indexOf(item)),
    displayed.map(item => routes.indexOf(item)).slice().sort((a, b) => a - b)
  );
});
