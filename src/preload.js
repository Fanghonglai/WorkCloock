'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function call(channel) {
  const args = Array.prototype.slice.call(arguments, 1);
  return ipcRenderer.invoke(channel, ...args).then(function (res) {
    if (!res || res.ok !== true) {
      const err = new Error((res && res.error) || '操作失败');
      err.handled = true;
      throw err;
    }
    return res.data;
  });
}

contextBridge.exposeInMainWorld('workclock', {
  info: function () { return call('app:info'); },
  getState: function () { return call('state:get'); },
  clockIn: function () { return call('clock:in'); },
  clockOut: function () { return call('clock:out'); },
  addEntry: function (input) { return call('entry:add', input); },
  updateEntry: function (id, input) { return call('entry:update', id, input); },
  deleteEntry: function (id) { return call('entry:delete', id); },
  setNote: function (dayKey, text) { return call('note:set', dayKey, text); },
  setLocation: function (dayKey, text) { return call('location:set', dayKey, text); },
  updateSettings: function (patch) { return call('settings:set', patch); },
  addRate: function (input) { return call('rate:add', input); },
  deleteRate: function (id) { return call('rate:delete', id); },
  listBackups: function () { return call('backup:list'); },
  restoreBackup: function (name) { return call('backup:restore', name); },
  exportData: function () { return call('data:export'); },
  importData: function () { return call('data:import'); },
  clearAll: function () { return call('data:clear'); },
  exportCsv: function (defaultName, text) { return call('csv:export', defaultName, text); },
  openDataDir: function () { return call('shell:openDataDir'); },
  minimize: function () { return call('window:minimize'); },
  close: function () { return call('window:close'); }
});