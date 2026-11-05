'use strict';

/* 工时打卡 —— 数据持久化（纯 Node，主进程使用，可在测试中直接引用） */

const fs = require('fs');
const path = require('path');
const C = require('../shared/calc.js');

const VERSION = 1;
const MAX_BACKUPS = 14;
const ENTRIES_NAME = 'entries';
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

class StoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreError';
  }
}

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function defaultState() {
  return {
    version: VERSION,
    rates: [],
    entries: [],
    notes: {},
    locations: {},
    settings: { closeToTray: true },
    window: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function todayKey(d) {
  const dt = d || new Date();
  return C.dateKey(dt);
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') throw new StoreError('数据文件内容不是有效对象');
  const version = raw.version == null ? VERSION : raw.version;
  if (version !== VERSION) throw new StoreError('数据文件版本不支持：' + version);

  const state = defaultState();
  state.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : state.createdAt;
  state.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : state.createdAt;

  if (raw.window && typeof raw.window === 'object') {
    const w = raw.window;
    if (Number.isFinite(w.width) && Number.isFinite(w.height) && w.width >= 640 && w.height >= 480) {
      state.window = {
        x: Number.isFinite(w.x) ? Math.round(w.x) : undefined,
        y: Number.isFinite(w.y) ? Math.round(w.y) : undefined,
        width: Math.round(w.width),
        height: Math.round(w.height)
      };
    }
  }

  const rates = [];
  const seen = {};
  (Array.isArray(raw.rates) ? raw.rates : []).forEach(function (r) {
    if (!r || typeof r.effectiveFrom !== 'string' || !DAY_KEY_RE.test(r.effectiveFrom)) return;
    if (!C.parseDayKey(r.effectiveFrom)) return;
    if (typeof r.rate !== 'number' || !isFinite(r.rate) || r.rate <= 0 || r.rate > 10000) return;
    if (C.validateRateValue(r.rate)) return;
    if (seen[r.effectiveFrom]) return;
    seen[r.effectiveFrom] = true;
    rates.push({ id: typeof r.id === 'string' ? r.id : genId('r'), effectiveFrom: r.effectiveFrom, rate: r.rate });
  });
  rates.sort(function (a, b) { return a.effectiveFrom < b.effectiveFrom ? -1 : 1; });
  state.rates = rates;

  const entries = [];
  const ids = {};
  (Array.isArray(raw.entries) ? raw.entries : []).forEach(function (e) {
    if (!e || typeof e !== 'object') return;
    const start = C.parseLocal(e.startAt);
    if (!start) return;
    let endIso = null;
    if (e.endAt != null) {
      const end = C.parseLocal(e.endAt);
      if (!end) return;
      if (end.getTime() <= start.getTime()) return;
      if (end.getTime() - start.getTime() > C.MAX_MS) return;
      endIso = e.endAt;
    }
    let id = typeof e.id === 'string' && e.id ? e.id : genId('e');
    while (ids[id]) id = genId('e');
    ids[id] = true;
    entries.push({ id: id, startAt: e.startAt, endAt: endIso });
  });
  entries.sort(function (a, b) { return C.entryStartMs(a) - C.entryStartMs(b); });

  // 导入/载入时拒绝相互重叠的打卡（数据损坏的一种表现；进行中的段结束时间未知，不参与判定）
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j];
      if (a.endAt == null || b.endAt == null) continue;
      const as = C.entryStartMs(a), ae = C.entryStartMs(a) + C.entryDurationMs(a);
      const bs = C.entryStartMs(b), be = C.entryStartMs(b) + C.entryDurationMs(b);
      if (C.intervalsOverlap(as, ae, bs, be)) {
        throw new StoreError('数据中存在重叠的打卡记录：' + C.formatRange(a) + ' 与 ' + C.formatRange(b));
      }
    }
  }
  state.entries = entries;

  const notes = {};
  if (raw.notes && typeof raw.notes === 'object') {
    Object.keys(raw.notes).forEach(function (k) {
      if (!DAY_KEY_RE.test(k) || !C.parseDayKey(k)) return;
      const v = raw.notes[k];
      if (typeof v === 'string' && v.trim()) notes[k] = v;
    });
  }
  state.notes = notes;

  const locations = {};
  if (raw.locations && typeof raw.locations === 'object') {
    Object.keys(raw.locations).forEach(function (k) {
      if (!DAY_KEY_RE.test(k) || !C.parseDayKey(k)) return;
      const v = raw.locations[k];
      if (typeof v === 'string' && v.trim()) locations[k] = v;
    });
  }
  state.locations = locations;

  if (raw.settings && typeof raw.settings === 'object' &&
      typeof raw.settings.closeToTray === 'boolean') {
    state.settings.closeToTray = raw.settings.closeToTray;
  }
  return state;
}

class Store {
  constructor(dataDir) {
    if (!dataDir) throw new StoreError('缺少数据目录');
    this.dir = path.resolve(dataDir);
    this.dataFile = path.join(this.dir, 'data.json');
    this.bakFile = path.join(this.dir, 'data.bak.json');
    this.backupDir = path.join(this.dir, 'backups');
    this.state = null;
    this.loadWarnings = [];
  }

  _ensureDirs() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
  }

  _readJson(file) {
    const text = fs.readFileSync(file, 'utf8');
    return normalizeState(JSON.parse(text));
  }

  _latestBackupFile() {
    let names;
    try {
      names = fs.readdirSync(this.backupDir).filter(function (n) { return /^data-\d{8}\.json$/.test(n); });
    } catch (e) {
      return null;
    }
    if (!names.length) return null;
    names.sort();
    return path.join(this.backupDir, names[names.length - 1]);
  }

  load() {
    this._ensureDirs();
    this.loadWarnings = [];
    let state = null;
    if (!fs.existsSync(this.dataFile)) {
      state = defaultState();
      this.state = state;
      this._write(this.state);
      this._ensureDailyBackup();
      return this.state;
    }
    try {
      state = this._readJson(this.dataFile);
    } catch (err) {
      this.loadWarnings.push('主数据文件读取失败（' + err.message + '），正在尝试备份…');
      state = this._recover();
    }
    this.state = state || defaultState();
    this._ensureDailyBackup();
    return this.state;
  }

  _recover() {
    const candidates = [];
    if (fs.existsSync(this.bakFile)) candidates.push(this.bakFile);
    const latest = this._latestBackupFile();
    if (latest) candidates.push(latest);
    for (let i = 0; i < candidates.length; i++) {
      try {
        const st = this._readJson(candidates[i]);
        this.loadWarnings.push('已从备份恢复数据：' + path.basename(candidates[i]));
        // 保留损坏文件的副本，便于排查
        try {
          const bad = path.join(this.dir, 'data.corrupt-' + Date.now() + '.json');
          fs.copyFileSync(this.dataFile, bad);
        } catch (e) { /* 忽略 */ }
        this.state = st;
        this._write(st);
        return st;
      } catch (e2) {
        this.loadWarnings.push('备份 ' + path.basename(candidates[i]) + ' 也无法读取，继续尝试更早的备份…');
      }
    }
    this.loadWarnings.push('没有可用的备份，已创建空数据。');
    const empty = defaultState();
    try {
      const bad = path.join(this.dir, 'data.corrupt-' + Date.now() + '.json');
      if (fs.existsSync(this.dataFile)) fs.copyFileSync(this.dataFile, bad);
    } catch (e) { /* 忽略 */ }
    this.state = empty;
    this._write(empty);
    return empty;
  }

  _write(state) {
    this._ensureDirs();
    state.updatedAt = new Date().toISOString();
    const json = JSON.stringify(state, null, 2);
    const tmp = this.dataFile + '.tmp';
    fs.writeFileSync(tmp, json, 'utf8');
    try {
      if (fs.existsSync(this.dataFile)) {
        try { fs.copyFileSync(this.dataFile, this.bakFile); } catch (e) { /* 忽略 */ }
      }
      fs.renameSync(tmp, this.dataFile);
    } catch (err) {
      try { fs.rmSync(this.dataFile, { force: true }); } catch (e) { /* 忽略 */ }
      fs.renameSync(tmp, this.dataFile);
    }
    return state;
  }

  _ensureDailyBackup() {
    try {
      this._ensureDirs();
      const name = 'data-' + todayKey().replace(/-/g, '') + '.json';
      const target = path.join(this.backupDir, name);
      if (!fs.existsSync(target) && fs.existsSync(this.dataFile)) {
        fs.copyFileSync(this.dataFile, target);
      }
      this._pruneBackups();
    } catch (e) { /* 备份失败不阻断使用 */ }
  }

  _pruneBackups() {
    let names;
    try {
      names = fs.readdirSync(this.backupDir).filter(function (n) { return /^data-\d{8}\.json$/.test(n); });
    } catch (e) { return; }
    names.sort();
    while (names.length > MAX_BACKUPS) {
      const name = names.shift();
      try { fs.rmSync(path.join(this.backupDir, name), { force: true }); } catch (e) { /* 忽略 */ }
    }
  }

  getState() {
    return this.state;
  }

  _requireLoaded() {
    if (!this.state) throw new StoreError('数据尚未载入');
    return this.state;
  }

  _safetyBackup(prefix) {
    try {
      this._ensureDirs();
      const d = new Date();
      const name = prefix + '-' + todayKey(d).replace(/-/g, '') + '-' +
        C.pad2(d.getHours()) + C.pad2(d.getMinutes()) + C.pad2(d.getSeconds()) + '.json';
      if (fs.existsSync(this.dataFile)) {
        fs.copyFileSync(this.dataFile, path.join(this.backupDir, name));
      }
    } catch (e) { /* 忽略 */ }
  }

  _assertNoOverlap(startAt, endAt, excludeId) {
    const hit = C.findOverlap(this.state.entries, startAt, endAt, excludeId);
    if (hit) {
      throw new StoreError('与已有时段重叠：' + C.formatRange(hit) + '（' + C.formatDuration(C.entryDurationMs(hit)) + '）');
    }
  }

  clockIn(nowDate) {
    this._requireLoaded();
    const now = C.roundPunchDate(nowDate || new Date());
    const open = C.openEntry(this.state.entries);
    if (open) {
      throw new StoreError('已有未下班的打卡（' + C.formatTimeOfDay(open.startAt) + ' 上班），请先下班打卡或作废该记录');
    }
    const entry = { id: genId('e'), startAt: C.toLocalIso(now), endAt: null };
    this.state.entries.push(entry);
    this.state.entries = C.sortEntries(this.state.entries);
    this._write(this.state);
    return entry;
  }

  clockOut(nowDate) {
    this._requireLoaded();
    const now = C.roundPunchDate(nowDate || new Date());
    const open = C.openEntry(this.state.entries);
    if (!open) throw new StoreError('当前没有进行中的打卡，请先点“上班打卡”');
    const start = C.entryStartMs(open);
    const endMs = now.getTime();
    if (start != null && endMs < start) throw new StoreError('下班时间必须晚于上班时间');
    if (start != null && endMs - start > C.MAX_MS) throw new StoreError('单段工时超过 24 小时，请手动修正该记录');
    const endIso = C.toLocalIso(now);
    this._assertNoOverlap(open.startAt, endIso, open.id);
    open.endAt = endIso;
    this._write(this.state);
    return open;
  }

  addEntry(input) {
    this._requireLoaded();
    const v = C.validateEntryInput(input, { round: true });
    if (!v.ok) throw new StoreError(v.error);
    this._assertNoOverlap(v.startAt, v.endAt, null);
    const entry = { id: genId('e'), startAt: v.startAt, endAt: v.endAt };
    this.state.entries.push(entry);
    this.state.entries = C.sortEntries(this.state.entries);
    this._write(this.state);
    return entry;
  }

  updateEntry(id, input) {
    this._requireLoaded();
    const entry = this.state.entries.filter(function (e) { return e.id === id; })[0];
    if (!entry) throw new StoreError('找不到这条打卡记录');
    const v = C.validateEntryInput(input, { round: true });
    if (!v.ok) throw new StoreError(v.error);
    this._assertNoOverlap(v.startAt, v.endAt, id);
    entry.startAt = v.startAt;
    entry.endAt = v.endAt;
    this.state.entries = C.sortEntries(this.state.entries);
    this._write(this.state);
    return entry;
  }

  deleteEntry(id) {
    this._requireLoaded();
    const before = this.state.entries.length;
    this.state.entries = this.state.entries.filter(function (e) { return e.id !== id; });
    if (this.state.entries.length === before) throw new StoreError('找不到这条打卡记录');
    this._write(this.state);
    return true;
  }

  setNote(dayKey, text) {
    this._requireLoaded();
    if (!DAY_KEY_RE.test(dayKey) || !C.parseDayKey(dayKey)) throw new StoreError('日期格式不正确');
    const value = String(text == null ? '' : text);
    if (value.trim()) this.state.notes[dayKey] = value;
    else delete this.state.notes[dayKey];
    this._write(this.state);
    return this.state.notes[dayKey] || '';
  }

  setLocation(dayKey, text) {
    this._requireLoaded();
    if (!DAY_KEY_RE.test(dayKey) || !C.parseDayKey(dayKey)) throw new StoreError('日期格式不正确');
    const value = String(text == null ? '' : text);
    if (value.trim()) this.state.locations[dayKey] = value;
    else delete this.state.locations[dayKey];
    this._write(this.state);
    return this.state.locations[dayKey] || '';
  }

  addRate(input) {
    this._requireLoaded();
    const effectiveFrom = input && input.effectiveFrom;
    const rate = typeof input.rate === 'number' ? input.rate : parseFloat(input.rate);
    if (!DAY_KEY_RE.test(effectiveFrom || '') || !C.parseDayKey(effectiveFrom)) {
      throw new StoreError('请选择正确的生效日期');
    }
    const rateError = C.validateRateValue(rate);
    if (rateError) throw new StoreError(rateError);
    const exists = this.state.rates.filter(function (r) { return r.effectiveFrom === effectiveFrom; })[0];
    if (exists && !input.replace) {
      throw new StoreError(C.monthKeyOf(effectiveFrom) + ' 月 ' + effectiveFrom + ' 已有时薪记录，请选择其他生效日期或确认覆盖');
    }
    if (exists) exists.rate = rate;
    else this.state.rates.push({ id: genId('r'), effectiveFrom: effectiveFrom, rate: rate });
    this.state.rates.sort(function (a, b) { return a.effectiveFrom < b.effectiveFrom ? -1 : 1; });
    this._write(this.state);
    return this.state.rates;
  }

  deleteRate(id) {
    this._requireLoaded();
    const before = this.state.rates.length;
    this.state.rates = this.state.rates.filter(function (r) { return r.id !== id; });
    if (this.state.rates.length === before) throw new StoreError('找不到这条时薪记录');
    this._write(this.state);
    return this.state.rates;
  }

  setWindowBounds(bounds) {
    this._requireLoaded();
    if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return;
    this.state.window = {
      x: Number.isFinite(bounds.x) ? Math.round(bounds.x) : undefined,
      y: Number.isFinite(bounds.y) ? Math.round(bounds.y) : undefined,
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    };
    this._write(this.state);
  }

  setSettings(patch) {
    this._requireLoaded();
    const p = patch && typeof patch === 'object' ? patch : {};
    if (typeof p.closeToTray === 'boolean') this.state.settings.closeToTray = p.closeToTray;
    this._write(this.state);
    return this.state.settings;
  }

  exportJson() {
    this._requireLoaded();
    return JSON.stringify(this.state, null, 2);
  }

  importJson(text) {
    this._requireLoaded();
    let parsed;
    try {
      parsed = JSON.parse(String(text));
    } catch (e) {
      throw new StoreError('文件不是有效的 JSON 格式');
    }
    let next;
    try {
      next = normalizeState(parsed);
    } catch (e) {
      throw new StoreError('备份文件校验失败：' + e.message);
    }
    this._safetyBackup('import-before');
    const keepWindow = this.state.window;
    next.createdAt = parsed.createdAt || this.state.createdAt;
    next.window = keepWindow;
    this.state = next;
    this._write(this.state);
    return this.state;
  }

  listBackups() {
    this._requireLoaded();
    const list = [];
    try {
      if (fs.existsSync(this.bakFile)) {
        const st = fs.statSync(this.bakFile);
        list.push({ name: 'data.bak.json', location: 'main', size: st.size, mtime: st.mtime.toISOString() });
      }
    } catch (e) { /* 忽略 */ }
    try {
      const self = this;
      fs.readdirSync(this.backupDir).filter(function (n) {
        return /^(data-\d{8}|import-before-\d{8}-\d{6}|manual-\d{8}-\d{6})\.json$/.test(n);
      }).forEach(function (n) {
        const st = fs.statSync(path.join(self.backupDir, n));
        list.push({ name: n, location: 'backups', size: st.size, mtime: st.mtime.toISOString() });
      });
    } catch (e) { /* 忽略 */ }
    list.sort(function (a, b) { return a.mtime < b.mtime ? 1 : -1; });
    return list;
  }

  restoreBackup(name) {
    this._requireLoaded();
    if (!/^(data\.bak\.json|data-\d{8}\.json|import-before-\d{8}-\d{6}\.json|manual-\d{8}-\d{6}\.json)$/.test(name || '')) {
      throw new StoreError('备份文件名不合法');
    }
    const file = name === 'data.bak.json' ? this.bakFile : path.join(this.backupDir, name);
    if (!fs.existsSync(file)) throw new StoreError('备份文件不存在');
    let next;
    try {
      next = this._readJson(file);
    } catch (e) {
      throw new StoreError('备份文件读取失败：' + e.message);
    }
    this._safetyBackup('manual');
    const keepWindow = this.state.window;
    next.window = keepWindow;
    this.state = next;
    this._write(this.state);
    return this.state;
  }

  clearAll() {
    this._requireLoaded();
    this._safetyBackup('manual');
    const keepWindow = this.state.window;
    const empty = defaultState();
    empty.createdAt = this.state.createdAt;
    empty.window = keepWindow;
    this.state = empty;
    this._write(this.state);
    return this.state;
  }
}

module.exports = { Store, StoreError, defaultState, normalizeState, VERSION };