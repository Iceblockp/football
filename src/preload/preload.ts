import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../shared/models';

const api: DesktopApi = {
  data: {
    load: () => ipcRenderer.invoke('data:load'),
    save: (store) => ipcRenderer.invoke('data:save', store),
    exportCsv: (rows) => ipcRenderer.invoke('report:csv', rows),
    exportPdf: (title, html) => ipcRenderer.invoke('report:pdf', title, html),
  },
};
contextBridge.exposeInMainWorld('footballPos', api);
