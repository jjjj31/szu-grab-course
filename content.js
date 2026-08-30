// content.js — 注入到 bkxk.szu.edu.cn 页面
// 所有请求走同源 fetch，登录 cookie 由浏览器自动携带，无需手动复制。

(function () {
  'use strict';

  // 请求地址跟随当前页面 origin，自动适配校园网 http 或校外 webvpn https
  const BASE = window.location.origin + '/';

  // 课程类型 -> 列表接口（对应原 downloads.py）
  const COURSE_TYPES = {
    TJKC:  { label: '本班课程',   endpoint: 'recommendedCourse' },
    FANKC: { label: '方案内课程', endpoint: 'programCourse' },
    FAWKC: { label: '方案外课程', endpoint: 'programCourse' },
    XGXK:  { label: '校公选课',   endpoint: 'programCourse' },
    TYKC:  { label: '体育课程',   endpoint: 'programCourse' },
    FXKC:  { label: '辅修课程',   endpoint: 'programCourse' },
    MOOC:  { label: '慕课',       endpoint: 'programCourse' },
  };

  let stopRequested = false;
  let grabRunning = false;
  let grabLog = [];
  let grabExtra = {};
  let autoFetchStarted = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- 基础请求 ----------
  async function fetchText(path, { body, token } = {}) {
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    };
    if (token) headers['token'] = token;
    const res = await fetch(BASE + path, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: body || undefined,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }

  // 获取 token（对应 login.py get_token）
  async function getToken() {
    const ts = String(Date.now());
    const text = await fetchText('xsxkapp/sys/xsxkapp/student/4/vcode.do', {
      body: new URLSearchParams({ timestamp: ts }).toString(),
    });
    const obj = JSON.parse(text);
    return (obj && obj.data && obj.data.token) || '';
  }

  async function loadConfig() {
    const s = await chrome.storage.local.get([
      'studentCode',
      'electiveBatchCode',
      'token',
    ]);
    return {
      studentCode: s.studentCode || '',
      electiveBatchCode: s.electiveBatchCode || '',
      token: s.token || '',
    };
  }

  // token 是系统识别登录态的依据。优先用网页捕获到的 token（前端自己请求用的，必然有效），
  // 捕获不到再实时调用 vcode.do。返回 { token, source } 便于报错时诊断用了哪个来源。
  async function ensureToken() {
    const cfg = await loadConfig();
    if (cfg.token) return { token: cfg.token, source: '网页捕获' };
    const fresh = await getToken().catch(() => '');
    if (fresh) chrome.storage.local.set({ token: fresh });
    return { token: fresh, source: fresh ? 'vcode实时' : '无' };
  }

  // ---------- 课程查询 ----------
  // 复刻原 downloads.py 的 querySetting 结构
  function buildQuerySetting(type, studentCode, batch, page) {
    if (type === 'TJKC') {
      return JSON.stringify({
        data: {
          studentCode, campus: '01', electiveBatchCode: batch, isMajor: '1',
          teachingClassType: 'TJKC', checkConflict: '2', checkCapacity: '2',
          queryContent: 'MOOC:2,',
        },
        pageSize: '10', pageNumber: page, order: '', orderBy: 'courseNumber',
      });
    }
    if (type === 'FANKC') {
      return JSON.stringify({
        data: {
          studentCode, campus: '01', electiveBatchCode: batch,
          teachingClassType: 'FANKC', checkConflict: '2', isMajor: '1',
          queryContent: 'MOOC:2,',
        },
        pageSize: '10', pageNumber: String(page), order: 'null', orderBy: 'courseNumber',
      });
    }
    return JSON.stringify({
      data: {
        studentCode, campus: '01', electiveBatchCode: batch, isMajor: '1',
        teachingClassType: type, checkConflict: '2', checkCapacity: '2',
        queryContent: 'MOOC:2,',
      },
      pageSize: '10', pageNumber: page, order: '', orderBy: 'courseNumber',
    });
  }

  function courseListUrl(type) {
    const info = COURSE_TYPES[type];
    return info && info.endpoint === 'recommendedCourse'
      ? 'xsxkapp/sys/xsxkapp/elective/recommendedCourse.do'
      : 'xsxkapp/sys/xsxkapp/elective/programCourse.do';
  }

  async function queryCoursePage(type, studentCode, batch, page, token) {
    const qs = buildQuerySetting(type, studentCode, batch, page);
    const body = new URLSearchParams({ querySetting: qs }).toString();
    const text = await fetchText(courseListUrl(type), { body, token });
    try {
      return JSON.parse(text);
    } catch (e) {
      // 返回 HTML 通常是未登录被重定向到登录页，给用户明确提示
      if (/<html|<doctype/i.test(text)) {
        throw new Error('选课系统返回了登录页（未登录或会话过期），请先在浏览器登录选课系统');
      }
      throw new Error('接口返回的不是 JSON：' + text.slice(0, 200));
    }
  }

  // 把 dataList 里每个课程的 tcList 摊平为一行一条教学班
  function flattenCourses(dataList) {
    const out = [];
    for (const course of dataList || []) {
      for (const tc of course.tcList || []) {
        out.push({
          courseName: course.courseName,
          teachingClassId: tc.teachingClassID,
          teachingPlace: tc.teachingPlace || '',
          teacherName: tc.teacherName || '',
          numberOfSelected: tc.numberOfSelected,
          classCapacity: tc.classCapacity,
          selected: course.selected,
          conflictDesc: tc.conflictDesc,
        });
      }
    }
    return out;
  }

  async function queryAllCourses(type, studentCode, batch) {
    const { token, source } = await ensureToken();
    const list = [];
    for (let page = 0; page < 300; page++) {
      const data = await queryCoursePage(type, studentCode, batch, page, token);
      const items = data && data.dataList;
      if (!items) {
        const msg = data && (data.message || data.msg || data.desc);
        if (msg) {
          throw new Error(`接口返回：${msg}（token${token ? ':' + token.slice(0, 8) + '…/' + source : '：未发送'}）`);
        }
        break;
      }
      if (items.length === 0) break;
      list.push(...flattenCourses(items));
      await sleep(600); // 翻页间隔，避免请求过快被拦截
    }
    return list;
  }

  // 静默拉取全部类型课程，写入 chrome.storage.local.importedCourses 供面板使用。
  // 配置就绪后自动触发，也可由面板 FETCH_ALL_COURSES 手动触发。
  async function fetchAllCourses() {
    const cfg = await loadConfig();
    if (!cfg.studentCode || !cfg.electiveBatchCode) {
      return { ok: false, error: '缺少学号/批次码，请先登录选课网站并点进任一课程分类' };
    }
    const types = Object.keys(COURSE_TYPES);
    const map = {};
    let total = 0;
    for (let i = 0; i < types.length; i++) {
      if (stopRequested) break;
      const type = types[i];
      const label = COURSE_TYPES[type].label;
      appendLog(`[拉取] 正在获取 ${label}（${i + 1}/${types.length}）…`);
      try {
        const list = await queryAllCourses(type, cfg.studentCode, cfg.electiveBatchCode);
        map[type] = list;
        total += list.length;
      } catch (e) {
        appendLog(`[错误] 获取 ${label} 失败：${e.message}`);
      }
      if (i < types.length - 1) await sleep(800); // 类型间稍停，降低被拦截概率
    }
    await chrome.storage.local.set({ importedCourses: map, coursesFetchedAt: Date.now() });
    appendLog(`[完成] 已拉取全部课程，共 ${total} 条`);
    return { ok: true, map, total };
  }

  // 配置就绪且近期未拉取过时，自动静默拉取（每次页面加载最多触发一次）。
  // 由 background 捕获学号/批次码触发（storage 变更），或页面加载时已有配置直接拉。
  async function maybeAutoFetch() {
    if (autoFetchStarted || grabRunning) return; // 只拉一次；抢课期间不抢占请求
    const cfg = await loadConfig();
    if (!cfg.studentCode || !cfg.electiveBatchCode) return;
    const s = await chrome.storage.local.get(['coursesFetchedAt']);
    if (s.coursesFetchedAt && Date.now() - s.coursesFetchedAt < 5 * 60 * 1000) return; // 5 分钟内拉过不再自动拉
    autoFetchStarted = true;
    fetchAllCourses();
  }

  // ---------- 抢课 ----------
  // 复刻 choose_course.py start_choose 的 addParam 结构
  function buildAddParam(studentCode, batch, classId, type) {
    return JSON.stringify({
      data: {
        operationType: '1',
        studentCode: String(studentCode),
        electiveBatchCode: String(batch),
        teachingClassId: String(classId),
        isMajor: '1',
        campus: '01',
        teachingClassType: String(type),
        chooseVolunteer: '1',
      },
    });
  }

  // 提交一条选课志愿并按 JSON 解析返回。startGrab 循环与「立即选课」共用。
  // 只有服务器明确受理（code 0/1 或成功文案）submitted 才为 true，full 表示满员。
  async function submitVolunteer(studentCode, batch, classId, type, token) {
    const addParam = buildAddParam(studentCode, batch, classId, type);
    const body = new URLSearchParams({ addParam }).toString();
    const text = await fetchText('xsxkapp/sys/xsxkapp/elective/volunteer.do', {
      body,
      token,
    });

    let code = '', respMsg = '';
    try {
      const j = JSON.parse(text);
      code = String((j && j.code) != null ? j.code : '');
      respMsg = (j && j.msg) || '';
    } catch (e) { /* 非 JSON，按原文判断 */ }

    const submitted = code !== '2' && (
      code === '0' || code === '1'
      || (respMsg ? respMsg.indexOf('添加选课志愿成功') !== -1
                  : text.indexOf('添加选课志愿成功') !== -1)
    );
    const full = text.indexOf('该课程超过课容量') !== -1 || respMsg.indexOf('超过课容量') !== -1;
    return { submitted, full, code, respMsg, text };
  }

  function persistGrabState(extra = {}) {
    grabExtra = Object.assign({}, grabExtra, extra);
    chrome.storage.local.set({
      grabState: Object.assign({ running: grabRunning, log: grabLog }, grabExtra),
    });
  }

  function appendLog(msg) {
    grabLog.push({ time: Date.now(), msg });
    persistGrabState();
  }

  async function startGrab({ courses, delay }) {
    stopRequested = false;
    grabLog = [];
    grabExtra = {};
    grabRunning = true;
    persistGrabState({ startedAt: Date.now(), success: false, lastError: '' });

    const cfg = await loadConfig();
    if (!cfg.studentCode || !cfg.electiveBatchCode) {
      appendLog('[错误] 缺少学号/批次码，请登录选课网站并点进任一课程分类自动捕获，或在面板手动填写');
      grabRunning = false;
      persistGrabState({ lastError: '缺少配置' });
      return;
    }

    // 实时获取当前会话 token（优先网页捕获，失败则 vcode 实时取）
    const { token } = await ensureToken();
    if (token) chrome.storage.local.set({ token });

    const delayMs = Math.max(0, Number(delay) || 0);
    let successCourse = null;

    try {
      outer: while (!stopRequested) {
        for (const c of courses) {
          if (stopRequested) break outer;
          // 按 JSON 解析判定是否真的提交了志愿。只有服务器明确受理（code 0/1 或成功文案）
          // 才记「已提交志愿」；其余如实记原始返回，不再把失败误报成“抢课成功”。
          let r;
          try {
            r = await submitVolunteer(cfg.studentCode, cfg.electiveBatchCode, c.teachingClassId, c.type, token);
          } catch (e) {
            appendLog(`[错误] ${c.name || c.teachingClassId}: ${e.message}`);
            await sleep(delayMs);
            continue;
          }
          if (r.submitted) {
            appendLog(`[已提交志愿] ${c.name || c.teachingClassId} 已添加选课志愿`);
            successCourse = successCourse || c; // 只记录第一个，但不终止，继续提交其余志愿
          } else if (r.full) {
            appendLog(`[满员] ${c.name || c.teachingClassId}：该课程超过课容量`);
          } else {
            appendLog(`[提示] ${c.name || c.teachingClassId}：${r.respMsg || r.text}`);
          }
          await sleep(delayMs);
        }
      }
    } finally {
      grabRunning = false;
      persistGrabState({ stoppedAt: Date.now(), success: !!successCourse });
    }
  }

  // 查询已选课程（对应 choose_course.py query_result）
  async function queryResult(studentCode, token) {
    const ts = Date.now();
    const text = await fetchText(
      `xsxkapp/sys/xsxkapp/elective/courseResult.do?timestamp=${ts}&studentCode=${studentCode}`,
      { token }
    );
    return JSON.parse(text);
  }

  // ---------- 消息处理 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case 'PING':
            return sendResponse({ ok: true, onSite: true });

          case 'GET_CONFIG': {
            const cfg = await loadConfig();
            return sendResponse({
              ok: true,
              ...cfg,
              hasConfig: !!(cfg.studentCode && cfg.electiveBatchCode),
            });
          }

          case 'GET_TOKEN':
            return sendResponse({ ok: true, token: await getToken() });

          case 'QUERY_COURSES': {
            const { type, page } = msg.payload || {};
            const c = await loadConfig();
            if (!c.studentCode || !c.electiveBatchCode) {
              return sendResponse({ ok: false, error: '缺少学号/批次码，请先登录选课网站并点进任一课程分类' });
            }
            const data = await queryCoursePage(
              type, c.studentCode, c.electiveBatchCode, page || 0, (await ensureToken()).token
            );
            return sendResponse({ ok: true, list: flattenCourses(data.dataList || []) });
          }

          case 'QUERY_ALL_COURSES': {
            const { type } = msg.payload || {};
            const c = await loadConfig();
            if (!c.studentCode || !c.electiveBatchCode) {
              return sendResponse({ ok: false, error: '缺少学号/批次码，请先登录选课网站并点进任一课程分类' });
            }
            const list = await queryAllCourses(type, c.studentCode, c.electiveBatchCode);
            return sendResponse({ ok: true, list });
          }

          case 'FETCH_ALL_COURSES':
            return sendResponse(await fetchAllCourses());

          case 'SELECT_NOW': {
            const { teachingClassId, type } = msg.payload || {};
            if (!teachingClassId) return sendResponse({ ok: false, error: '缺少课程 ID' });
            if (grabRunning) return sendResponse({ ok: false, error: '抢课进行中，请先停止抢课再手动选课' });
            const c = await loadConfig();
            if (!c.studentCode || !c.electiveBatchCode) {
              return sendResponse({ ok: false, error: '缺少学号/批次码，请先登录选课网站并点进任一课程分类' });
            }
            const { token } = await ensureToken();
            const r = await submitVolunteer(c.studentCode, c.electiveBatchCode, teachingClassId, type, token);
            // 非 JSON 且像登录页，说明会话过期，给出明确提示
            if (/<html|<doctype/i.test(r.text || '')) {
              return sendResponse({ ok: false, error: '选课系统返回了登录页（未登录或会话过期），请先在浏览器登录选课系统' });
            }
            return sendResponse({ ok: true, submitted: r.submitted, full: r.full, respMsg: r.respMsg, text: r.text });
          }

          case 'START_GRAB':
            startGrab(msg.payload || {}).catch((e) => {
              appendLog('[错误] ' + String((e && e.message) || e));
              grabRunning = false;
              persistGrabState({ lastError: String((e && e.message) || e) });
            });
            return sendResponse({ ok: true });

          case 'STOP_GRAB':
            stopRequested = true;
            return sendResponse({ ok: true });

          case 'QUERY_RESULT': {
            const c = await loadConfig();
            if (!c.studentCode) return sendResponse({ ok: false, error: '缺少学号' });
            const res = await queryResult(c.studentCode, (await ensureToken()).token);
            return sendResponse({ ok: true, dataList: res.dataList || [] });
          }

          default:
            return sendResponse({ ok: false, error: '未知命令: ' + msg.type });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true; // 保持消息端口打开，支持异步响应
  });

  // 配置就绪后自动静默拉取全部课程（用户点进课程分类 → background 捕获学号/批次 → 触发）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.studentCode || changes.electiveBatchCode) maybeAutoFetch();
  });
  maybeAutoFetch(); // 页面加载时若已有配置，也自动拉一次

  // 页面关闭/跳转时，若正在抢课则停止并落状态
  window.addEventListener('beforeunload', () => {
    if (grabRunning) {
      grabRunning = false;
      persistGrabState({ stoppedAt: Date.now(), lastError: '页面已关闭或跳转，抢课已停止' });
    }
  });
})();
