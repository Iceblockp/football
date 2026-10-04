import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiFixture, BookmakerSettings, Store } from '../shared/models';

const defaultViberSettings = (): BookmakerSettings => ({ mode: 'direct', playerWinDeduction: 3, playerLossRebate: 2, winTaxRate: 0, turnoverCommissionRate: 0 });
const defaultMessengerSettings = (): BookmakerSettings => ({ mode: 'summary', playerWinDeduction: 0, playerLossRebate: 0, winTaxRate: 5, turnoverCommissionRate: 2 });
const defaultAutomation = () => ({ enabled: false, pollMinutes: 10, windowStart: '00:00', windowEnd: '06:00', autoExportPdf: true, exportedReports: [] as string[] });
const emptyStore = (): Store => ({ teams: [], matches: [], bets: [], settings: { view: 'dai', bookmakerSettings: { viber: defaultViberSettings(), messenger: defaultMessengerSettings() }, automation: defaultAutomation() } });
let mainWindow: BrowserWindow | null = null;
let automationPowerBlocker: number | null = null;
const dataPath = () => join(app.getPath('userData'), 'football-pos.json');
const apiKeyPath = () => join(app.getPath('userData'), 'api-football-key.bin');
function trusted(event: Electron.IpcMainInvokeEvent) {
  const url = event.senderFrame?.url || '';
  if ((process.env.VITE_DEV_SERVER_URL && url.startsWith(process.env.VITE_DEV_SERVER_URL)) || (!process.env.VITE_DEV_SERVER_URL && url.startsWith('file:'))) return;
  throw new Error('Untrusted IPC sender');
}
async function loadStore(): Promise<Store> {
  if (!existsSync(dataPath())) return emptyStore();
  try {
    const raw = JSON.parse(await readFile(dataPath(), 'utf8')) as Partial<Store>;
    const legacySettings = raw.settings as (Partial<Store['settings']> & { daiLossRate?: number; daiWinRate?: number; commission?: number; winDeduction?: number }) | undefined;
    const savedBookmakers = legacySettings?.bookmakerSettings;
    const viber = savedBookmakers?.viber
      ? { ...defaultViberSettings(), ...savedBookmakers.viber }
      : { ...defaultViberSettings(), playerWinDeduction: legacySettings?.daiLossRate ?? 3, playerLossRebate: legacySettings?.daiWinRate ?? 2 };
    const messenger = { ...defaultMessengerSettings(), ...savedBookmakers?.messenger };
    return {
      ...emptyStore(),
      ...raw,
      teams: Array.isArray(raw.teams) ? raw.teams : [],
      matches: Array.isArray(raw.matches) ? raw.matches.map(match => ({ ...match, bookmaker: match.bookmaker ?? 'viber' })) : [],
      bets: Array.isArray(raw.bets) ? raw.bets.map(bet => ({ ...bet, bookmaker: bet.bookmaker ?? 'viber' })) : [],
      settings: { view: legacySettings?.view ?? 'dai', bookmakerSettings: { viber, messenger }, automation: { ...defaultAutomation(), ...legacySettings?.automation } },
    };
  } catch { return emptyStore(); }
}
async function saveStore(store: Store) { await mkdir(app.getPath('userData'), { recursive: true }); await writeFile(dataPath(), JSON.stringify(store, null, 2), 'utf8'); }
function syncAutomationRuntime(enabled: boolean) {
  if (enabled && automationPowerBlocker === null) automationPowerBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!enabled && automationPowerBlocker !== null) { powerSaveBlocker.stop(automationPowerBlocker); automationPowerBlocker = null; }
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled });
}
async function saveApiKey(key: string) {
  const clean = key.trim();
  if (!clean || !safeStorage.isEncryptionAvailable()) return false;
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(apiKeyPath(), safeStorage.encryptString(clean));
  return true;
}
async function loadApiKey() {
  if (!existsSync(apiKeyPath()) || !safeStorage.isEncryptionAvailable()) return '';
  try { return safeStorage.decryptString(await readFile(apiKeyPath())); } catch { return ''; }
}
function normalizeFixture(raw: any): ApiFixture {
  return {
    id: Number(raw.fixture?.id), kickoffAt: String(raw.fixture?.date ?? ''),
    home: String(raw.teams?.home?.name ?? ''), away: String(raw.teams?.away?.name ?? ''),
    league: String(raw.league?.name ?? ''), status: String(raw.fixture?.status?.short ?? ''),
    elapsed: raw.fixture?.status?.elapsed ?? null, homeScore: raw.goals?.home ?? null, awayScore: raw.goals?.away ?? null,
    fullTimeHome: raw.score?.fulltime?.home ?? null, fullTimeAway: raw.score?.fulltime?.away ?? null,
  };
}
async function apiFootball(path: string): Promise<ApiFixture[]> {
  const key = await loadApiKey();
  if (!key) throw new Error('API-Football key မထည့်ရသေးပါ။');
  const response = await fetch(`https://v3.football.api-sports.io${path}`, { headers: { 'x-apisports-key': key } });
  if (!response.ok) throw new Error(`API-Football HTTP ${response.status}`);
  const body = await response.json() as { errors?: Record<string, string> | string[]; response?: unknown[] };
  const errors = body.errors && (Array.isArray(body.errors) ? body.errors : Object.values(body.errors));
  if (errors?.length) throw new Error(errors.join(', '));
  return (Array.isArray(body.response) ? body.response : []).map(normalizeFixture);
}
async function renderPdf(target: string, html: string) {
  const report = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await report.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await report.webContents.printToPDF({ printBackground: true, pageSize: 'A4', landscape: true });
    await writeFile(target, pdf);
  } finally { report.destroy(); }
}
function createWindow() {
  mainWindow = new BrowserWindow({ width: 1440, height: 920, minWidth: 1080, minHeight: 700, backgroundColor: '#f5f7f3', webPreferences: { preload: join(__dirname, '../preload/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (process.env.VITE_DEV_SERVER_URL) void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else void mainWindow.loadFile(join(__dirname, '../../renderer/index.html'));
}
function csvCell(v: string) { return `"${v.replaceAll('"', '""')}"`; }
app.whenReady().then(() => {
  ipcMain.handle('data:load', async (e) => { trusted(e); const store = await loadStore(); syncAutomationRuntime(store.settings.automation.enabled); return store; });
  ipcMain.handle('data:save', async (e, store: Store) => { trusted(e); syncAutomationRuntime(store.settings.automation.enabled); await saveStore(store); });
  ipcMain.handle('report:csv', async (e, rows: string[][]) => {
    trusted(e); const target = await dialog.showSaveDialog({ title: 'Export Excel CSV', defaultPath: 'football-settlement.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (target.canceled || !target.filePath) return false;
    await writeFile(target.filePath, '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\n'), 'utf8'); return true;
  });
  ipcMain.handle('report:pdf', async (e, title: string, html: string) => {
    trusted(e); const target = await dialog.showSaveDialog({ title: 'Export PDF', defaultPath: `${title}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (target.canceled || !target.filePath) return false;
    await renderPdf(target.filePath, html); return true;
  });
  ipcMain.handle('report:pdf:auto', async (e, title: string, html: string) => {
    trusted(e);
    const folder = join(app.getPath('documents'), 'Football Bet POS Reports');
    await mkdir(folder, { recursive: true });
    const target = join(folder, `${title.replace(/[^a-zA-Z0-9._-]+/g, '-')}.pdf`);
    await renderPdf(target, html); return target;
  });
  ipcMain.handle('api-football:has-key', (e) => { trusted(e); return existsSync(apiKeyPath()); });
  ipcMain.handle('api-football:save-key', async (e, key: string) => { trusted(e); return saveApiKey(key); });
  ipcMain.handle('api-football:test', async (e) => {
    trusted(e);
    try { await apiFootball('/status'); return { ok: true, message: 'API-Football ချိတ်ဆက်မှု အောင်မြင်သည်။' }; }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'API ချိတ်ဆက်မှု မအောင်မြင်ပါ။' }; }
  });
  ipcMain.handle('api-football:fixtures-date', async (e, date: string) => { trusted(e); return apiFootball(`/fixtures?date=${encodeURIComponent(date)}&timezone=Asia%2FYangon`); });
  createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
