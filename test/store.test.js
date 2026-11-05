'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { Store } = require('../src/main/store.js');
const C = require('../src/shared/calc.js');

const BASE = path.join(__dirname, '..', '.cache');
fs.mkdirSync(BASE, { recursive: true });
let seq = 0;

function tempDir() {
  const dir = path.join(BASE, 'store-test-' + process.pid + '-' + (++seq) + '-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function withStore(fn) {
  const dir = tempDir();
  try {
    const store = new Store(dir);
    store.load();
    fn(store, dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

function reload(dir) {
  const s = new Store(dir);
  s.load();
  return s;
}

test('首次初始化创建数据文件与当日备份', () => {
  withStore((store, dir) => {
    assert.equal(store.state.entries.length, 0);
    assert.equal(store.state.rates.length, 0);
    assert.ok(fs.existsSync(path.join(dir, 'data.json')));
    const day = C.dateKey(new Date()).replace(/-/g, '');
    assert.ok(fs.existsSync(path.join(dir, 'backups', 'data-' + day + '.json')));
    store.addEntry({ date: '2026-11-04', startTime: '09:00', endTime: '10:00' });
    assert.ok(fs.existsSync(path.join(dir, 'data.bak.json')));
  });
});

test('上下班打卡并持久化', () => {
  withStore((store, dir) => {
    const e = store.clockIn(new Date(2026, 10, 4, 9, 0, 0));
    assert.equal(e.startAt, '2026-11-04T09:00:00');
    assert.equal(e.endAt, null);
    assert.equal(store.clockOut(new Date(2026, 10, 4, 18, 30, 0)).endAt, '2026-11-04T18:30:00');
    const again = reload(dir);
    assert.equal(again.state.entries.length, 1);
    assert.equal(C.entryDurationMs(again.state.entries[0]), 9.5 * 3600 * 1000);
    assert.equal(C.entryDayKey(again.state.entries[0]), '2026-11-04');
  });
});

test('打卡状态机拒绝重复与空下班', () => {
  withStore((store) => {
    assert.throws(() => store.clockOut(new Date(2026, 10, 4, 18, 0, 0)), /没有进行中的打卡/);
    store.clockIn(new Date(2026, 10, 4, 9, 0, 0));
    assert.throws(() => store.clockIn(new Date(2026, 10, 4, 10, 0, 0)), /已有未下班的打卡/);
  });
});

test('补录、跨天与重叠校验', () => {
  withStore((store) => {
    store.addEntry({ date: '2026-11-04', startTime: '09:00', endTime: '12:00' });
    store.addEntry({ date: '2026-11-04', startTime: '13:00', endTime: '18:00' });
    assert.throws(() => store.addEntry({
      date: '2026-11-04', startTime: '11:00', endTime: '13:30'
    }), /重叠/);
    const night = store.addEntry({ date: '2026-11-04', startTime: '22:00', endTime: '02:00', nextDay: true });
    assert.equal(night.endAt, '2026-11-05T02:00:00');
    assert.throws(() => store.addEntry({
      date: '2026-11-04', startTime: '18:00', endTime: '09:00'
    }), /晚于上班时间/);
  });
});

test('下班打卡时检查与补录记录的重叠', () => {
  withStore((store) => {
    const open = store.clockIn(new Date(2026, 10, 4, 9, 0, 0));
    store.addEntry({ date: '2026-11-04', startTime: '10:00', endTime: '11:00' });
    assert.throws(() => store.clockOut(new Date(2026, 10, 4, 12, 0, 0)), /重叠/);
    store.deleteEntry(store.state.entries.filter((e) => e.id !== open.id)[0].id);
    assert.equal(store.clockOut(new Date(2026, 10, 4, 12, 0, 0)).endAt, '2026-11-04T12:00:00');
  });
});

test('时薪新增、覆盖、删除与校验', () => {
  withStore((store, dir) => {
    store.addRate({ effectiveFrom: '2026-11-01', rate: 25 });
    assert.deepEqual(store.state.rates.map((r) => r.rate), [25]);
    assert.throws(() => store.addRate({ effectiveFrom: '2026-11-01', rate: 30 }), /已有时薪记录/);
    store.addRate({ effectiveFrom: '2026-11-01', rate: 30, replace: true });
    assert.deepEqual(store.state.rates.map((r) => r.rate), [30]);
    store.addRate({ effectiveFrom: '2026-11-15', rate: 35 });
    assert.deepEqual(store.state.rates.map((r) => r.rate), [30, 35]);
    const reloaded = reload(dir);
    assert.equal(reloaded.state.rates.length, 2);
    reloaded.deleteRate(reloaded.state.rates[0].id);
    assert.deepEqual(reloaded.state.rates.map((r) => r.rate), [35]);
    assert.throws(() => store.addRate({ effectiveFrom: '2026-11-20', rate: 0 }), /大于 0/);
    assert.throws(() => store.addRate({ effectiveFrom: '2026-13-01', rate: 20 }), /生效日期/);
  });
});

test('工作记录备注设置与清除', () => {
  withStore((store) => {
    store.setNote('2026-11-04', '完成 A 模块联调');
    assert.equal(store.state.notes['2026-11-04'], '完成 A 模块联调');
    store.setNote('2026-11-04', '   ');
    assert.equal(store.state.notes['2026-11-04'], undefined);
    assert.throws(() => store.setNote('2026-02-30', 'x'), /日期格式/);
  });
});

test('上班地点设置与清除', () => {
  withStore((store, dir) => {
    store.setLocation('2026-11-04', '公司 3 楼');
    assert.equal(store.state.locations['2026-11-04'], '公司 3 楼');
    store.setLocation('2026-11-05', '客户现场');
    assert.equal(reload(dir).state.locations['2026-11-05'], '客户现场');
    store.setLocation('2026-11-04', '  ');
    assert.equal(store.state.locations['2026-11-04'], undefined);
    assert.throws(() => store.setLocation('2026-02-30', 'x'), /日期格式/);
  });
});

test('主数据损坏时回退到 data.bak.json 并提示', () => {
  const dir = tempDir();
  try {
    const s1 = new Store(dir);
    s1.load();
    s1.addEntry({ date: '2026-11-03', startTime: '09:00', endTime: '18:00' });
    s1.addEntry({ date: '2026-11-04', startTime: '09:00', endTime: '18:00' });
    fs.writeFileSync(path.join(dir, 'data.json'), '{ 这不是 JSON', 'utf8');
    const s2 = new Store(dir);
    s2.load();
    assert.ok(s2.loadWarnings.length > 0);
    assert.ok(s2.loadWarnings.some((w) => w.indexOf('备份') >= 0));
    assert.equal(s2.state.entries.length, 1);
    assert.ok(fs.readdirSync(dir).some((n) => n.indexOf('data.corrupt-') === 0));
    const fixed = reload(dir);
    assert.equal(fixed.state.entries.length, 1);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
});

test('导出与导入往返一致，非法文件被拒绝', () => {
  withStore((store, dir) => {
    store.addRate({ effectiveFrom: '2026-11-01', rate: 25 });
    store.addEntry({ date: '2026-11-03', startTime: '09:00', endTime: '18:00' });
    store.setNote('2026-11-03', '写代码');
    store.setLocation('2026-11-03', '公司');
    const text = store.exportJson();

    const dir2 = tempDir();
    try {
      const s2 = new Store(dir2);
      s2.load();
      s2.setWindowBounds({ x: 10, y: 20, width: 1200, height: 800 });
      s2.importJson(text);
      assert.equal(s2.state.entries.length, 1);
      assert.equal(s2.state.rates.length, 1);
      assert.equal(s2.state.notes['2026-11-03'], '写代码');
      assert.equal(s2.state.locations['2026-11-03'], '公司');
      assert.equal(s2.state.window.width, 1200);
      assert.throws(() => s2.importJson('not json'), /JSON/);
      assert.throws(() => s2.importJson('{"version":9}'), /版本/);
      const overlap = JSON.stringify({
        version: 1,
        entries: [
          { id: 'a', startAt: '2026-11-04T09:00:00', endAt: '2026-11-04T12:00:00' },
          { id: 'b', startAt: '2026-11-04T11:00:00', endAt: '2026-11-04T13:00:00' }
        ]
      });
      assert.throws(() => s2.importJson(overlap), /重叠/);
    } finally {
      try { fs.rmSync(dir2, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }
  });
});

test('备份列表与恢复', () => {
  withStore((store) => {
    store.addEntry({ date: '2026-11-03', startTime: '09:00', endTime: '18:00' });
    store.addEntry({ date: '2026-11-04', startTime: '09:00', endTime: '18:00' });
    const backups = store.listBackups();
    assert.ok(backups.some((b) => b.name === 'data.bak.json'));
    assert.ok(backups.some((b) => /^data-\d{8}\.json$/.test(b.name)));
    store.restoreBackup('data.bak.json');
    assert.equal(store.state.entries.length, 1);
    assert.throws(() => store.restoreBackup('../data.json'), /不合法/);
    assert.throws(() => store.restoreBackup('data-19990101.json'), /不存在/);
  });
});

test('清空全部数据保留窗口位置', () => {
  withStore((store) => {
    store.addRate({ effectiveFrom: '2026-11-01', rate: 25 });
    store.addEntry({ date: '2026-11-03', startTime: '09:00', endTime: '18:00' });
    store.setNote('2026-11-03', '备注');
    store.setWindowBounds({ x: 5, y: 6, width: 1100, height: 760 });
    store.clearAll();
    assert.equal(store.state.entries.length, 0);
    assert.equal(store.state.rates.length, 0);
    assert.deepEqual(store.state.notes, {});
    assert.equal(store.state.window.width, 1100);
    assert.ok(store.listBackups().some((b) => /^manual-/.test(b.name)));
  });
});

test('窗口位置持久化', () => {
  withStore((store, dir) => {
    store.setWindowBounds({ x: 100, y: 200, width: 1120, height: 780 });
    const again = reload(dir);
    assert.deepEqual(again.state.window, { x: 100, y: 200, width: 1120, height: 780 });
  });
});

test('打卡时间按整点归整，半点端口保留', () => {
  withStore((store) => {
    const e = store.clockIn(new Date(2026, 10, 4, 10, 5, 0));
    assert.equal(e.startAt, '2026-11-04T10:00:00');
    assert.equal(store.clockOut(new Date(2026, 10, 4, 18, 40, 0)).endAt, '2026-11-04T19:00:00');
    assert.equal(C.entryDurationMs(store.state.entries[0]), 9 * 3600 * 1000);
  });
  withStore((store) => {
    const e = store.clockIn(new Date(2026, 10, 4, 9, 30, 0));
    assert.equal(e.startAt, '2026-11-04T09:30:00');
    assert.equal(store.clockOut(new Date(2026, 10, 4, 12, 30, 0)).endAt, '2026-11-04T12:30:00');
    assert.equal(C.entryDurationMs(store.state.entries[0]), 3 * 3600 * 1000);
  });
});

test('归整后上下班同一整点记为 0 分钟', () => {
  withStore((store) => {
    store.clockIn(new Date(2026, 10, 4, 10, 5, 0));
    const e = store.clockOut(new Date(2026, 10, 4, 10, 10, 0));
    assert.equal(e.startAt, e.endAt);
    assert.equal(C.entryDurationMs(e), 0);
  });
});

test('补录与编辑时间也按整点归整', () => {
  withStore((store) => {
    const e = store.addEntry({ date: '2026-11-04', startTime: '09:10', endTime: '12:20' });
    assert.equal(e.startAt, '2026-11-04T09:00:00');
    assert.equal(e.endAt, '2026-11-04T12:00:00');
    store.updateEntry(e.id, { date: '2026-11-04', startTime: '09:30', endTime: '12:30' });
    assert.equal(store.state.entries[0].startAt, '2026-11-04T09:30:00');
    assert.equal(store.state.entries[0].endAt, '2026-11-04T12:30:00');
    assert.throws(() => store.addEntry({ date: '2026-11-05', startTime: '09:10', endTime: '09:20' }), /归整/);
  });
});

test('关闭到托盘设置默认开启并持久化', () => {
  withStore((store, dir) => {
    assert.equal(store.state.settings.closeToTray, true);
    store.setSettings({ closeToTray: false });
    assert.equal(reload(dir).state.settings.closeToTray, false);
    store.setSettings({ closeToTray: true });
    assert.equal(reload(dir).state.settings.closeToTray, true);
  });
});