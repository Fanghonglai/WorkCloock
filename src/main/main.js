'use strict';

/* 工时打卡 —— Electron 主进程：窗口、数据存储、IPC */

const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Tray, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

const { Store } = require('./store.js');

const DATA_DIR = process.env.WORKCLOCK_DATA_DIR || path.join(app.getPath('appData'), 'work-clock');
const SMOKE = process.argv.indexOf('--smoke') >= 0;
const SMOKE_VIEW = process.env.WORKCLOCK_VIEW || 'today';

app.setName('work-clock');
app.setPath('userData', DATA_DIR);
if (process.platform === 'win32') app.setAppUserModelId('com.local.workclock');

let store = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;
let boundsTimer = null;

function sendBounds(win) {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
  const b = win.getBounds();
  try {
    store.setWindowBounds(b);
  } catch (e) { /* 位置保存失败不影响使用 */ }
}

function scheduleBoundsSave(win) {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(function () { sendBounds(win); }, 400);
}

function closeToTrayEnabled() {
  const st = store && store.getState();
  return !(st && st.settings && st.settings.closeToTray === false);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  try {
    const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
    let image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) image = image.resize({ width: 16, height: 16 });
    tray = new Tray(image);
    tray.setToolTip('工时打卡');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开主界面', click: showMainWindow },
      { type: 'separator' },
      { label: '退出', click: function () { isQuitting = true; app.quit(); } }
    ]));
    tray.on('click', showMainWindow);
    tray.on('double-click', showMainWindow);
  } catch (e) {
    console.error('TRAY_FAIL ' + (e && e.message ? e.message : e));
  }
}

function createWindow() {
  const saved = store.getState() && store.getState().window;
  const win = new BrowserWindow({
    width: saved && saved.width ? saved.width : 1180,
    height: saved && saved.height ? saved.height : 800,
    x: saved && Number.isFinite(saved.x) ? saved.x : undefined,
    y: saved && Number.isFinite(saved.y) ? saved.y : undefined,
    minWidth: 980,
    minHeight: 660,
    show: false,
    backgroundColor: '#f4f6fb',
    title: '工时打卡',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', function () {
    win.show();
  });
  win.on('resize', function () { scheduleBoundsSave(win); });
  win.on('move', function () { scheduleBoundsSave(win); });
  win.on('close', function (e) {
    clearTimeout(boundsTimer);
    sendBounds(win);
    if (!isQuitting && closeToTrayEnabled()) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', function () { mainWindow = null; });

  if (SMOKE) {
    win.webContents.once('did-finish-load', async function () {
      if (process.env.WORKCLOCK_TEST_TRAY === '1') {
        setTimeout(function () {
          const before = win.isVisible();
          win.close();
          setTimeout(function () {
            console.log('TRAY_TEST tray=' + (tray ? 'yes' : 'no') +
              ' visibleBefore=' + before + ' visibleAfter=' + win.isVisible() +
              ' destroyed=' + win.isDestroyed() +
              ' settings=' + JSON.stringify(store.getState().settings));
            isQuitting = true;
            app.quit();
          }, 500);
        }, 600);
        return;
      }
      let delay = Number(process.env.WORKCLOCK_SMOKE_DELAY || 1200);
      try {
        if (SMOKE_VIEW !== 'today') {
          await win.webContents.executeJavaScript(
            "(function(){var b=document.querySelector('.nav-item[data-view=\"" + SMOKE_VIEW + "\"]');if(b)b.click();})()"
          );
        }
        if (process.env.WORKCLOCK_SCRIPT) {
          await win.webContents.executeJavaScript(process.env.WORKCLOCK_SCRIPT);
          delay = Number(process.env.WORKCLOCK_SMOKE_DELAY || 900);
        }
      } catch (e) {
        console.error('SMOKE_SCRIPT_FAIL ' + (e && e.message ? e.message : e));
      }
      setTimeout(function () {
        const out = process.env.WORKCLOCK_SHOT;
        win.webContents.capturePage().then(function (image) {
          try {
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, image.toPNG());
            console.log('SMOKE_OK ' + out + ' ' + image.getSize().width + 'x' + image.getSize().height);
          } catch (e) {
            console.error('SMOKE_FAIL ' + e.message);
          }
          app.quit();
        }, function (e) {
          console.error('SMOKE_FAIL ' + e.message);
          app.quit();
        });
      }, delay);
    });
  }

  return win;
}

function ok(value) {
  return { ok: true, data: value };
}

function fail(err) {
  return { ok: false, error: err && err.message ? err.message : String(err) };
}

function handle(channel, fn) {
  ipcMain.handle(channel, async function (event) {
    const args = Array.prototype.slice.call(arguments, 1);
    try {
      return ok(await fn.apply(null, args));
    } catch (err) {
      return fail(err);
    }
  });
}

function registerIpc() {
  const state = function () { return store.getState(); };

  handle('app:info', function () {
    return {
      version: app.getVersion(),
      dataDir: store.dir,
      loadWarnings: store.loadWarnings
    };
  });
  handle('state:get', state);

  handle('clock:in', function () { store.clockIn(new Date()); return state(); });
  handle('clock:out', function () { store.clockOut(new Date()); return state(); });

  handle('entry:add', function (input) { store.addEntry(input); return state(); });
  handle('entry:update', function (id, input) { store.updateEntry(id, input); return state(); });
  handle('entry:delete', function (id) { store.deleteEntry(id); return state(); });

  handle('note:set', function (dayKey, text) { store.setNote(dayKey, text); return state(); });
  handle('location:set', function (dayKey, text) { store.setLocation(dayKey, text); return state(); });

  handle('settings:set', function (patch) { store.setSettings(patch); return state(); });

  handle('rate:add', function (input) { store.addRate(input); return state(); });
  handle('rate:delete', function (id) { store.deleteRate(id); return state(); });

  handle('backup:list', function () { return store.listBackups(); });
  handle('backup:restore', function (name) { store.restoreBackup(name); return state(); });

  handle('data:export', async function () {
    const stamp = new Date().toISOString().slice(0, 10);
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '导出工时数据',
      defaultPath: path.join(app.getPath('documents'), '工时打卡备份-' + stamp + '.json'),
      filters: [{ name: 'JSON 备份', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    store._safetyBackup('manual');
    fs.writeFileSync(res.filePath, store.exportJson(), 'utf8');
    return { canceled: false, filePath: res.filePath };
  });

  handle('data:import', async function () {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择要导入的备份文件',
      properties: ['openFile'],
      filters: [{ name: 'JSON 备份', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const text = fs.readFileSync(res.filePaths[0], 'utf8');
    store.importJson(text);
    return { canceled: false, filePath: res.filePaths[0], state: state() };
  });

  handle('data:clear', function () { store.clearAll(); return state(); });

  handle('csv:export', async function (defaultName, text) {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '导出 CSV',
      defaultPath: path.join(app.getPath('documents'), defaultName || '工时统计.csv'),
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    fs.writeFileSync(res.filePath, '\ufeff' + text, 'utf8');
    return { canceled: false, filePath: res.filePath };
  });

  handle('shell:openDataDir', async function () {
    const err = await shell.openPath(store.dir);
    if (err) throw new Error(err);
    return store.dir;
  });

  handle('window:minimize', function () { if (mainWindow) mainWindow.minimize(); });
  handle('window:close', function () { if (mainWindow) mainWindow.close(); });
}

function boot() {
  store = new Store(DATA_DIR);
  store.load();
  registerIpc();
  mainWindow = createWindow();
  createTray();
  if (store.loadWarnings.length) {
    mainWindow.webContents.once('did-finish-load', function () {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '数据已从备份恢复',
        message: store.loadWarnings.join('\n'),
        buttons: ['知道了']
      });
    });
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(boot);
  app.on('before-quit', function () { isQuitting = true; });
  app.on('window-all-closed', function () {
    if (isQuitting || !closeToTrayEnabled()) app.quit();
  });
}