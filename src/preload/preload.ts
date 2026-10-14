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
  viber: {
    selectGroup: (groupName) => ipcRenderer.invoke('viber:select-group', groupName),
    sendFile: (groupName, filePath) => ipcRenderer.invoke('viber:send-file', groupName, filePath),
  },
  teamVoice: {
    save: (teamId, audio) => ipcRenderer.invoke('team-voice:save', teamId, audio),
    load: (teamId) => ipcRenderer.invoke('team-voice:load', teamId),
    remove: (teamId) => ipcRenderer.invoke('team-voice:remove', teamId),
  },
  commonVoice: {
    save: (key, audio) => ipcRenderer.invoke('common-voice:save', key, audio),
    load: (key) => ipcRenderer.invoke('common-voice:load', key),
    remove: (key) => ipcRenderer.invoke('common-voice:remove', key),
  },
};
contextBridge.exposeInMainWorld('footballPos', api);
