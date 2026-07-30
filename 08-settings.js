// 08-settings.js — split from app-client.js
// 出行成本优化器
const settingsModal = document.getElementById('settings-modal');
const settingsBtn = document.getElementById('settings-btn');
const cfgCity = document.getElementById('cfg-city');
const cfgDidiEndpoint = document.getElementById('cfg-didi-endpoint');
const cfgDidiRaw = document.getElementById('cfg-didi-raw');
const cfgParseDidi = document.getElementById('cfg-parse-didi');
const cfgDidiHeaders = document.getElementById('cfg-didi-headers');
const cfgDidiBody = document.getElementById('cfg-didi-body');
const cfgTestDidi = document.getElementById('cfg-test-didi');
const cfgSaveBtn = document.getElementById('cfg-save');
const cfgExport = document.getElementById('cfg-export');
const cfgImportBtn = document.getElementById('cfg-import-btn');
const cfgImportArea = document.getElementById('cfg-import-area');
const cfgImportText = document.getElementById('cfg-import-text');
const cfgImportConfirm = document.getElementById('cfg-import-confirm');
const cfgImportCancel = document.getElementById('cfg-import-cancel');
const didiStatus = document.getElementById('didi-status');
const didiTestResult = document.getElementById('didi-test-result');

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      didiHeaders: parsed.didiHeaders && typeof parsed.didiHeaders === 'object' ? parsed.didiHeaders : {},
      didiBody: parsed.didiBody && typeof parsed.didiBody === 'object' ? parsed.didiBody : {},
    };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
}

let appSettings = loadSettings();

function isMcpConfigured() {
  // 本地代理从服务端环境变量读取 key，浏览器无需持有它。
  if (isLocalMcpProxy()) return !!(appSettings.mcpUrl && appSettings.mcpTool);
  return !!(appSettings.mcpUrl && appSettings.mcpKey && appSettings.mcpTool);
}

function formatSettingsJson(value) {
  return Object.keys(value || {}).length ? JSON.stringify(value, null, 2) : '';
}

function parseSettingsJson(input, label) {
  const raw = (input.value || '').trim();
  if (!raw) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label}不是有效的 JSON`);
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${label}必须是 JSON 对象`);
  }
  return value;
}

const DIDI_CAPTURE_IGNORED_HEADERS = new Set([
  'host', 'connection', 'content-length', 'content-type',
  'accept-encoding', 'xregionkeyvalue', 'didi-header-hint-content', 'didi-header-rid',
]);

function isDynamicDidiBodyKey(key) {
  return key === 'lat' || key === 'lng' || key === 'xpsid' ||
    key === 'stopover_points' || key === 'dest_poi_code' ||
    key.startsWith('choose_') ||
    /^(?:from|to)_(?:lat|lng|poi_id|poi_type|address|name|poi_code)$/.test(key);
}

function decodeCapturedFormValue(value) {
  try {
    // 抓包文本中的 Base64 凭证常含 "+"，不能按 URLSearchParams 的空格规则处理。
    return decodeURIComponent(value);
  } catch (err) {
    return value;
  }
}

function parseDidiCapture(rawCapture) {
  const raw = String(rawCapture || '').trim();
  if (!raw) throw new Error('请先粘贴滴滴请求头和请求体');

  const headers = {};
  const bodyLines = [];
  let endpoint = DEFAULT_SETTINGS.didiEndpoint;
  let readingBody = false;
  let ignoredCount = 0;

  raw.split(/\r?\n/).forEach(sourceLine => {
    const line = sourceLine.trim();
    if (!line) {
      readingBody = true;
      return;
    }

    const urlMatch = line.match(/https:\/\/[^\s]+/i);
    if (!readingBody && urlMatch) {
      try {
        const parsedUrl = new URL(urlMatch[0]);
        if (/(^|\.)udache\.com$/i.test(parsedUrl.hostname) || /(^|\.)didichuxing\.com$/i.test(parsedUrl.hostname)) {
          endpoint = parsedUrl.toString();
        }
      } catch (err) {}
    }

    const headerMatch = !readingBody && line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (headerMatch) {
      const name = headerMatch[1];
      if (DIDI_CAPTURE_IGNORED_HEADERS.has(name.toLowerCase())) {
        ignoredCount++;
      } else {
        headers[name] = headerMatch[2];
      }
      return;
    }

    if (line.includes('=')) {
      readingBody = true;
      bodyLines.push(line);
    }
  });

  const body = {};
  bodyLines.join('').split('&').forEach(pair => {
    if (!pair) return;
    const separator = pair.indexOf('=');
    const rawKey = separator >= 0 ? pair.slice(0, separator) : pair;
    const rawValue = separator >= 0 ? pair.slice(separator + 1) : '';
    const key = decodeCapturedFormValue(rawKey);
    if (!key) return;
    if (isDynamicDidiBodyKey(key)) {
      ignoredCount++;
      return;
    }
    body[key] = decodeCapturedFormValue(rawValue);
  });

  const wsgsigKey = Object.keys(headers).find(key => key.toLowerCase() === 'wsgsig');
  if (!wsgsigKey || !headers[wsgsigKey]) throw new Error('抓包原文中没有找到 wsgsig');
  if (!body.token) throw new Error('抓包原文中没有找到 token');

  return { endpoint, headers, body, ignoredCount };
}

function readDidiSettingsForm() {
  return {
    city: cfgCity.value || '北京',
    didiEndpoint: (cfgDidiEndpoint.value || DEFAULT_SETTINGS.didiEndpoint).trim(),
    didiHeaders: parseSettingsJson(cfgDidiHeaders, '请求头参数'),
    didiBody: parseSettingsJson(cfgDidiBody, '请求体参数'),
  };
}

function fillSettingsForm() {
  cfgCity.value = appSettings.city || DEFAULT_SETTINGS.city;
  cfgDidiEndpoint.value = appSettings.didiEndpoint || DEFAULT_SETTINGS.didiEndpoint;
  cfgDidiRaw.value = '';
  cfgDidiHeaders.value = formatSettingsJson(appSettings.didiHeaders);
  cfgDidiBody.value = formatSettingsJson(appSettings.didiBody);
  didiTestResult.className = 'settings-test-result';
  didiTestResult.textContent = '';
  refreshDidiStatus();
}

function refreshDidiStatus() {
  if (!didiStatus) return;
  const customCount = Object.keys(appSettings.didiHeaders || {}).length +
    Object.keys(appSettings.didiBody || {}).length +
    (appSettings.didiEndpoint !== DEFAULT_SETTINGS.didiEndpoint ? 1 : 0);
  if (customCount > 0) {
    didiStatus.textContent = `自定义 ${customCount} 项`;
    didiStatus.className = 'settings-status is-configured';
  } else {
    didiStatus.textContent = '使用默认';
    didiStatus.className = 'settings-status';
  }
}

function openSettings() {
  fillSettingsForm();
  settingsModal.hidden = false;
  settingsModal.style.display = 'flex';
  refreshIcons();
}

function closeSettings() {
  settingsModal.hidden = true;
  settingsModal.style.display = 'none';
}
