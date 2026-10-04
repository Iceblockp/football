import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../shared/models';

const api: DesktopApi = {
  data: {
    load: () => ipcRenderer.invoke('data:load'),
    save: (store) => ipcRenderer.invoke('data:save', store),
    exportCsv: (rows) => ipcRenderer.invoke('report:csv', rows),
    exportPdf: (title, html) => ipcRenderer.invoke('report:pdf', title, html),
    exportPdfAuto: (title, html) => ipcRenderer.invoke('report:pdf:auto', title, html),
  },
  apiFootball: {
    hasKey: () => ipcRenderer.invoke('api-football:has-key'),
    saveKey: (key) => ipcRenderer.invoke('api-football:save-key', key),
    test: () => ipcRenderer.invoke('api-football:test'),
    fixturesByDate: (date) => ipcRenderer.invoke('api-football:fixtures-date', date),
  },
};
contextBridge.exposeInMainWorld('footballPos', api);
