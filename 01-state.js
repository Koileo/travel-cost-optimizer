// 01-state.js — 客户端状态
// 出行成本优化器
const AMAP_KEY = '0d6897af1d905d14d1dc553850ee051f';
let map, transfer;
let _autoCompleteStart, _autoCompleteEnd, _placeSearchStart, _placeSearchEnd;

// 成本计算配置
const COST_CONFIG = {
  taxi: {
    base: 14,      // 起步价
    perKm: 2.3,    // 每公里价格
    perMin: 0.5    // 每分钟等待
  },
  bus: {
    base: 2,       // 公交基础价
    perKm: 0.1     // 公交每公里加价
  },
  subway: {
    base: 3,       // 地铁基础价
    perKm: 0.4     // 地铁每公里加价
  },
  walk: {
    perKm: 0       // 步行免费
  }
};

// DOM 元素
const startInput = document.getElementById('start-input');
const endInput = document.getElementById('end-input');
const gpsBtn = document.getElementById('gps-btn');
const swapBtn = document.getElementById('swap-btn');
const searchBtn = document.getElementById('search-btn');
const resultsList = document.getElementById('results-list');
const mapContainer = document.getElementById('map-container');
const modal = document.getElementById('route-detail-modal');
const modalBody = document.getElementById('modal-body');
const closeModal = document.getElementById('close-modal');

// 状态
let currentLocation = null;
let startPOI = null;
let endPOI = null;
let allRoutes = [];
let passengerCount = 1;
let _lastResults = []; // 缓存最近一次搜索结果，人数变化时重渲染
const SAVED_SEARCH_KEY = 'travel-optimizer-last-search';

const COMFORT_WEIGHTS = {
  walk: 1,
  ride: 0.62,
  bus: 0.45,
  subway: 0.3,
  transit: 0.4,
  taxi: 0.1,
};

let _currentWeather = null;

let sortMode = "balanced";
