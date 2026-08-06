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
  getSegmentMode: segment => String(segment.type || segment.mode || segment.transit_mode || 'walk').toLowerCase(),
  getSegmentMinutes: segment => segment.time / 60,
};
vm.createContext(context);
vm.runInContext(
  `${source}\nglobalThis.routeAlgorithm = { sortRoutes, selectRoutesForDisplay, isPracticalRoute, filterPracticalRoutes, getRouteSemanticSignature, optimizeRoutePortfolio, addRouteValueInsights };`,
  context
);
const {
  sortRoutes,
  selectRoutesForDisplay,
  isPracticalRoute,
  filterPracticalRoutes,
  getRouteSemanticSignature,
  optimizeRoutePortfolio,
  addRouteValueInsights,
} = context.routeAlgorithm;

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

test('超长全程步行和骑行在排序前直接淘汰', () => {
  const absurdWalk = route('airport-walk', 0, 11 * 60 + 24, 600, {
    category: 'walk',
    type: 'walk',
    distance: 51_300,
  });
  const practicalWalk = route('nearby-walk', 0, 60, 60, {
    category: 'walk',
    type: 'walk',
    distance: 5_000,
  });
  const absurdRide = route('airport-ride', 6, 210, 120, {
    category: 'ride',
    type: 'ride',
    distance: 51_300,
  });
  const disguisedHybrid = route('disguised-walk', 8, 240, 120, {
    category: 'hybrid',
    type: 'hybrid',
    distance: 30_000,
    segments: [
      { type: 'walk', distance: 12_000, time: 150 * 60 },
      { type: 'transit', distance: 18_000, time: 90 * 60 },
    ],
  });

  assert.equal(isPracticalRoute(absurdWalk), false);
  assert.equal(isPracticalRoute(practicalWalk), true);
  assert.equal(isPracticalRoute(absurdRide), false);
  assert.equal(isPracticalRoute(disguisedHybrid), false);
  assert.deepEqual(
    filterPracticalRoutes([absurdWalk, practicalWalk, absurdRide, disguisedHybrid]).map(item => item.id),
    ['nearby-walk']
  );
});

test('不同来源但执行链路相同的近似方案只展示当前排序更优的一条', () => {
  const first = route('source-a', 12, 40, 20, {
    segments: [{ type: 'transit', lineName: '1号线(苹果园-四惠东)', fromStation: 'A', toStation: 'B' }],
  });
  const duplicate = route('source-b', 13, 42, 20, {
    segments: [{ type: 'transit', lineName: '1号线', fromStation: 'A', toStation: 'B' }],
  });
  sortRoutes([first, duplicate], 'balanced');
  const optimized = optimizeRoutePortfolio([first, duplicate]);

  assert.equal(getRouteSemanticSignature(first), getRouteSemanticSignature(duplicate));
  assert.equal(optimized.length, 1);
  assert.equal(optimized[0].id, 'source-a');
});

test('同一链路存在明显省时取舍时两条都保留并解释边际价值', () => {
  const cheap = route('cheap', 5, 60, 20, {
    segments: [{ type: 'transit', lineName: '2号线', fromStation: 'A', toStation: 'B' }],
  });
  const fast = route('fast', 15, 35, 20, {
    segments: [{ type: 'transit', lineName: '2号线', fromStation: 'A', toStation: 'B' }],
  });
  const optimized = optimizeRoutePortfolio([cheap, fast]);

  assert.equal(optimized.length, 2);
  assert.equal(fast.value.savedMinutes, 25);
  assert.equal(fast.value.yuanPerMinuteSaved, 0.4);
  assert.match(fast.insight, /多 ¥10\.0.*省 25 分钟/);
});

test('原始公交段会读取嵌套线路字段，不把不同地铁线误判为重复', () => {
  const rawTransitRoute = (id, lineName) => route(id, 5, 40, 20, {
    segments: [{
      transit_mode: 'SUBWAY',
      transit: {
        lines: [{ name: lineName }],
        on_station: { name: '起始站' },
        off_station: { name: '终到站' },
      },
    }],
  });
  const first = rawTransitRoute('line-1', '1号线');
  const second = rawTransitRoute('line-2', '2号线');

  assert.notEqual(getRouteSemanticSignature(first), getRouteSemanticSignature(second));
  assert.equal(optimizeRoutePortfolio([first, second]).length, 2);
});
