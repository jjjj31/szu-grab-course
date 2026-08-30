// popup.js — 插件面板逻辑
// 课程列表来自导入的 CSV（common.js importCourseFiles），不再实时拉取。

let targetTabId = null;
let onSite = false;
let currentHost = '';
let currentOrigin = '';
let selected = [];          // [{id, type, name}] 优先级顺序
let importedCourses = {};   // type -> list（来自导入的 CSV）
let config = { studentCode: '', electiveBatchCode: '', token: '' };

function logTip(msg) {
  $('tip').textContent = msg;
}

function sendToContent(msg) {
  return new Promise((resolve) => {
    if (!targetTabId) return resolve({ ok: false, error: '请先打开并登录选课网站' });
    chrome.tabs.sendMessage(targetTabId, msg, (resp) => {
      if (chrome.runtime.lastError) {
        return resolve({ ok: false, error: '无法连接页面，请刷新选课网站后重试' });
      }
      resolve(resp || { ok: false, error: '无响应' });
    });
  });
}

// ---------- 渲染 ----------
function renderStatus() {
  const el = $('status');
  const parts = [];
  if (!onSite) {
    parts.push('<span class="bad">未打开选课网站</span> <button id="openSite">打开选课网站</button>');
  } else {
    parts.push(`<span class="ok">已连接选课网站（${escapeHtml(currentHost)}）</span>`);
  }
  if (config.studentCode && config.electiveBatchCode) {
    parts.push(`<span class="ok">学号 ${config.studentCode} · 批次已配置</span>`);
  } else {
    parts.push('<span class="warn">未捕获学号/批次码（登录后点进任一课程分类自动捕获，或下方手动填写）</span>');
  }
  parts.push(config.token
    ? '<span class="ok">token 已捕获</span>'
    : '<span class="warn">未捕获 token（登录后点进任一课程分类自动捕获）</span>');
  el.innerHTML = parts.join(' · ');
  const openBtn = $('openSite');
  if (openBtn) openBtn.addEventListener('click', () => chrome.tabs.create({ url: 'https://bkxk.webvpn.szu.edu.cn/' }));
}

function renderSelected() {
  const el = $('selectedList');
  el.innerHTML = '';
  if (!selected.length) {
    el.innerHTML = '<div class="empty">尚未选择课程，请在课程列表勾选或手动添加</div>';
    return;
  }
  selected.forEach((s, i) => {
    const div = document.createElement('div');
    div.className = 'sel-row';
    div.innerHTML = `
      <span class="idx">${i + 1}</span>
      <span class="s-name">${escapeHtml(s.name || s.id)}</span>
      <span class="s-type">${escapeHtml(TYPE_LABELS[s.type] || s.type)}</span>
      <button data-act="up" data-i="${i}" title="上移">↑</button>
      <button data-act="down" data-i="${i}" title="下移">↓</button>
      <button data-act="del" data-i="${i}" title="删除">✕</button>
    `;
    el.appendChild(div);
  });
}

function renderCourseList(type) {
  const list = importedCourses[type] || [];
  const kw = ($('search').value || '').trim().toLowerCase();
  const filtered = kw
    ? list.filter((c) =>
        (c.courseName || '').toLowerCase().includes(kw) ||
        (c.teacherName || '').toLowerCase().includes(kw) ||
        String(c.teachingClassId).includes(kw))
    : list;
  const el = $('courseList');
  el.innerHTML = '';
  if (!list.length) { el.innerHTML = '<div class="empty">暂无该类型课程数据，请先「导入 CSV」</div>'; return; }
  if (!filtered.length) { el.innerHTML = '<div class="empty">无匹配结果</div>'; return; }

  for (const c of filtered) {
    const checked = selected.some((s) => s.id === c.teachingClassId && s.type === type);
    const cap = c.classCapacity != null
      ? `余量 ${c.classCapacity - (c.numberOfSelected || 0)}/${c.classCapacity}`
      : '';
    const row = document.createElement('label');
    row.className = 'course-row';
    row.innerHTML = `
      <input type="checkbox" data-id="${escapeHtml(c.teachingClassId)}" data-type="${type}" ${checked ? 'checked' : ''}>
      <span class="c-name">${escapeHtml(c.courseName || '')}</span>
      <span class="c-teacher">${escapeHtml(c.teacherName || '')}</span>
      <span class="c-place">${escapeHtml(c.teachingPlace || '')}</span>
      <span class="c-cap">${escapeHtml(cap)}</span>
      <span class="c-id">${escapeHtml(c.teachingClassId || '')}</span>
    `;
    el.appendChild(row);
  }
}

function renderGrabState(gs) {
  const el = $('log');
  const running = !!(gs && gs.running);
  $('startGrab').disabled = running;
  $('stopGrab').disabled = !running;
  const st = $('grabStatus');
  if (running) st.textContent = '抢课进行中…';
  else if (gs && gs.success) st.textContent = '已抢到课程 ✓';
  else if (gs && gs.lastError) st.textContent = '已停止：' + gs.lastError;
  else st.textContent = '空闲';

  const logs = (gs && gs.log) || [];
  el.innerHTML = '';
  if (!logs.length) { el.innerHTML = '<div class="empty">暂无日志</div>'; return; }
  for (const l of logs.slice(-200)) {
    const div = document.createElement('div');
    div.className = 'log-line';
    div.textContent = l.msg || '';
    el.appendChild(div);
  }
  el.scrollTop = el.scrollHeight;
}

// ---------- 导入课程 ----------
async function importCsv() {
  const files = $('fileInput').files;
  if (!files || !files.length) return;
  const res = await importCourseFiles(files);
  importedCourses = res.map;
  renderCourseList($('courseType').value);
  logTip(`已导入 ${res.total} 条课程`);
  $('fileInput').value = '';
}

// ---------- 事件绑定 ----------
function bindEvents() {
  $('openSelect').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('select.html') });
  });

  $('saveConfig').addEventListener('click', async () => {
    config.studentCode = $('studentCode').value.trim();
    config.electiveBatchCode = $('electiveBatchCode').value.trim();
    if (!config.studentCode || !config.electiveBatchCode) {
      logTip('学号和批次码都要填写');
      return;
    }
    await saveStorage({
      studentCode: config.studentCode,
      electiveBatchCode: config.electiveBatchCode,
      configCapturedAt: Date.now(),
    });
    renderStatus();
    logTip('配置已保存');
  });

  $('exportConfig').addEventListener('click', async () => {
    const s = await loadStorage(['studentCode', 'electiveBatchCode', 'token', 'siteUrl']);
    if (!s.studentCode || !s.electiveBatchCode) {
      logTip('还缺少捕获信息：请登录选课网站并点进任一课程分类，刷新后重试');
      return;
    }
    // 以当前打开的选课网站标签页为准（避免 siteUrl 过期后导错域名的 cookie）
    const url = String(currentOrigin || s.siteUrl || 'http://bkxk.szu.edu.cn/');
    // webvpn 的登录会话 cookie 存在门户域名（webvpn.szu.edu.cn / authserver 域）下，
    // 只导 bkxk 子域的话，requests 会被 webvpn 判定为未登录、重定向到登录页，
    // 所以把相关域名的 cookie 一起导出。
    const cookieUrls = [url];
    if (url.includes('webvpn')) {
      cookieUrls.push('https://webvpn.szu.edu.cn/');
      cookieUrls.push('https://authserver-443.webvpn.szu.edu.cn/');
    }
    const parts = [];
    const names = new Set();
    for (const cu of cookieUrls) {
      try {
        const cookies = await chrome.cookies.getAll({ url: cu });
        for (const c of cookies) {
          if (names.has(c.name)) continue;
          names.add(c.name);
          parts.push(`${c.name}=${c.value}`);
        }
      } catch (e) {
        // 无权限或读取失败，跳过该域
      }
    }
    const cookieStr = parts.join('; ');
    if (!cookieStr) {
      logTip('拿不到登录 cookie，请确认已登录选课网站并点进任一课程分类');
      return;
    }
    const cfg = {
      studentCode: String(s.studentCode),
      electiveBatchCode: String(s.electiveBatchCode),
      token: String(s.token || ''),
      cookie: cookieStr,
      url,
    };
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'auto_config.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    logTip('已导出 auto_config.json，保存到项目根目录后运行 download_data.py');
  });

  $('courseType').addEventListener('change', () => renderCourseList($('courseType').value));

  $('importBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', importCsv);
  $('search').addEventListener('input', () => renderCourseList($('courseType').value));

  // 实时拉取当前类型的课程（走浏览器登录会话，webvpn 也适用）
  $('fetchBtn').addEventListener('click', async () => {
    const type = $('courseType').value;
    if (!onSite) { logTip('请先打开并登录选课网站'); return; }
    const btn = $('fetchBtn');
    btn.disabled = true;
    logTip(`正在拉取${TYPE_LABELS[type]}，请稍候（保持选课网站标签页打开）…`);
    try {
      const resp = await sendToContent({ type: 'QUERY_ALL_COURSES', payload: { type } });
      if (!resp.ok) { logTip('拉取失败：' + (resp.error || '')); return; }
      const list = resp.list || [];
      if (!list.length) { logTip('该类型没有课程数据'); return; }
      importedCourses[type] = list;
      await saveStorage({ importedCourses });
      renderCourseList(type);
      logTip(`已拉取 ${list.length} 条${TYPE_LABELS[type]}`);
    } finally {
      btn.disabled = false;
    }
  });

  $('courseList').addEventListener('change', (e) => {
    if (!e.target.matches('input[type=checkbox]')) return;
    const id = e.target.dataset.id;
    const type = e.target.dataset.type;
    if (e.target.checked) {
      if (selected.some((s) => s.id === id && s.type === type)) return;
      const c = (importedCourses[type] || []).find((x) => x.teachingClassId === id);
      const name = c
        ? c.courseName + (c.teacherName ? `(${c.teacherName})` : '')
        : id;
      selected.push({ id, type, name });
    } else {
      selected = selected.filter((s) => !(s.id === id && s.type === type));
    }
    saveStorage({ selectedCourses: selected });
    renderSelected();
  });

  $('selectedList').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const i = Number(btn.dataset.i);
    const act = btn.dataset.act;
    if (act === 'del') selected.splice(i, 1);
    else if (act === 'up' && i > 0) [selected[i - 1], selected[i]] = [selected[i], selected[i - 1]];
    else if (act === 'down' && i < selected.length - 1) [selected[i + 1], selected[i]] = [selected[i], selected[i + 1]];
    else return;
    saveStorage({ selectedCourses: selected });
    renderSelected();
    renderCourseList($('courseType').value);
  });

  $('manualAdd').addEventListener('click', () => {
    const id = $('manualId').value.trim();
    const type = $('manualType').value;
    const name = $('manualName').value.trim();
    if (!id) { logTip('请输入课程 ID'); return; }
    selected.push({ id, type, name: name || id });
    saveStorage({ selectedCourses: selected });
    renderSelected();
    $('manualId').value = '';
    $('manualName').value = '';
    logTip('已添加');
  });

  $('startGrab').addEventListener('click', async () => {
    if (!selected.length) { logTip('请先选择要抢的课程'); return; }
    if (!onSite) { logTip('请先打开选课网站'); return; }
    const delay = Number($('delay').value) || 400;
    await saveStorage({ delay });
    const resp = await sendToContent({
      type: 'START_GRAB',
      payload: {
        courses: selected.map((s) => ({ teachingClassId: s.id, type: s.type, name: s.name })),
        delay,
      },
    });
    if (!resp.ok) { logTip('启动失败：' + (resp.error || '')); return; }
    logTip('已开始抢课（抢课期间请保持选课网站标签页打开）');
  });

  $('stopGrab').addEventListener('click', async () => {
    await sendToContent({ type: 'STOP_GRAB' });
    logTip('已发送停止指令');
  });

  $('viewResult').addEventListener('click', async () => {
    const resp = await sendToContent({ type: 'QUERY_RESULT' });
    if (!resp.ok) { logTip('查询失败：' + (resp.error || '')); return; }
    const list = resp.dataList || [];
    const el = $('log');
    el.innerHTML = '';
    if (!list.length) { el.innerHTML = '<div class="empty">暂无已选课程</div>'; return; }
    for (const o of list) {
      const div = document.createElement('div');
      div.className = 'log-line';
      div.textContent = `${o.courseName}（${o.teacherName}）${o.teachingPlace || ''}`;
      el.appendChild(div);
    }
  });
}

// ---------- 初始化 ----------
async function init() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (tab && tab.url && SITE_RE.test(tab.url)) {
    targetTabId = tab.id;
    onSite = true;
    try {
      const u = new URL(tab.url);
      currentHost = u.hostname;
      currentOrigin = u.origin + '/';
    } catch (e) { currentHost = '选课网站'; }
  }

  const s = await loadStorage([
    'studentCode', 'electiveBatchCode', 'token', 'configCapturedAt',
    'selectedCourses', 'delay', 'grabState', 'importedCourses',
  ]);
  config.studentCode = s.studentCode || '';
  config.electiveBatchCode = s.electiveBatchCode || '';
  config.token = s.token || '';
  selected = s.selectedCourses || [];
  importedCourses = s.importedCourses || {};
  if (s.delay != null) $('delay').value = s.delay;

  $('studentCode').value = config.studentCode;
  $('electiveBatchCode').value = config.electiveBatchCode;

  renderStatus();
  renderCourseList($('courseType').value);
  renderSelected();
  renderGrabState(s.grabState);
  bindEvents();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.grabState) renderGrabState(changes.grabState.newValue);
  if (changes.importedCourses) {
    importedCourses = changes.importedCourses.newValue || {};
    renderCourseList($('courseType').value);
  }
  if (changes.studentCode || changes.electiveBatchCode || changes.configCapturedAt || changes.token) {
    loadStorage(['studentCode', 'electiveBatchCode', 'token']).then((s) => {
      config.studentCode = s.studentCode || '';
      config.electiveBatchCode = s.electiveBatchCode || '';
      config.token = s.token || '';
      $('studentCode').value = config.studentCode;
      $('electiveBatchCode').value = config.electiveBatchCode;
      renderStatus();
    });
  }
});

document.addEventListener('DOMContentLoaded', init);
