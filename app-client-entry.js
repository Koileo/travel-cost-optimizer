// app.js — Entry point: event wiring + initialization
// Depends on: src/01-09.js loaded in order via <script> tags

// 排序模式切换
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-option');
  if (!btn) return;
  const mode = btn.dataset.mode;
  if (!mode || mode === sortMode) return;
  sortMode = mode;
  document.querySelectorAll('.mode-option').forEach(b => {
    b.classList.toggle('is-active', b.dataset.mode === sortMode);
    b.setAttribute('aria-selected', b.dataset.mode === sortMode ? 'true' : 'false');
  });
  if (allRoutes.length > 0) {
    sortRoutes(allRoutes, sortMode);
    allRoutes.forEach(route => { route.badge = null; });
    if (allRoutes[0]) allRoutes[0].badge = 'best';
    renderResults(selectRoutesForDisplay(allRoutes));
    saveSearchState();
  }
});

// GPS 定位
if (typeof gpsBtn !== 'undefined' && gpsBtn) {
  gpsBtn.addEventListener('click', async () => {
    try {
      await getCurrentLocation();
      const [lng, lat] = currentLocation;
      map.setCenter([lng, lat]);
      const address = await reverseGeocode([lng, lat]);
      startInput.value = address;
      startPOI = { name: address, location: { lng, lat }, address };
      updateMapMarkers();
    } catch (err) { alert('定位失败：' + err.message); }
  });
}

// 起终点互换
if (typeof swapBtn !== 'undefined' && swapBtn) {
  swapBtn.addEventListener('click', () => {
    const tmpPOI = startPOI, tmpInput = startInput.value;
    startPOI = endPOI; startInput.value = endInput.value;
    endPOI = tmpPOI; endInput.value = tmpInput;
    if (startPOI) startInput.closest('.input-wrapper').classList.add('selected');
    if (endPOI) endInput.closest('.input-wrapper').classList.add('selected');
    updateMapMarkers();
  });
}

// 搜索按钮
if (typeof searchBtn !== 'undefined' && searchBtn) searchBtn.addEventListener('click', searchRoutes);

// 人数变更
const passengerMinus = document.getElementById('passenger-minus');
const passengerPlus = document.getElementById('passenger-plus');
const passengerCountEl = document.getElementById('passenger-count');

function updatePassengerCount(nextCount) {
  const clamped = Math.max(1, Math.min(10, nextCount));
  if (clamped === passengerCount) return;
  passengerCount = clamped;
  if (passengerCountEl) passengerCountEl.textContent = passengerCount;
  if (allRoutes.length > 0) {
    sortRoutes(allRoutes, sortMode);
    allRoutes.forEach(route => { route.badge = null; });
    if (allRoutes[0]) allRoutes[0].badge = 'best';
    renderResults(selectRoutesForDisplay(allRoutes));
    saveSearchState();
  }
}

if (passengerMinus) passengerMinus.addEventListener('click', () => updatePassengerCount(passengerCount - 1));
if (passengerPlus) passengerPlus.addEventListener('click', () => updatePassengerCount(passengerCount + 1));

// 结果卡片点击
if (typeof resultsList !== 'undefined' && resultsList) {
  resultsList.addEventListener('click', (e) => {
    const card = e.target.closest('.result-card');
    if (!card) return;
    const route = _lastResults.find(r => r.id === card.dataset.id);
    if (route) showRouteDetail(route);
  });
}

// 详情弹窗关闭
if (typeof closeModal !== 'undefined' && closeModal) closeModal.addEventListener('click', closeRouteDetail);
if (typeof modal !== 'undefined' && modal) modal.addEventListener('click', (e) => {
  if (e.target === modal || e.target.classList.contains('modal-backdrop')) closeRouteDetail();
});

const themeToggle = document.getElementById('theme-toggle');
if (themeToggle) themeToggle.addEventListener('click', () => {
  setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});

// 设置面板 (from 08-settings.js)
if (typeof settingsBtn !== 'undefined' && settingsBtn) settingsBtn.addEventListener('click', openSettings);
document.querySelectorAll('[data-close-settings]').forEach(el => el.addEventListener('click', closeSettings));

if (typeof cfgParseDidi !== 'undefined' && cfgParseDidi) {
  cfgParseDidi.addEventListener('click', () => {
    try {
      const parsed = parseDidiCapture(cfgDidiRaw.value);
      cfgDidiEndpoint.value = parsed.endpoint;
      cfgDidiHeaders.value = formatSettingsJson(parsed.headers);
      cfgDidiBody.value = formatSettingsJson(parsed.body);
      cfgDidiRaw.value = '';
      didiTestResult.className = 'settings-test-result show is-success';
      didiTestResult.textContent = '解析完成：' + Object.keys(parsed.headers).length + ' 个请求头、' + Object.keys(parsed.body).length + ' 个请求体参数，已忽略 ' + parsed.ignoredCount + ' 个动态字段。请先测试，再保存。';
    } catch (err) {
      didiTestResult.className = 'settings-test-result show is-error';
      didiTestResult.textContent = err.message;
    }
  });
}

if (typeof cfgSaveBtn !== 'undefined' && cfgSaveBtn) {
  cfgSaveBtn.addEventListener('click', () => {
    try { appSettings = { ...appSettings, ...readDidiSettingsForm() }; }
    catch (err) { didiTestResult.className = 'settings-test-result show is-error'; didiTestResult.textContent = err.message; return; }
    saveSettings(appSettings);
    _didiEstimateCache.clear(); _didiEstimateInFlight.clear();
    const c = appSettings.city || '北京';
    if (_autoCompleteStart) _autoCompleteStart.setCity(c);
    if (_autoCompleteEnd) _autoCompleteEnd.setCity(c);
    if (_placeSearchStart) _placeSearchStart.setCity(c);
    if (_placeSearchEnd) _placeSearchEnd.setCity(c);
    if (transfer) transfer.setCity(c);
    if (map) map.setCenter(getCityCenter(c));
    refreshIcons(); closeSettings();
  });
}

if (typeof cfgTestDidi !== 'undefined' && cfgTestDidi) {
  cfgTestDidi.addEventListener('click', async () => {
    const prev = { ...appSettings };
    try {
      appSettings = { ...appSettings, ...readDidiSettingsForm() };
      cfgTestDidi.disabled = true;
      didiTestResult.className = 'settings-test-result show';
      didiTestResult.textContent = '正在测试北京站到三里屯的估价...';
      const r = await getDidiEstimate([116.4273, 39.9047], [116.4551, 39.9322], { fromName: '北京站', toName: '三里屯' });
      didiTestResult.className = 'settings-test-result show is-success';
      didiTestResult.textContent = '连接成功，北京站到三里屯最低约 ¥' + r.cost + (r.carType ? '（' + r.carType + '）' : '');
    } catch (err) {
      didiTestResult.className = 'settings-test-result show is-error';
      didiTestResult.textContent = err.message;
    } finally { appSettings = prev; cfgTestDidi.disabled = false; }
  });
}

// 导出设置
if (typeof cfgExport !== 'undefined' && cfgExport) {
  cfgExport.addEventListener('click', () => {
    const d = { city: appSettings.city, didiEndpoint: appSettings.didiEndpoint, didiHeaders: appSettings.didiHeaders, didiBody: appSettings.didiBody, _version: 1, _exported: new Date().toISOString() };
    const json = JSON.stringify(d, null, 2);
    if (typeof cfgImportText !== 'undefined' && cfgImportText) { cfgImportText.value = json; cfgImportArea.style.display = 'block'; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(() => {
        if (typeof didiTestResult !== 'undefined' && didiTestResult) { didiTestResult.className = 'settings-test-result show is-success'; didiTestResult.textContent = '设置已复制到剪贴板'; }
      }).catch(() => {});
    }
  });
}

// 导入设置
if (typeof cfgImportBtn !== 'undefined' && cfgImportBtn) cfgImportBtn.addEventListener('click', () => { cfgImportArea.style.display = 'block'; if (typeof cfgImportText !== 'undefined' && cfgImportText) cfgImportText.focus(); });
if (typeof cfgImportConfirm !== 'undefined' && cfgImportConfirm) {
  cfgImportConfirm.addEventListener('click', () => {
    const raw = (typeof cfgImportText !== 'undefined' && cfgImportText ? cfgImportText.value : '').trim();
    if (!raw) return;
    let d; try { d = JSON.parse(raw); } catch (_) { return; }
    if (!d || typeof d !== 'object') return;
    if (d.city) appSettings.city = d.city;
    if (d.didiEndpoint) appSettings.didiEndpoint = d.didiEndpoint;
    if (d.didiHeaders) appSettings.didiHeaders = d.didiHeaders;
    if (d.didiBody) appSettings.didiBody = d.didiBody;
    saveSettings(appSettings);
    _didiEstimateCache.clear(); _didiEstimateInFlight.clear();
    fillSettingsForm();
    if (typeof cfgImportText !== 'undefined' && cfgImportText) cfgImportText.value = '';
    cfgImportArea.style.display = 'none';
  });
}
if (typeof cfgImportCancel !== 'undefined' && cfgImportCancel) cfgImportCancel.addEventListener('click', () => { if (typeof cfgImportText !== 'undefined' && cfgImportText) cfgImportText.value = ''; cfgImportArea.style.display = 'none'; });

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  restoreSearchState();
  if (window.lucide) { refreshIcons(); } else { window.addEventListener('load', refreshIcons); }
});
