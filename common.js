// common.js — popup 与全页选课共用的工具函数与课程数据导入。
// 课程列表不再实时拉取（会被系统"请求过快"拦截、后台标签页也拉不全），
// 改为读取原 Python 脚本(download_data.py)下载的 CSV 文件来选课；抢课仍走实时接口。

// ---------- 通用 ----------
function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])
  );
}

function saveStorage(obj) { return chrome.storage.local.set(obj); }
function loadStorage(keys) { return chrome.storage.local.get(keys); }

const SITE_RE = /^https?:\/\/(bkxk\.szu\.edu\.cn|bkxk\.webvpn\.szu\.edu\.cn)(\/|$)/;

// ---------- 课程类型 ----------
const TYPE_ORDER = ['TJKC', 'FANKC', 'FAWKC', 'XGXK', 'TYKC', 'FXKC', 'MOOC'];
const TYPE_LABELS = {
  TJKC: '本班课程', FANKC: '方案内课程', FAWKC: '方案外课程',
  XGXK: '校公选课', TYKC: '体育课程', FXKC: '辅修课程', MOOC: '慕课',
};

// 从 CSV 文件名推断课程类型（对应 data 文件夹里的中文名）
function typeFromFilename(name) {
  for (const t of TYPE_ORDER) {
    if (name.indexOf(TYPE_LABELS[t]) !== -1) return t;
  }
  return null;
}

// ---------- CSV 解析 ----------
// 引号感知的字段拆分（老师名等字段可能含逗号）
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// 解析一段 CSV 文本 -> 课程对象数组。
// 兼容旧格式(4列：课程名,ID,地点,老师)、新格式(7列：+是否已选,已选人数,容量)
// 与扩展格式(8列：+冲突描述，来自选课系统 tc.conflictDesc)。
// 旧格式的地点字段可能含逗号（如"1-2节 教室A,3-4节 教室B"），会被拆成多列，
// 因此用"第5列是否为 True/False"来区分新旧格式；旧格式里老师恒为最后一个字段。
function parseCoursesCsv(text) {
  const list = [];
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const f = splitCsvLine(line.trim());
    if (f.length < 4) continue;
    const isNew = f.length >= 7 && /^(true|false)$/i.test(String(f[4]).trim());
    const c = isNew
      ? {
          courseName: (f[0] || '').trim(),
          teachingClassId: (f[1] || '').trim(),
          teachingPlace: (f[2] || '').trim(),
          teacherName: (f[3] || '').trim(),
          selected: /^true$/i.test(String(f[4]).trim()),
          numberOfSelected: parseInt(f[5], 10),
          classCapacity: parseInt(f[6], 10),
          conflictDesc: (f.length >= 8 ? f[7] : '').trim(),
        }
      : {
          courseName: (f[0] || '').trim(),
          teachingClassId: (f[1] || '').trim(),
          teachingPlace: f.slice(2, f.length - 1).join(',').trim(),
          teacherName: (f[f.length - 1] || '').trim(),
          selected: false,
          numberOfSelected: null,
          classCapacity: null,
          conflictDesc: '',
        };
    if (isNaN(c.numberOfSelected)) c.numberOfSelected = null;
    if (isNaN(c.classCapacity)) c.classCapacity = null;
    if (!c.courseName && !c.teachingClassId) continue;
    list.push(c);
  }
  return list;
}

// 导入用户选择的 CSV 文件，按类型合并进 importedCourses 存储。
// 返回 { map, total }：map 为各类型课程数据，total 为本次导入的课程总数。
async function importCourseFiles(files) {
  const s = await loadStorage(['importedCourses']);
  const map = s.importedCourses || {};
  let total = 0;
  for (const file of files) {
    const type = typeFromFilename(file.name);
    if (!type) continue;
    const text = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsText(file, 'utf-8');
    });
    const list = parseCoursesCsv(text);
    if (list.length) { map[type] = list; total += list.length; }
  }
  await saveStorage({ importedCourses: map });
  return { map, total };
}

// ---------- 课程导出为 CSV ----------
function csvField(v) {
  v = String(v == null ? '' : v);
  return /[,"\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

// 课程数组 -> CSV 文本（列序：课程名,ID,地点,老师,是否已选,已选人数,容量,冲突描述；无表头。
// 前 7 列与 download_data.py 一致，第 8 列为扩展的冲突描述，旧数据/旧脚本没有该列）
function coursesToCsvText(list) {
  const rows = list.map((c) => [
    c.courseName || '',
    c.teachingClassId || '',
    c.teachingPlace || '',
    c.teacherName || '',
    c.selected ? 'true' : 'false',
    c.numberOfSelected == null ? '' : c.numberOfSelected,
    c.classCapacity == null ? '' : c.classCapacity,
    c.conflictDesc || '',
  ]);
  return rows.map((r) => r.map(csvField).join(',')).join('\r\n');
}

// 把 importedCourses 各类型下载成 CSV 文件（data/*.csv 同款，供离线导入/备份）
function downloadCoursesAsCsv(map) {
  let n = 0;
  for (const type of TYPE_ORDER) {
    const list = map[type] || [];
    if (!list.length) continue;
    const text = '﻿' + coursesToCsvText(list); // BOM，Excel 打开不乱码
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = TYPE_LABELS[type] + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    n++;
  }
  return n;
}
