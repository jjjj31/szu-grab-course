// select.js — 全页选课面板
// 在独立标签页打开（chrome-extension://…/select.html），自身不能直接请求选课网站（跨域），
// 而是通过 chrome.tabs.sendMessage 与选课网站标签页里的 content.js 通信。
// 课程列表来自导入的 CSV（common.js importCourseFiles），不再实时拉取。

let targetTabId = null;
let onSite = false;
let currentHost = '';
let currentType = TYPE_ORDER[0];
let selected = [];          // [{id, type, name}] 优先级顺序
let importedCourses = {};   // type -> list（来自导入的 CSV）
let config = { studentCode: '', electiveBatchCode: '', token: '' };

function logTip(msg) { $('tip').textContent = msg; }

// 找到当前打开着的选课网站标签页（优先用后台捕获的 courseTabId，找不到再全量查）
async function findCourseTab() {
  const s = await loadStorage(['courseTabId']);
  if (s.courseTabId != null) {
    try {
      const t = await chrome.tabs.get(s.courseTabId);
      if (t && t.url && SITE_RE.test(t.url)) return t;
    } catch (e) { /* 标签页已关闭 */ }
  }
  const all = await chrome.tabs.query({});
  return all.find((t) => t.url && SITE_RE.test(t.url)) || null;
}

function sendToContent(msg) {
  return new Promise((resolve) => {
    if (!targetTabId) return resolve({ ok: false, error: '未找到选课网站标签页，请先打开并登录选课网站' });
    chrome.tabs.sendMessage(targetTabId, msg, (resp) => {
      if (chrome.runtime.lastError) {
        return resolve({ ok: false, error: '无法连接选课网站页面：' + (chrome.runtime.lastError.message || '请刷新选课网站后重试') });
      }
      resolve(resp || { ok: false, error: '无响应' });
    });
  });
}

// ---------- 渲染 ----------
function renderStatus() {
  const parts = [];
  if (!onSite) {
    parts.push('<span class="bad">未打开选课网站</span>');
    $('openSite').classList.remove('hidden');
  } else {
    parts.push(`<span class="ok">已连接选课网站（${escapeHtml(currentHost)}）</span>`);
    $('openSite').classList.add('hidden');
  }
  if (config.studentCode && config.electiveBatchCode) {
    parts.push(`<span class="ok">学号 ${config.studentCode} · 批次已配置</span>`);
  } else {
    parts.push('<span class="warn">未捕获学号/批次码（登录后点进任一课程分类自动捕获）</span>');
  }
  parts.push(config.token
    ? '<span class="ok">token 已捕获</span>'
    : '<span class="warn">未捕获 token（登录后点进任一课程分类自动捕获）</span>');
  $('status').innerHTML = parts.join(' · ');
}

function renderTabs() {
  const el = $('typeTabs');
  el.innerHTML = '';
  for (const t of TYPE_ORDER) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = TYPE_LABELS[t];
    b.dataset.type = t;
    if (t === currentType) b.classList.add('active');
    b.addEventListener('click', () => switchType(t));
    el.appendChild(b);
  }
}

function remainingOf(c) {
  return c.classCapacity != null ? (c.classCapacity - (c.numberOfSelected || 0)) : null;
}

// 冲突信息来自选课系统接口自带的 tc.conflictDesc（checkConflict:'2' 时系统判定好），
// 非空即表示与已选课程存在冲突（时间/考试等，文案由系统给出）
function conflictOf(c) {
  return String((c && c.conflictDesc) || '').trim();
}

function renderTable() {
  const list = importedCourses[currentType] || [];
  const kw = ($('search').value || '').trim().toLowerCase();
  const onlyFree = $('onlyFree').checked;
  const hideSelected = $('hideSelected').checked;
  const hideConflict = $('hideConflict').checked;

  const rows = [];
  // 被筛掉的课程按原因计数：全部被筛掉时空态要写明原因，而不是看起来像没数据
  let nFull = 0, nSelected = 0, nConflict = 0;
  for (const c of list) {
    const remaining = remainingOf(c);
    if (kw &&
      !(c.courseName || '').toLowerCase().includes(kw) &&
      !(c.teacherName || '').toLowerCase().includes(kw) &&
      !String(c.teachingClassId).includes(kw)) continue;
    if (onlyFree && remaining != null && remaining <= 0) { nFull++; continue; }
    if (hideSelected && c.selected) { nSelected++; continue; }
    if (hideConflict && conflictOf(c)) { nConflict++; continue; }
    rows.push({ c, remaining });
  }

  const body = $('courseBody');
  body.innerHTML = '';
  $('courseEmpty').classList.add('hidden');
  if (!list.length) {
    $('courseEmpty').textContent = '暂无该类型课程数据，点「刷新课表」实时拉取，或「导入 CSV」加载';
    $('courseEmpty').classList.remove('hidden');
    return;
  }
  if (!rows.length) {
    // 数据在但被筛选全藏掉了：写明数量与原因，并提供一键放开
    const reasons = [];
    if (onlyFree && nFull) reasons.push(`满员 ${nFull} 门`);
    if (hideSelected && nSelected) reasons.push(`已选 ${nSelected} 门`);
    if (hideConflict && nConflict) reasons.push(`冲突 ${nConflict} 门`);
    $('courseEmpty').innerHTML = reasons.length
      ? `该类型共 ${list.length} 门课程，全部被筛选隐藏（${reasons.join('、')}）<button id="showAllBtn" class="secondary small">取消筛选，显示全部</button>`
      : '没有符合搜索条件的课程（试试换个关键词）';
    $('courseEmpty').classList.remove('hidden');
    return;
  }

  for (const { c, remaining } of rows) {
    const chosen = selected.some((s) => s.id === c.teachingClassId && s.type === currentType);
    const tr = document.createElement('tr');
    if (chosen) tr.classList.add('chosen');
    const capTxt = remaining == null ? '-' : `${remaining}/${c.classCapacity}`;
    const conflict = conflictOf(c);
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" data-id="${escapeHtml(c.teachingClassId)}" ${chosen ? 'checked' : ''}></td>
      <td class="col-name"><span class="c-name">${escapeHtml(c.courseName || '')}</span></td>
      <td class="col-teacher"><span class="c-teacher">${escapeHtml(c.teacherName || '')}</span></td>
      <td class="col-place"><span class="c-place">${escapeHtml(c.teachingPlace || '')}</span></td>
      <td class="col-cap"><span class="c-cap${remaining != null && remaining <= 0 ? ' full' : ''}">${escapeHtml(capTxt)}</span></td>
      <td class="col-conflict">${conflict
        ? `<span class="c-conflict" title="${escapeHtml(conflict)}">⚠ ${escapeHtml(conflict)}</span>`
        : '<span class="c-free">—</span>'}</td>
      <td class="col-id">${escapeHtml(c.teachingClassId || '')}</td>
      <td class="col-act"><button type="button" class="pick" data-act="pick" data-id="${escapeHtml(c.teachingClassId)}" data-type="${currentType}">立即选课</button></td>
    `;
    body.appendChild(tr);
  }
}

function renderSelected() {
  const el = $('selectedList');
  $('selectedCount').textContent = selected.length;
  el.innerHTML = '';
  if (!selected.length) {
    el.innerHTML = '<div class="empty">尚未选择课程，在左侧勾选或手动添加</div>';
    return;
  }
  selected.forEach((s, i) => {
    const div = document.createElement('div');
    div.className = 'sel-row';
    const c = (importedCourses[s.type] || []).find((x) => x.teachingClassId === s.id);
    const conflict = conflictOf(c);
    div.innerHTML = `
      <span class="idx">${i + 1}</span>
      <span class="s-name" title="${escapeHtml(s.name || s.id)}">${escapeHtml(s.name || s.id)}</span>
      ${conflict ? `<span class="s-conflict" title="${escapeHtml(conflict)}">⚠ 冲突</span>` : ''}
      <span class="s-type">${escapeHtml(TYPE_LABELS[s.type] || s.type)}</span>
      <span class="s-id">${escapeHtml(s.id)}</span>
      <button data-act="up" data-i="${i}" title="上移">↑</button>
      <button data-act="down" data-i="${i}" title="下移">↓</button>
      <button class="del" data-act="del" data-i="${i}" title="删除">✕</button>
    `;
    el.appendChild(div);
  });
}

function renderGrabState(gs) {
  const running = !!(gs && gs.running);
  $('startGrab').disabled = running;
  $('stopGrab').disabled = !running;
  const st = $('grabStatus');
  if (running) st.textContent = '抢课进行中…';
  else if (gs && gs.success) st.textContent = '已提交志愿 ✓';
  else if (gs && gs.lastError) st.textContent = '已停止：' + gs.lastError;
  else st.textContent = '空闲';

  const logs = (gs && gs.log) || [];
  const el = $('log');
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

// ---------- 课程数据 ----------
async function importCsv() {
  const files = $('fileInput').files;
  if (!files || !files.length) return;
  const res = await importCourseFiles(files);
  importedCourses = res.map;
  renderTable();
  renderSelected();
  logTip(`已导入 ${res.total} 条课程`);
  $('fileInput').value = '';
}

function switchType(type) {
  currentType = type;
  renderTabs();
  renderTable();
}

function toggleCourse(id, type, checked) {
  if (checked) {
    if (selected.some((s) => s.id === id && s.type === type)) return;
    const c = (importedCourses[type] || []).find((x) => x.teachingClassId === id);
    const name = c
      ? c.courseName + (c.teacherName ? `(${c.teacherName})` : '')
      : id;
    // 勾选了系统判定为冲突的课程时，先确认再入列
    const conflict = conflictOf(c);
    if (conflict && !window.confirm(`「${name}」与已选课程冲突：\n${conflict}\n\n仍要加入抢课列表吗？`)) {
      renderTable(); // 重建表格，让复选框回到未勾选状态
      return;
    }
    selected.push({ id, type, name });
  } else {
    selected = selected.filter((s) => !(s.id === id && s.type === type));
  }
  saveStorage({ selectedCourses: selected });
  renderSelected();
  renderTable();
}

// 立即选课：对单条课程直接提交一次志愿，不走抢课循环，结果实时反馈到提示栏
let picking = false;
async function pickNow(id, type, btn) {
  if (picking) { logTip('上一条选课请求还在处理，请稍候'); return; }
  if (!onSite) { logTip('请先打开并登录选课网站'); return; }
  const c = (importedCourses[type] || []).find((x) => x.teachingClassId === id);
  const name = c ? c.courseName + (c.teacherName ? `(${c.teacherName})` : '') : id;
  // 系统判定冲突的课程，先确认再提交（与勾选时一致）
  const conflict = conflictOf(c);
  if (conflict && !window.confirm(`「${name}」与已选课程冲突：\n${conflict}\n\n仍要立即选课吗？`)) return;

  picking = true;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '选课中…';
  logTip(`正在提交「${name}」的选课志愿…`);
  try {
    const resp = await sendToContent({ type: 'SELECT_NOW', payload: { teachingClassId: id, type } });
    if (!resp.ok) { logTip('选课失败：' + (resp.error || '')); return; }
    if (resp.submitted) logTip(`「${name}」添加选课志愿成功 ✓`);
    else if (resp.full) logTip(`「${name}」：该课程超过课容量（满员）`);
    else logTip(`「${name}」：${resp.respMsg || resp.text || '提交未成功'}`);
  } finally {
    picking = false;
    btn.disabled = false;
    btn.textContent = old;
  }
}

// ---------- 事件绑定 ----------
function bindEvents() {
  $('openSite').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://bkxk.webvpn.szu.edu.cn/' });
  });

  $('search').addEventListener('input', renderTable);
  $('onlyFree').addEventListener('change', renderTable);
  $('hideSelected').addEventListener('change', renderTable);
  $('hideConflict').addEventListener('change', renderTable);

  // 空态提示里的「取消筛选，显示全部」
  $('courseEmpty').addEventListener('click', (e) => {
    if (e.target.id !== 'showAllBtn') return;
    $('onlyFree').checked = false;
    $('hideSelected').checked = false;
    $('hideConflict').checked = false;
    renderTable();
  });
  $('importBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', importCsv);

  // 刷新课表：只重新拉取当前页签类型的课程，余量/已选/冲突以系统实时数据为准（比拉取全部快）
  $('refreshBtn').addEventListener('click', async () => {
    if (!onSite) { logTip('请先打开并登录选课网站'); return; }
    const btn = $('refreshBtn');
    btn.disabled = true;
    const label = TYPE_LABELS[currentType];
    logTip(`正在刷新「${label}」课程数据，请稍候（保持选课网站标签页打开）…`);
    try {
      const resp = await sendToContent({ type: 'QUERY_ALL_COURSES', payload: { type: currentType } });
      if (!resp.ok) { logTip('刷新失败：' + (resp.error || '')); return; }
      const list = resp.list || [];
      // 实时返回 0 条但本地已有数据时（选课未开放/会话失效常见），保留旧数据不清空
      const prev = importedCourses[currentType] || [];
      if (!list.length && prev.length) {
        logTip(`「${label}」实时返回 0 条（可能选课未开放或会话失效），已保留原有 ${prev.length} 条数据`);
        return;
      }
      importedCourses = Object.assign({}, importedCourses, { [currentType]: list });
      await saveStorage({ importedCourses });
      renderTable();
      renderSelected();
      logTip(`已刷新「${label}」，共 ${list.length} 条课程`);
    } finally {
      btn.disabled = false;
    }
  });

  // 实时拉取全部类型课程（走浏览器登录会话，webvpn 也适用）
  $('fetchAllBtn').addEventListener('click', async () => {
    if (!onSite) { logTip('请先打开并登录选课网站'); return; }
    const btn = $('fetchAllBtn');
    btn.disabled = true;
    logTip('正在拉取全部课程，请稍候（保持选课网站标签页打开）…');
    try {
      const resp = await sendToContent({ type: 'FETCH_ALL_COURSES' });
      if (!resp.ok) { logTip('拉取失败：' + (resp.error || '')); return; }
      importedCourses = resp.map || {};
      await saveStorage({ importedCourses });
      renderTable();
      renderSelected();
      logTip(`已拉取全部课程，共 ${resp.total} 条`);
    } finally {
      btn.disabled = false;
    }
  });

  // 把已拉取/导入的课程导出为 CSV 文件（data/*.csv 同款，可离线备份）
  $('exportCsvBtn').addEventListener('click', () => {
    const n = downloadCoursesAsCsv(importedCourses);
    logTip(n ? `已导出 ${n} 个 CSV 文件` : '没有可导出的课程数据，请先拉取或导入');
  });

  // 拖拽 CSV 文件到页面任意位置直接导入
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    importCourseFiles(files).then((res) => {
      importedCourses = res.map;
      renderTable();
      renderSelected();
      logTip(`已导入 ${res.total} 条课程`);
    });
  });

  $('courseBody').addEventListener('change', (e) => {
    if (!e.target.matches('input[type=checkbox]')) return;
    toggleCourse(e.target.dataset.id, currentType, e.target.checked);
  });
  $('courseBody').addEventListener('click', (e) => {
    const pick = e.target.closest('button.pick');
    if (pick) { pickNow(pick.dataset.id, pick.dataset.type, pick); return; }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'A' || e.target.closest('button')) return;
    const cb = e.target.closest('tr') && e.target.closest('tr').querySelector('input[type=checkbox]');
    if (cb) { cb.checked = !cb.checked; toggleCourse(cb.dataset.id, currentType, cb.checked); }
  });

  $('clearSelected').addEventListener('click', () => {
    if (!selected.length) return;
    selected = [];
    saveStorage({ selectedCourses: selected });
    renderSelected();
    renderTable();
    logTip('已清空待抢课程');
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
    renderTable();
  });

  $('manualAdd').addEventListener('click', () => {
    const id = $('manualId').value.trim();
    const type = $('manualType').value;
    const name = $('manualName').value.trim();
    if (!id) { logTip('请输入课程 ID'); return; }
    selected.push({ id, type, name: name || id });
    saveStorage({ selectedCourses: selected });
    renderSelected();
    renderTable();
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
  const tab = await findCourseTab();
  if (tab) {
    targetTabId = tab.id;
    onSite = true;
    try { currentHost = new URL(tab.url).hostname; } catch (e) { currentHost = '选课网站'; }
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

  renderStatus();
  renderTabs();
  renderTable();
  renderSelected();
  renderGrabState(s.grabState);
  bindEvents();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.grabState) renderGrabState(changes.grabState.newValue);
  if (changes.importedCourses) {
    importedCourses = changes.importedCourses.newValue || {};
    renderTable();
    renderSelected();
  }
  if (changes.selectedCourses) {
    selected = changes.selectedCourses.newValue || [];
    renderSelected();
    renderTable();
  }
  if (changes.studentCode || changes.electiveBatchCode || changes.configCapturedAt || changes.token) {
    loadStorage(['studentCode', 'electiveBatchCode', 'token']).then((st) => {
      config.studentCode = st.studentCode || '';
      config.electiveBatchCode = st.electiveBatchCode || '';
      config.token = st.token || '';
      renderStatus();
    });
  }
  if (changes.courseTabId) {
    chrome.tabs.get(changes.courseTabId.newValue).then((t) => {
      if (t && t.url && SITE_RE.test(t.url)) {
        targetTabId = t.id;
        onSite = true;
        try { currentHost = new URL(t.url).hostname; } catch (e) { currentHost = '选课网站'; }
        renderStatus();
      }
    }).catch(() => {});
  }
});

document.addEventListener('DOMContentLoaded', init);
