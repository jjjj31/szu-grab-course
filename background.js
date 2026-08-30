// background.js — Service Worker
// 拦截选课网站前端自己发出的请求，自动捕获 studentCode / electiveBatchCode / token，
// 写入 chrome.storage.local，供 content.js 和 popup 使用。

// 支持校园网 http 与校外 webvpn https 两个入口
const TARGETS = [
  'http://bkxk.szu.edu.cn/',
  'https://bkxk.szu.edu.cn/',
  'https://bkxk.webvpn.szu.edu.cn/',
];

// 从课程列表请求体（querySetting）中解析出学号和批次码
function isCourseQuery(url) {
  return (
    url &&
    (url.indexOf('recommendedCourse.do') !== -1 ||
      url.indexOf('programCourse.do') !== -1)
  );
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      if (details.method !== 'POST') return;
      if (!isCourseQuery(details.url)) return;
      const fd = details.requestBody && details.requestBody.formData;
      if (!fd) return;

      let qs = fd.querySetting;
      if (!qs) return;
      if (Array.isArray(qs)) qs = qs[0];

      const json = JSON.parse(qs);
      const d = json && json.data;
      if (d && d.studentCode && d.electiveBatchCode) {
        chrome.storage.local.set({
          studentCode: String(d.studentCode),
          electiveBatchCode: String(d.electiveBatchCode),
          configCapturedAt: Date.now(),
          courseTabId: details.tabId,
        });
      }
    } catch (e) {
      // 非目标请求或解析失败，忽略
    }
  },
  { urls: TARGETS.map((t) => t + '*') },
  ['requestBody']
);

// 从请求头中捕获 token（前端每次 API 请求都会带上 token 头），并记录当前站点 origin。
// cookie 不在这里抓：HttpOnly cookie 用 chrome.cookies 读取更可靠，导出配置时实时取。
let lastToken = '';
let lastSiteUrl = '';

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    try {
      const set = {};
      const headers = details.requestHeaders || [];
      for (const h of headers) {
        if ((h.name || '').toLowerCase() === 'token' && h.value && h.value !== lastToken) {
          lastToken = h.value;
          set.token = h.value;
        }
      }
      try {
        const origin = new URL(details.url).origin + '/';
        if (origin !== lastSiteUrl) {
          lastSiteUrl = origin;
          set.siteUrl = origin;
        }
      } catch (e) { /* 忽略 */ }
      if (Object.keys(set).length) chrome.storage.local.set(set);
    } catch (e) {
      // 忽略
    }
  },
  { urls: TARGETS.map((t) => t + '*') },
  ['requestHeaders']
);
