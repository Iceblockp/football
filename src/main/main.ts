import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, safeStorage } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ApiFixture, BookmakerSettings, Channel, CommonVoiceKey, Store, Team, TransferPackage, TransferPackageCore } from '../shared/models';

const defaultViberSettings = (): BookmakerSettings => ({ mode: 'direct', playerWinDeduction: 3, playerLossRebate: 2, winTaxRate: 0, turnoverCommissionRate: 0 });
const defaultMessengerSettings = (): BookmakerSettings => ({ mode: 'summary', playerWinDeduction: 0, playerLossRebate: 0, winTaxRate: 5, turnoverCommissionRate: 2 });
const defaultAutomation = () => ({ enabled: false, pollMinutes: 10, windowStart: '00:00', windowEnd: '06:00', autoExportPdf: true, exportedReports: [] as string[] });
const defaultViberDelivery = () => ({ groupName: '', autoSend: false, sentReports: [] as string[], pendingReports: [] as string[], lastStatus: 'idle' as const, lastMessage: '' });
const defaultVoiceConfirmation = () => ({ enabled: true, rate: 1.35, commonClips: [] as CommonVoiceKey[] });
const defaultChannels = (): Channel[] => [
  { id: 'viber', name: 'Viber ဒိုင်', enabled: true },
  { id: 'messenger', name: 'Messenger ဒိုင်', enabled: true },
  { id: 'channel-3', name: 'Channel 3', enabled: true },
  { id: 'channel-4', name: 'Channel 4', enabled: true },
];
const defaultBookmakerSettings = (): Record<string, BookmakerSettings> => ({
  viber: defaultViberSettings(),
  messenger: defaultMessengerSettings(),
  'channel-3': defaultMessengerSettings(),
  'channel-4': defaultMessengerSettings(),
});
const emptyStore = (): Store => ({ teams: [], matches: [], bets: [], settings: { view: 'dai', theme: 'light', voiceConfirmation: defaultVoiceConfirmation(), channels: defaultChannels(), bookmakerSettings: defaultBookmakerSettings(), automation: defaultAutomation(), viberDelivery: defaultViberDelivery() } });
const execFileAsync = promisify(execFile);
let mainWindow: BrowserWindow | null = null;
let automationPowerBlocker: number | null = null;
const dataPath = () => join(app.getPath('userData'), 'football-pos.json');
const apiKeyPath = () => join(app.getPath('userData'), 'api-football-key.bin');
const teamVoiceFolder = () => join(app.getPath('userData'), 'team-voice');
const commonVoiceFolder = () => join(app.getPath('userData'), 'common-voice');
const commonVoiceKeys = new Set<CommonVoiceKey>(['body', 'over', 'down', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'k', 'w', 'l', 'm']);
function teamVoicePath(teamId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(teamId)) throw new Error('Invalid team id');
  return join(teamVoiceFolder(), `${teamId}.webm`);
}
function commonVoicePath(key: CommonVoiceKey) {
  if (!commonVoiceKeys.has(key)) throw new Error('Invalid common voice key');
  return join(commonVoiceFolder(), `${key}.webm`);
}
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
    const savedChannels = Array.isArray(legacySettings?.channels) ? legacySettings.channels : [];
    const savedChannelMap = new Map(savedChannels.filter(channel => channel && typeof channel.id === 'string').map(channel => [channel.id, channel]));
    const channels = [
      ...defaultChannels().map(channel => ({ ...channel, ...savedChannelMap.get(channel.id) })),
      ...savedChannels.filter(channel => !defaultChannels().some(item => item.id === channel.id)),
    ];
    const bookmakerSettings: Record<string, BookmakerSettings> = {
      ...defaultBookmakerSettings(),
      ...savedBookmakers,
      viber,
      messenger,
      'channel-3': { ...messenger, ...savedBookmakers?.['channel-3'] },
      'channel-4': { ...messenger, ...savedBookmakers?.['channel-4'] },
    };
    channels.forEach(channel => { bookmakerSettings[channel.id] = { ...defaultMessengerSettings(), ...bookmakerSettings[channel.id] }; });
    const rawTeams = Array.isArray(raw.teams) ? raw.teams : [];
    const legacyTeams = rawTeams.some(team => !team.bookmaker);
    const teams: Team[] = legacyTeams
      ? rawTeams.flatMap(team => team.bookmaker
        ? [team as Team]
        : channels.map((channel, index) => ({ ...team, id: index === 0 ? team.id : `${team.id}-${channel.id}`.replace(/[^a-zA-Z0-9-]+/g, '-'), bookmaker: channel.id }))) as Team[]
      : rawTeams as Team[];
    if (legacyTeams) {
      for (const team of rawTeams.filter(team => !team.bookmaker && team.hasVoiceClip)) {
        for (const clone of teams.filter(item => item.name === team.name && item.id !== team.id)) {
          try { await mkdir(teamVoiceFolder(), { recursive: true }); await copyFile(teamVoicePath(team.id), teamVoicePath(clone.id)); } catch { /* missing legacy clip */ }
        }
      }
    }
    const migrated: Store = {
      ...emptyStore(),
      ...raw,
      teams,
      matches: Array.isArray(raw.matches) ? raw.matches.map(match => ({ ...match, bookmaker: match.bookmaker ?? 'viber' })) : [],
      bets: Array.isArray(raw.bets) ? raw.bets.map(bet => ({ ...bet, bookmaker: bet.bookmaker ?? 'viber' })) : [],
      settings: { view: legacySettings?.view ?? 'dai', theme: legacySettings?.theme === 'dark' ? 'dark' : 'light', voiceConfirmation: { ...defaultVoiceConfirmation(), ...legacySettings?.voiceConfirmation }, channels, bookmakerSettings, automation: { ...defaultAutomation(), ...legacySettings?.automation }, viberDelivery: { ...defaultViberDelivery(), ...legacySettings?.viberDelivery } },
    };
    if (legacyTeams) {
      try { await writeFile(dataPath(), JSON.stringify(migrated, null, 2), 'utf8'); }
      catch { /* keep the migrated in-memory store even if persistence must wait for the next save */ }
    }
    return migrated;
  } catch { return emptyStore(); }
}
async function saveStore(store: Store) { await mkdir(app.getPath('userData'), { recursive: true }); await writeFile(dataPath(), JSON.stringify(store, null, 2), 'utf8'); }
function syncAutomationRuntime(enabled: boolean) {
  // Viber delivery drives the desktop UI, so the display must remain awake as
  // well as the Electron process. The OS restores its normal sleep policy when
  // this blocker is stopped or the app quits.
  if (enabled && automationPowerBlocker === null) automationPowerBlocker = powerSaveBlocker.start('prevent-display-sleep');
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
    homeId: Number(raw.teams?.home?.id ?? 0), awayId: Number(raw.teams?.away?.id ?? 0),
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
const viberGroupSearchScript = `on run argv
set groupName to item 1 of argv
tell application id "com.viber.osx" to activate
delay 1
tell application "System Events"
  tell process "Viber"
    set frontmost to true
    key code 53
    delay 0.3
    try
      set searchField to first text field of window 1 whose description is "Search..."
    on error
      error "Viber conversation search field ကို မတွေ့ပါ။"
    end try
    -- Viber exposes AXRaise (not AXPress) for its Qt search control. Raising the
    -- element is the same accessibility action a native element click uses.
    perform action "AXRaise" of searchField
    delay 0.3
    keystroke "a" using {command down}
    key code 51
    -- A real paste event is required: directly setting Viber's AX value changes
    -- the accessibility tree but does not update the QML search results.
    set the clipboard to groupName
    keystroke "v" using {command down}
    delay 0.5
    if value of searchField is not groupName then
      -- If Viber left focus in another field, undo only our paste and stop
      -- before Return can open or send anything.
      keystroke "z" using {command down}
      error "Viber search value မကိုက်ညီပါ။ PDF မပို့ပါ။"
    end if
    delay 1.5
    -- Qt does not expose its search-result row to Accessibility. Return the
    -- centre of the single first result so Node can issue a native CGEvent click.
    set {searchX, searchY} to position of searchField
    return ((searchX + 106) as text) & "," & ((searchY + 160) as text)
  end tell
end tell
end run`;
const viberNativeClickScript = `ObjC.import("CoreGraphics");
function run(argv) {
  const point = $.CGPointMake(Number(argv[0]), Number(argv[1]));
  const down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, point, $.kCGMouseButtonLeft);
  const up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, point, $.kCGMouseButtonLeft);
  $.CGEventPost($.kCGHIDEventTap, down);
  delay(0.05);
  $.CGEventPost($.kCGHIDEventTap, up);
}`;
const windowsViberAutomationScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FootballPosNative {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
'@

function Click-Point([double]$x, [double]$y) {
  [FootballPosNative]::SetCursorPos([int]$x, [int]$y) | Out-Null
  Start-Sleep -Milliseconds 80
  [FootballPosNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [FootballPosNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Get-ViberProcess {
  $process = Get-Process -Name Viber -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($process) { return $process }
  $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $paths = @(
    (Join-Path $env:LOCALAPPDATA 'Viber\Viber.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Viber\Viber.exe'),
    (Join-Path $env:ProgramFiles 'Viber\Viber.exe')
  ) | Where-Object { $_ -and (Test-Path $_) }
  if ($programFilesX86) {
    $x86Path = Join-Path $programFilesX86 'Viber\Viber.exe'
    if (Test-Path $x86Path) { $paths += $x86Path }
  }
  if ($paths.Count) { Start-Process -FilePath $paths[0] | Out-Null }
  else {
    try { Start-Process 'viber://' | Out-Null }
    catch { throw 'Viber Desktop ကို Windows တွင် မတွေ့ပါ။ Viber ကို install/open လုပ်ထားပါ။' }
  }
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    $process = Get-Process -Name Viber -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($process) { return $process }
  }
  throw 'Viber window မပွင့်လာပါ။'
}

function Get-Rectangle($element) {
  try {
    $rect = $element.Current.BoundingRectangle
    if ($rect.Width -gt 1 -and $rect.Height -gt 1) { return $rect }
  } catch {}
  return $null
}

function Click-Element($element) {
  $rect = Get-Rectangle $element
  if (-not $rect) { throw 'Viber UI element နေရာကို မသတ်မှတ်နိုင်ပါ။' }
  Click-Point ($rect.Left + ($rect.Width / 2)) ($rect.Top + ($rect.Height / 2))
}

function Find-Descendants($root, $controlType) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    $controlType
  )
  return $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Select-ViberGroup($process, [string]$groupName) {
  $process.Refresh()
  [FootballPosNative]::ShowWindow($process.MainWindowHandle, 9) | Out-Null
  [FootballPosNative]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 500
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
  if (-not $root) { throw 'Viber window ကို Windows UI Automation ဖြင့် မဖတ်နိုင်ပါ။' }
  $windowRect = Get-Rectangle $root
  if (-not $windowRect) { throw 'Viber window နေရာကို မသတ်မှတ်နိုင်ပါ။' }

  $searchCandidates = @()
  foreach ($edit in (Find-Descendants $root ([System.Windows.Automation.ControlType]::Edit))) {
    $rect = Get-Rectangle $edit
    if (-not $rect) { continue }
    $label = (($edit.Current.Name + ' ' + $edit.Current.AutomationId + ' ' + $edit.Current.HelpText)).ToLowerInvariant()
    $score = 0
    if ($label -match 'search') { $score += 100 }
    if ($rect.Left -lt ($windowRect.Left + $windowRect.Width * 0.45)) { $score += 20 }
    if ($rect.Top -lt ($windowRect.Top + $windowRect.Height * 0.30)) { $score += 20 }
    if ($score -gt 20) { $searchCandidates += [pscustomobject]@{ Element = $edit; Score = $score; Top = $rect.Top } }
  }
  $search = $searchCandidates | Sort-Object Score -Descending | Select-Object -First 1
  $searchRect = $null
  if ($search) {
    $searchRect = Get-Rectangle $search.Element
    Click-Element $search.Element
  }
  else {
    Click-Point ($windowRect.Left + [Math]::Min(180, $windowRect.Width * 0.16)) ($windowRect.Top + 35)
    Start-Sleep -Milliseconds 150
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    $focusedRect = Get-Rectangle $focused
    if (-not $focusedRect -or $focusedRect.Left -gt ($windowRect.Left + $windowRect.Width * 0.48) -or $focusedRect.Top -gt ($windowRect.Top + $windowRect.Height * 0.30)) {
      throw 'Viber conversation search field ကို focus မရပါ။ PDF မပို့ပါ။'
    }
  }
  Start-Sleep -Milliseconds 150
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  [System.Windows.Forms.Clipboard]::SetText($groupName)
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 1400

  $nameCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $groupName
  )
  $exact = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $nameCondition)
  $rows = @()
  foreach ($item in $exact) {
    $rect = Get-Rectangle $item
    if (-not $rect) { continue }
    if ($rect.Left -lt ($windowRect.Left + $windowRect.Width * 0.48) -and $rect.Top -gt ($windowRect.Top + $windowRect.Height * 0.08)) {
      $rows += [pscustomobject]@{ Element = $item; Top = $rect.Top; Width = $rect.Width }
    }
  }
  $row = $rows | Sort-Object Top | Select-Object -First 1
  $usedNativeResultClick = $false
  if ($row) { Click-Element $row.Element }
  else {
    # Viber's Qt/QML result row is not exposed by Windows UI Automation on
    # some releases. The exact query plus the first-result coordinate mirrors
    # the safe fallback used by the macOS implementation.
    $resultX = if ($searchRect) { $searchRect.Left + ($searchRect.Width / 2) } else { $windowRect.Left + [Math]::Min(180, $windowRect.Width * 0.16) }
    $resultY = if ($searchRect) { $searchRect.Top + 160 } else { $windowRect.Top + 165 }
    Click-Point $resultX $resultY
    $usedNativeResultClick = $true
  }
  Start-Sleep -Milliseconds 900
  $selected = $false
  foreach ($item in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $nameCondition)) {
    $rect = Get-Rectangle $item
    if ($rect -and $rect.Left -gt ($windowRect.Left + $windowRect.Width * 0.18) -and $rect.Top -lt ($windowRect.Top + $windowRect.Height * 0.28)) {
      $selected = $true
      break
    }
  }
  if (-not $selected -and -not $usedNativeResultClick) { throw ('Viber group “' + $groupName + '” ကိုရွေးထားကြောင်း အတည်မပြုနိုင်ပါ။ PDF မပို့ပါ။') }
  return [pscustomobject]@{ Root = $root; WindowRect = $windowRect }
}

function Open-AttachmentDialog($context) {
  $root = $context.Root
  $windowRect = $context.WindowRect
  $composer = $null
  foreach ($edit in (Find-Descendants $root ([System.Windows.Automation.ControlType]::Edit))) {
    $rect = Get-Rectangle $edit
    if ($rect -and $rect.Left -gt ($windowRect.Left + $windowRect.Width * 0.20) -and $rect.Top -gt ($windowRect.Top + $windowRect.Height * 0.65) -and $rect.Width -gt 100) {
      if (-not $composer -or $rect.Top -gt $composer.Rect.Top) { $composer = [pscustomobject]@{ Element = $edit; Rect = $rect } }
    }
  }
  # Viber's conversation info area also exposes controls containing the word
  # "File". Name-based matching can therefore open shared-file search instead
  # of the attachment picker. On desktop, File Share is the second message-bar
  # icon and sits about 130 px left of the composer.
  if ($composer) {
    Click-Point ($composer.Rect.Left - 130) ($composer.Rect.Top + $composer.Rect.Height / 2)
  }
  else {
    # Qt may hide the composer from UI Automation. This fallback targets the
    # same File Share icon using the stable lower chat-toolbar position.
    Click-Point ($windowRect.Left + [Math]::Max(365, $windowRect.Width * 0.25)) ($windowRect.Bottom - 34)
  }
}

function Wait-FileDialog($processId) {
  $desktop = [System.Windows.Automation.AutomationElement]::RootElement
  $windowCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Window
  )
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 150
    foreach ($window in $desktop.FindAll([System.Windows.Automation.TreeScope]::Children, $windowCondition)) {
      try {
        if ($window.Current.ProcessId -eq $processId -and $window.Current.ClassName -eq '#32770') { return $window }
      } catch {}
    }
  }
  throw 'Viber file picker မပွင့်ပါ။ PDF မပို့နိုင်ပါ။'
}

function Choose-File($dialog, [string]$filePath) {
  $dialogRect = Get-Rectangle $dialog
  if (-not $dialogRect) { throw 'Windows file picker နေရာကို မသတ်မှတ်နိုင်ပါ။' }
  $fileNameCandidates = @()
  foreach ($edit in (Find-Descendants $dialog ([System.Windows.Automation.ControlType]::Edit))) {
    $rect = Get-Rectangle $edit
    if (-not $rect -or $rect.Top -lt ($dialogRect.Top + $dialogRect.Height * 0.55)) { continue }
    $label = (($edit.Current.Name + ' ' + $edit.Current.AutomationId + ' ' + $edit.Current.HelpText)).ToLowerInvariant()
    if ($label -match 'search') { continue }
    $score = 0
    if ($label -match 'file name|filename') { $score += 100 }
    if ($edit.Current.AutomationId -eq '1148') { $score += 80 }
    $score += [int]($rect.Top - $dialogRect.Top)
    $fileNameCandidates += [pscustomobject]@{ Element = $edit; Score = $score }
  }
  $fileName = ($fileNameCandidates | Sort-Object Score -Descending | Select-Object -First 1).Element
  if (-not $fileName) {
    # Some Windows 11 dialogs expose File name as a ComboBox with a nested Edit.
    foreach ($combo in (Find-Descendants $dialog ([System.Windows.Automation.ControlType]::ComboBox))) {
      $rect = Get-Rectangle $combo
      if (-not $rect -or $rect.Top -lt ($dialogRect.Top + $dialogRect.Height * 0.55)) { continue }
      $nested = Find-Descendants $combo ([System.Windows.Automation.ControlType]::Edit)
      if ($nested.Count -gt 0) { $fileName = $nested[0]; break }
    }
  }
  if (-not $fileName) { throw 'Windows file picker တွင် File name field ကို မတွေ့ပါ။' }
  $valuePattern = $null
  if ($fileName.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
    $valuePattern.SetValue($filePath)
    if ($valuePattern.Current.Value -ne $filePath) { throw 'Windows file picker တွင် PDF path မထည့်နိုင်ပါ။' }
  }
  else {
    Click-Element $fileName
    [System.Windows.Forms.Clipboard]::SetText($filePath)
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    [System.Windows.Forms.SendKeys]::SendWait('^v')
  }
  Start-Sleep -Milliseconds 200
  $openButton = $null
  foreach ($button in (Find-Descendants $dialog ([System.Windows.Automation.ControlType]::Button))) {
    if ($button.Current.AutomationId -eq '1') { $openButton = $button; break }
  }
  if (-not $openButton) { throw 'Windows file picker တွင် Open button ကို မတွေ့ပါ။' }
  $invokePattern = $null
  if ($openButton.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)) { $invokePattern.Invoke() }
  else { Click-Element $openButton }
}

try {
  $action = $env:FOOTBALL_POS_VIBER_ACTION
  $groupName = $env:FOOTBALL_POS_VIBER_GROUP
  if ([string]::IsNullOrWhiteSpace($groupName)) { throw 'Viber group name ထည့်ပါ။' }
  $process = Get-ViberProcess
  $context = Select-ViberGroup $process $groupName
  if ($action -eq 'select') { Write-Output 'selected'; exit 0 }
  if ($action -ne 'send') { throw 'Unknown Viber action.' }
  $filePath = $env:FOOTBALL_POS_VIBER_FILE
  if ([string]::IsNullOrWhiteSpace($filePath) -or -not (Test-Path -LiteralPath $filePath)) { throw 'ပို့မည့် PDF file ကို မတွေ့ပါ။' }
  Open-AttachmentDialog $context
  $dialog = Wait-FileDialog $process.Id
  Choose-File $dialog $filePath
  $dialogClosed = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 150
    if (-not (Get-Rectangle $dialog)) { $dialogClosed = $true; break }
  }
  if (-not $dialogClosed) { throw 'Windows file picker မပိတ်သေးသောကြောင့် PDF မပို့ပါ။' }
  Start-Sleep -Milliseconds 1400
  [FootballPosNative]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Write-Output 'sent'
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

function readablePowerShellError(raw: string) {
  const decode = (value: string) => value
    .replace(/_x([0-9a-fA-F]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  const xmlErrors = [...raw.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map(match => decode(match[1]).trim()).filter(Boolean);
  const source = xmlErrors.length ? xmlErrors.join('\n') : decode(raw);
  return source.split(/\r?\n/).map(line => line.trim()).find(line => line && !/^At line:|^\+|^CategoryInfo|^FullyQualifiedErrorId/i.test(line)) || 'Windows Viber automation မအောင်မြင်ပါ။';
}

async function runWindowsViber(action: 'select' | 'send', groupName: string, filePath = '') {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-OutputFormat', 'Text', '-Command', '-'], {
        windowsHide: true,
        env: { ...process.env, FOOTBALL_POS_VIBER_ACTION: action, FOOTBALL_POS_VIBER_GROUP: groupName, FOOTBALL_POS_VIBER_FILE: filePath },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => {
        child.kill();
        if (!settled) {
          settled = true;
          rejectPromise(Object.assign(new Error('Windows Viber automation အချိန်ကုန်သွားပါပြီ။'), { stdout, stderr }));
        }
      }, action === 'send' ? 45_000 : 25_000);
      child.once('error', error => {
        clearTimeout(timer);
        if (!settled) { settled = true; rejectPromise(Object.assign(error, { stdout, stderr })); }
      });
      child.once('close', code => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code === 0) resolvePromise();
        else rejectPromise(Object.assign(new Error(`PowerShell exited with code ${code ?? 'unknown'}.`), { stdout, stderr }));
      });
      child.stdin.end(windowsViberAutomationScript, 'utf8');
    });
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string; message?: string };
    const detail = failure.stderr?.trim() || failure.stdout?.trim() || failure.message || 'Windows Viber automation မအောင်မြင်ပါ။';
    throw new Error(readablePowerShellError(detail));
  }
}
async function selectViberGroup(groupName: string) {
  const cleanGroup = groupName.trim();
  if (!cleanGroup) throw new Error('Viber group name ထည့်ပါ။');
  if (process.platform === 'win32') return runWindowsViber('select', cleanGroup);
  if (process.platform !== 'darwin') throw new Error('Viber Desktop automation ကို macOS နှင့် Windows တွင်သာ အသုံးပြုနိုင်သည်။');
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', viberGroupSearchScript, cleanGroup], { timeout: 15_000 });
  const match = stdout.trim().match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!match) throw new Error('Viber result နေရာကို မသတ်မှတ်နိုင်ပါ။ PDF မပို့ပါ။');
  await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', viberNativeClickScript, match[1], match[2]], { timeout: 5_000 });
  const verifyScript = `on run argv
delay 1
tell application "System Events"
  tell process "Viber"
    try
      set searchField to first text field of window 1 whose description is "Search..."
    on error
      error "Viber group ရွေးချယ်မှုကို အတည်မပြုနိုင်ပါ။ PDF မပို့ပါ။"
    end try
    if value of searchField is not item 1 of argv then error "Viber search value ပြောင်းသွားပါသည်။ PDF မပို့ပါ။"
    -- When the requested group is already open, Viber selects its result but can
    -- leave keyboard focus in Search. The exact search value plus the native
    -- result-row click is therefore the reliable selection check here.
  end tell
end tell
return "selected"
end run`;
  await execFileAsync('/usr/bin/osascript', ['-e', verifyScript, cleanGroup], { timeout: 5_000 });
}
async function sendFileToViber(groupName: string, filePath: string) {
  const cleanGroup = groupName.trim();
  if (!cleanGroup) throw new Error('Viber group name ထည့်ပါ။');
  const reportsFolder = resolve(join(app.getPath('documents'), 'Football Bet POS Reports'));
  const target = resolve(filePath);
  const relativeTarget = relative(reportsFolder, target);
  if (!relativeTarget || relativeTarget.startsWith('..') || isAbsolute(relativeTarget) || !existsSync(target)) throw new Error('ပို့မည့် PDF ကို Football Bet POS Reports folder တွင် မတွေ့ပါ။');
  if (process.platform === 'win32') return runWindowsViber('send', cleanGroup, target);
  if (process.platform !== 'darwin') throw new Error('Viber Desktop automation ကို macOS နှင့် Windows တွင်သာ အသုံးပြုနိုင်သည်။');
  await selectViberGroup(cleanGroup);
  const script = `on run argv
set pdfPath to item 1 of argv
tell application "System Events"
  tell process "Viber"
    set frontmost to true
    set {windowX, windowY} to position of window 1
    set {windowWidth, windowHeight} to size of window 1
    -- Viber keeps the attachment (+) button at the lower-left of the chat pane.
    click at {windowX + 328, windowY + windowHeight - 28}
    repeat with attempt from 1 to 20
      if exists sheet 1 of window 1 then exit repeat
      delay 0.1
    end repeat
    if not (exists sheet 1 of window 1) then error "Viber file picker မပွင့်ပါ။ PDF မပို့နိုင်ပါ။"
    keystroke "g" using {command down, shift down}
    delay 0.5
    keystroke pdfPath
    delay 0.5
    key code 36
    delay 1
    key code 36
    delay 2
    if exists sheet 1 of window 1 then error "Viber file picker တွင် PDF ကို မရွေးနိုင်ပါ။"
    key code 36
  end tell
end tell
return "sent"
end run`;
  await execFileAsync('/usr/bin/osascript', ['-e', script, target], { timeout: 20_000 });
}
function createWindow() {
  mainWindow = new BrowserWindow({ width: 1440, height: 920, minWidth: 1080, minHeight: 700, backgroundColor: '#f5f7f3', webPreferences: { preload: join(__dirname, '../preload/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (process.env.VITE_DEV_SERVER_URL) void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else void mainWindow.loadFile(join(__dirname, '../../renderer/index.html'));
}
function csvCell(v: string) { return `"${v.replaceAll('"', '""')}"`; }
const transferCore = (value: TransferPackageCore): TransferPackageCore => ({ format: value.format, version: value.version, packageId: value.packageId, exportedAt: value.exportedAt, sourceDate: value.sourceDate, data: value.data });
const transferChecksum = (value: TransferPackageCore) => createHash('sha256').update(JSON.stringify(transferCore(value))).digest('hex');
app.whenReady().then(() => {
  ipcMain.handle('data:load', async (e) => { trusted(e); const store = await loadStore(); syncAutomationRuntime(store.settings.automation.enabled); return store; });
  ipcMain.handle('data:save', async (e, store: Store) => { trusted(e); syncAutomationRuntime(store.settings.automation.enabled); await saveStore(store); });
  ipcMain.handle('data:backup', async (e, store: Store) => {
    trusted(e);
    const folder = join(app.getPath('documents'), 'Football Bet POS Backups');
    await mkdir(folder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = join(folder, `football-pos-before-import-${stamp}.json`);
    await writeFile(target, JSON.stringify(store, null, 2), 'utf8');
    return target;
  });
  ipcMain.handle('transfer:export', async (e, payload: TransferPackageCore) => {
    trusted(e);
    if (payload.format !== 'football-bet-pos-transfer' || payload.version !== 1) throw new Error('Transfer format မမှန်ပါ။');
    const packageData: TransferPackage = { ...transferCore(payload), checksum: transferChecksum(payload) };
    const time = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Yangon', hour: '2-digit', minute: '2-digit' }).replace(':', '');
    const target = await dialog.showSaveDialog({ title: 'Export POS Transfer File', defaultPath: `football-transfer-${payload.sourceDate}-${time}.fbpos`, filters: [{ name: 'Football POS Transfer', extensions: ['fbpos'] }] });
    if (target.canceled || !target.filePath) return false;
    await writeFile(target.filePath, JSON.stringify(packageData, null, 2), 'utf8');
    return true;
  });
  ipcMain.handle('transfer:import', async (e) => {
    trusted(e);
    const selected = await dialog.showOpenDialog({ title: 'Import POS Transfer File', properties: ['openFile'], filters: [{ name: 'Football POS Transfer', extensions: ['fbpos'] }] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const target = selected.filePaths[0];
    if ((await stat(target)).size > 50 * 1024 * 1024) throw new Error('Transfer file သည် 50 MB ထက်ကျော်နေပါသည်။');
    const parsed = JSON.parse(await readFile(target, 'utf8')) as TransferPackage;
    if (parsed.format !== 'football-bet-pos-transfer' || parsed.version !== 1 || !parsed.data || !Array.isArray(parsed.data.teams) || !Array.isArray(parsed.data.matches) || !Array.isArray(parsed.data.bets)) throw new Error('Football POS transfer file မမှန်ပါ။');
    if (!parsed.packageId || parsed.checksum !== transferChecksum(parsed)) throw new Error('Transfer file checksum မကိုက်ညီပါ။ File ပျက်နေခြင်း သို့မဟုတ် ပြင်ထားခြင်းဖြစ်နိုင်ပါသည်။');
    return parsed;
  });
  ipcMain.handle('team-voice:save', async (e, teamId: string, audio: Uint8Array) => {
    trusted(e);
    const bytes = Buffer.from(audio);
    if (!bytes.length) throw new Error('အသံဖိုင် အလွတ်ဖြစ်နေပါသည်။');
    if (bytes.length > 2 * 1024 * 1024) throw new Error('အသံဖိုင်သည် 2 MB ထက်ကျော်နေပါသည်။');
    await mkdir(teamVoiceFolder(), { recursive: true });
    await writeFile(teamVoicePath(teamId), bytes);
    return true;
  });
  ipcMain.handle('team-voice:load', async (e, teamId: string) => {
    trusted(e);
    try { return new Uint8Array(await readFile(teamVoicePath(teamId))); }
    catch { return null; }
  });
  ipcMain.handle('team-voice:copy', async (e, sourceTeamId: string, targetTeamId: string) => {
    trusted(e);
    try {
      await mkdir(teamVoiceFolder(), { recursive: true });
      await copyFile(teamVoicePath(sourceTeamId), teamVoicePath(targetTeamId));
      return true;
    } catch { return false; }
  });
  ipcMain.handle('team-voice:remove', async (e, teamId: string) => {
    trusted(e);
    await rm(teamVoicePath(teamId), { force: true });
    return true;
  });
  ipcMain.handle('common-voice:save', async (e, key: CommonVoiceKey, audio: Uint8Array) => {
    trusted(e);
    const bytes = Buffer.from(audio);
    if (!bytes.length) throw new Error('အသံဖိုင် အလွတ်ဖြစ်နေပါသည်။');
    if (bytes.length > 2 * 1024 * 1024) throw new Error('အသံဖိုင်သည် 2 MB ထက်ကျော်နေပါသည်။');
    await mkdir(commonVoiceFolder(), { recursive: true });
    await writeFile(commonVoicePath(key), bytes);
    return true;
  });
  ipcMain.handle('common-voice:load', async (e, key: CommonVoiceKey) => {
    trusted(e);
    try { return new Uint8Array(await readFile(commonVoicePath(key))); }
    catch { return null; }
  });
  ipcMain.handle('common-voice:remove', async (e, key: CommonVoiceKey) => {
    trusted(e);
    await rm(commonVoicePath(key), { force: true });
    return true;
  });
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
    const safeTitle = title.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'football-settlement';
    const target = join(folder, `${safeTitle}.pdf`);
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
  ipcMain.handle('viber:select-group', async (e, groupName: string) => {
    trusted(e);
    try { await selectViberGroup(groupName); return { ok: true, message: `Viber group “${groupName.trim()}” ကို ရှာပြီးရွေးထားပါပြီ။` }; }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'Viber group ကို မရွေးနိုင်ပါ။' }; }
  });
  ipcMain.handle('viber:send-file', async (e, groupName: string, filePath: string) => {
    trusted(e);
    try { await sendFileToViber(groupName, filePath); return { ok: true, message: 'PDF ကို Viber group သို့ ပို့ပြီးပါပြီ။' }; }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'Viber သို့ PDF မပို့နိုင်ပါ။' }; }
  });
  createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
