import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../shared/models';

const emptyStore = (): Store => ({ teams: [], matches: [], bets: [], settings: { winDeduction: 5, commission: 2 } });
let mainWindow: BrowserWindow | null = null;
const dataPath = () => join(app.getPath('userData'), 'football-pos.json');
function trusted(event: Electron.IpcMainInvokeEvent) {
  const url = event.senderFrame?.url || '';
  if ((process.env.VITE_DEV_SERVER_URL && url.startsWith(process.env.VITE_DEV_SERVER_URL)) || (!process.env.VITE_DEV_SERVER_URL && url.startsWith('file:'))) return;
  throw new Error('Untrusted IPC sender');
}
async function loadStore(): Promise<Store> {
  if (!existsSync(dataPath())) return emptyStore();
  try {
    const raw = JSON.parse(await readFile(dataPath(), 'utf8')) as Partial<Store>;
    return { ...emptyStore(), ...raw, teams: Array.isArray(raw.teams) ? raw.teams : [], matches: Array.isArray(raw.matches) ? raw.matches : [], bets: Array.isArray(raw.bets) ? raw.bets : [], settings: { ...emptyStore().settings, ...raw.settings } };
  } catch { return emptyStore(); }
}
async function saveStore(store: Store) { await mkdir(app.getPath('userData'), { recursive: true }); await writeFile(dataPath(), JSON.stringify(store, null, 2), 'utf8'); }
function createWindow() {
  mainWindow = new BrowserWindow({ width: 1440, height: 920, minWidth: 1080, minHeight: 700, backgroundColor: '#f5f7f3', webPreferences: { preload: join(__dirname, '../preload/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (process.env.VITE_DEV_SERVER_URL) void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else void mainWindow.loadFile(join(__dirname, '../../renderer/index.html'));
}
function csvCell(v: string) { return `"${v.replaceAll('"', '""')}"`; }
app.whenReady().then(() => {
  ipcMain.handle('data:load', (e) => { trusted(e); return loadStore(); });
  ipcMain.handle('data:save', async (e, store: Store) => { trusted(e); await saveStore(store); });
  ipcMain.handle('report:csv', async (e, rows: string[][]) => {
    trusted(e); const target = await dialog.showSaveDialog({ title: 'Export Excel CSV', defaultPath: 'football-settlement.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (target.canceled || !target.filePath) return false;
    await writeFile(target.filePath, '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\n'), 'utf8'); return true;
  });
  ipcMain.handle('report:pdf', async (e, title: string, html: string) => {
    trusted(e); const target = await dialog.showSaveDialog({ title: 'Export PDF', defaultPath: `${title}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (target.canceled || !target.filePath) return false;
    const report = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await report.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await report.webContents.printToPDF({ printBackground: true, pageSize: 'A4', landscape: true });
    await writeFile(target.filePath, pdf); report.destroy(); return true;
  });
  createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
