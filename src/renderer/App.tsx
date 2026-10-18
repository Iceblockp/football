import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApiFixture, Band, Bet, Bookmaker, BookmakerSettings, Channel, CommonVoiceKey, Market, Match, Outcome, Rule, Selection, Settlement, Store, Team, TransferPackage, TransferTeam, ViewMode } from '../shared/models';
import { BODY_ODDS_PRESETS, TOTAL_ODDS_PRESETS, formatBandSummary, parseMyanmarOdds } from '../shared/odds';

const uid = () => crypto.randomUUID();
const localDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yangon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const today = () => localDate();
const nextDate = (date: string) => { const value = new Date(`${date}T12:00:00+06:30`); value.setUTCDate(value.getUTCDate() + 1); return localDate(value); };
const kickoffIso = (date: string, time: string, nextDay: boolean) => `${nextDay ? nextDate(date) : date}T${time}:00+06:30`;
const kickoffLocalDate = (iso?: string) => iso ? localDate(new Date(iso)) : '';
const myanmarClock = (date = new Date()) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Yangon', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
const inTimeWindow = (value: string, start: string, end: string) => start <= end ? value >= start && value <= end : value >= start || value <= end;
const countdownLabel = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
const finalApiStatuses = new Set(['FT', 'AET', 'PEN']);
const commonVoiceOptions: { key: CommonVoiceKey; label: string }[] = [
  { key: 'body', label: 'Body' }, { key: 'over', label: 'Over (Up)' }, { key: 'down', label: 'Down' },
  ...'0123456789'.split('').map(key => ({ key: key as CommonVoiceKey, label: key })),
  { key: 'k', label: 'K · 000' }, { key: 'w', label: 'W · 0000' }, { key: 'l', label: 'L · 00000' }, { key: 'm', label: 'M · 000000' },
];
const money = (n: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(n));
const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const percent = (n: number) => Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
const sortBets = (items: Bet[]) => [...items].sort((a, b) =>
  (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
  || (a.placedAt ?? '').localeCompare(b.placedAt ?? '')
  || a.id.localeCompare(b.id)
);
const sortSettlements = (items: Settlement[], mode: 'latest' | 'ledger') => mode === 'latest'
  ? [...items].sort((a, b) => (b.bet.placedAt ?? '').localeCompare(a.bet.placedAt ?? '') || b.bet.id.localeCompare(a.bet.id))
  : items;
type ViewResult = { gross: number; adjustment: number; final: number; grossLabel: string; adjustmentLabel: string; finalLabel: string };
type ReportTotals = { betAmount: number; grossWin: number; grossLoss: number; winCom: number; loseCom: number; netWin: number; netLoss: number; columnTotal: number; commission: number; commissionEffect: number; total: number; commissionRate: number; commissionLabel: string };
type BulkMatchRow = { nextDay: boolean; time: string; teams: [string, string]; bd?: string; ou?: string };
type BulkPreview = { rows: BulkMatchRow[]; missingCodes: Record<string, string> };
type ImportTeamPlan = { source: TransferTeam; existing?: Team; code: string };
type TransferPreview = { packageData: TransferPackage; teamPlans: ImportTeamPlan[]; newMatches: number; duplicateMatches: number; newBets: number; duplicateBets: number };
const normalizeApiName = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
const normalizeTeamName = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '').trim();
const ruleFromCode = (market: Market, code: string): Rule => {
  const parsed = parseMyanmarOdds(code);
  if (!parsed) throw new Error(`Invalid ${market === 'body' ? 'BD' : 'O/U'} rule: ${code}`);
  return { id: uid(), market, code, ...parsed, ...(market === 'body' ? { bodyBaseSide: 'home' as const } : {}), status: 'active', effectiveAt: new Date().toISOString(), provisional: false };
};
const viewResult = (settlement: Settlement, settings: BookmakerSettings, view: ViewMode): ViewResult => {
  if (settlement.label === 'Pending' || settlement.band.outcome === 'refund') return { gross: 0, adjustment: 0, final: 0, grossLabel: settlement.label, adjustmentLabel: '—', finalLabel: settlement.label };
  const playerGross = settlement.signed;
  const playerAdjustment = settings.mode === 'summary'
    ? playerGross > 0 ? -playerGross * settings.winTaxRate / 100 : 0
    : playerGross > 0 ? -playerGross * settings.playerWinDeduction / 100 : Math.abs(playerGross) * settings.playerLossRebate / 100;
  const playerFinal = playerGross + playerAdjustment;
  const gross = view === 'player' ? playerGross : -playerGross;
  const adjustment = view === 'player' ? playerAdjustment : -playerAdjustment;
  const final = view === 'player' ? playerFinal : -playerFinal;
  const winner = view === 'player' ? 'Player' : 'ဒိုင်';
  return { gross, adjustment, final, grossLabel: gross > 0 ? `${winner} နိုင်` : `${winner} ရှုံး`, adjustmentLabel: adjustment ? 'Commission' : '—', finalLabel: final > 0 ? `${winner} နိုင်` : `${winner} ရှုံး` };
};
// The commission column only needs the rate; whether it belongs to the player or
// the bookmaker is already communicated by the WIN / LOSE / Final columns.
const adjustmentRate = (result: ViewResult) => result.gross === 0 ? 0 : Math.round(Math.abs(result.adjustment / result.gross) * 100);
function SummaryPanel({ totals }: { totals: ReportTotals }) {
  const rows: [string, number][] = [
    ['WIN gross', totals.grossWin] as [string, number], ['WIN Com', totals.winCom] as [string, number], ['WIN final', totals.netWin] as [string, number],
    ['LOSE gross', totals.grossLoss] as [string, number], ['LOSE Com', totals.loseCom] as [string, number], ['LOSE final', totals.netLoss] as [string, number],
    ...(totals.commissionRate ? [[`${totals.commissionLabel} (${totals.commissionRate}%)`, totals.commissionEffect] as [string, number]] : []), ['TOTAL', totals.total] as [string, number],
  ];
  return <div className="summary-panel"><b>Summary</b><table><tbody>{rows.map(([label, value]) => <tr key={label}><td>{label}</td><td className={value > 0 ? 'win' : value < 0 ? 'loss' : ''}>{value > 0 ? '+' : value < 0 ? '-' : ''}{money(value)}</td></tr>)}</tbody></table></div>;
}
type QuickAction = 'b' | 'u' | 'd';
type QuickRequest = { team: Team; action: QuickAction; amount: number };
const parseQuickEntry = (input: string, teams: Team[]): QuickRequest | string => {
  const compact = input.trim().toLowerCase().replace(/[\s,]/g, '');
  if (!compact) return 'Quick code ထည့်ပါ။ ဥပမာ chb50000';
  const team = [...teams].sort((a, b) => b.code.length - a.code.length).find(item => compact.startsWith(item.code.toLowerCase()));
  if (!team) return 'Team code မတွေ့ပါ။ Teams မှာ short code အရင်ထည့်ပါ။';
  const rest = compact.slice(team.code.length);
  const match = rest.match(/^([bud])(\d+(?:[kmwl])?)$/);
  if (!match) return 'Format မမှန်ပါ။ ဥပမာ chb50000, chu50k, mud5w';
  const unit = match[2].slice(-1);
  const numeric = Number(unit === 'k' || unit === 'm' || unit === 'w' || unit === 'l' ? match[2].slice(0, -1) : match[2]);
  const multiplier = unit === 'k' ? 1_000 : unit === 'w' ? 10_000 : unit === 'l' ? 100_000 : unit === 'm' ? 1_000_000 : 1;
  return numeric > 0 ? { team, action: match[1] as QuickAction, amount: numeric * multiplier } : 'လောင်းငွေသည် 0 ထက်ကြီးရမည်။';
};
const action = (outcome: Outcome, rate: number): Band => ({ outcome, rate: outcome === 'refund' ? 0 : Number(rate) || 0 });
const bodyBaseSide = (rule: Rule) => rule.bodyBaseSide ?? 'home';
const isOppositeSelection = (bet: Bet, rule: Rule) => rule.market === 'body'
  ? bet.selection !== bodyBaseSide(rule)
  : bet.selection === 'down';
const oppositeRuleCode = (code: string) => code.replace(/([+-])(\s*\d+)\s*$/, (_match, sign: string, amount: string) => `${sign === '+' ? '-' : '+'}${amount}`);
const displayRuleCode = (settlement: Settlement) => isOppositeSelection(settlement.bet, settlement.rule)
  ? oppositeRuleCode(settlement.rule.code)
  : settlement.rule.code;
const ruleBaseLabel = (match: Match, rule: Rule) => rule.market === 'body'
  ? (bodyBaseSide(rule) === 'home' ? match.home : match.away)
  : 'Up';
const marketLabel = (rule: Rule) => rule.market === 'body' ? 'BD' : 'O/U';
const sourceRuleLabel = (settlement: Settlement) => `${marketLabel(settlement.rule)} ${settlement.rule.code} · ${ruleBaseLabel(settlement.match, settlement.rule)} အခြေခံ`;
const baseSideLabel = (rule: Rule) => rule.market === 'body' ? (bodyBaseSide(rule) === 'home' ? 'ဘယ်အသင်း' : 'ညာအသင်း') : 'Up';
const baseRuleReference = (settlement: Settlement) => `${baseSideLabel(settlement.rule)} · ${marketLabel(settlement.rule)} ${settlement.rule.code}`;
const usedRuleLabel = (settlement: Settlement) => `${marketLabel(settlement.rule)} ${displayRuleCode(settlement)}`;
const exportRuleLabel = (settlement: Settlement) => `${usedRuleLabel(settlement)}${settlement.rule.market === 'body' && bodyBaseSide(settlement.rule) === 'away' ? ' ↔' : ''}`;
const defaultRule = (market: Market, provisional: boolean | number = false): Rule => {
  const code = market === 'body' ? '1+80' : '2-60';
  const parsed = parseMyanmarOdds(code);
  return {
    id: uid(),
    code,
    market,
    line: parsed ? parsed.line : (market === 'body' ? 1 : 2),
    below: parsed ? parsed.below : action('loss', 100),
    equal: parsed ? parsed.equal : action(market === 'body' ? 'win' : 'loss', market === 'body' ? 80 : 60),
    above: parsed ? parsed.above : action('win', 100),
    ...(market === 'body' ? { bodyBaseSide: 'home' as const } : {}),
    status: 'active',
    effectiveAt: new Date().toISOString(),
    provisional: provisional === true,
  };
};
const labels: Record<Outcome, string> = { win: 'အမြတ်', loss: 'အရှုံး', refund: 'ပြန်အမ်း' };
function settle(bet: Bet, match: Match, rule: Rule): Settlement {
  if (match.postponed) return { bet, match, rule, band: action('refund', 0), signed: 0, label: 'P:P / ပြန်အမ်း' };
  if (match.homeScore === null || match.awayScore === null) return { bet, match, rule, band: action('refund', 0), signed: 0, label: 'Pending' };
  // Every market is quoted from one base perspective: the configured team for
  // Body and Up for O/U. The other side gets the exact inverse band.
  // for O/U. Away and Down are the same condition's exact inverse; their
  // score/total must not be compared to a reversed line.
  const value = rule.market === 'body'
    ? bodyBaseSide(rule) === 'home' ? match.homeScore - match.awayScore : match.awayScore - match.homeScore
    : match.homeScore + match.awayScore;
  const baseBand = value < rule.line ? rule.below : value === rule.line ? rule.equal : rule.above;
  const oppositeSide = isOppositeSelection(bet, rule);
  const band = oppositeSide && baseBand.outcome !== 'refund'
    ? action(baseBand.outcome === 'win' ? 'loss' : 'win', baseBand.rate)
    : baseBand;
  const signed = band.outcome === 'win' ? bet.amount * band.rate / 100 : band.outcome === 'loss' ? -bet.amount * band.rate / 100 : 0;
  const label = band.outcome === 'refund' ? 'ပြန်အမ်း' : `${band.rate}% ${labels[band.outcome]}`;
  return { bet, match, rule, band, signed, label };
}
function selectionLabel(settlement: Settlement): string {
  const { bet, match, rule } = settlement;
  if (rule.market === 'body') return bet.selection === 'home' ? match.home : match.away;
  return bet.selection === 'up' ? 'Up' : 'Down';
}
const fallbackSummarySettings = (): BookmakerSettings => ({ mode: 'summary', playerWinDeduction: 0, playerLossRebate: 0, winTaxRate: 5, turnoverCommissionRate: 2 });
const channelName = (store: Store, id: Bookmaker) => store.settings.channels.find(channel => channel.id === id)?.name ?? id;
const channelFileName = (store: Store, id: Bookmaker) => {
  const readable = channelName(store, id).trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}._-]+/gu, '').replace(/^-+|-+$/g, '');
  return readable || id;
};
function automatedReport(store: Store, date: string, bookmaker: Bookmaker) {
  const settings = store.settings.bookmakerSettings[bookmaker] ?? fallbackSummarySettings();
  const view = store.settings.view;
  const settlements = sortBets(store.bets.filter(bet => bet.date === date && bet.bookmaker === bookmaker)).map(bet => {
    const match = store.matches.find(item => item.id === bet.matchId);
    const rule = bet.ruleSnapshot ?? match?.rules.find(item => item.id === bet.ruleId);
    return match && rule ? settle(bet, match, rule) : null;
  }).filter(Boolean) as Settlement[];
  const results = settlements.map(item => viewResult(item, settings, view));
  const grossWin = results.filter(item => item.gross > 0).reduce((sum, item) => sum + item.gross, 0);
  const grossLoss = results.filter(item => item.gross < 0).reduce((sum, item) => sum + item.gross, 0);
  const winCom = results.filter(item => item.gross > 0).reduce((sum, item) => sum + item.adjustment, 0);
  const loseCom = results.filter(item => item.gross < 0).reduce((sum, item) => sum + item.adjustment, 0);
  const columnTotal = grossWin + grossLoss + winCom + loseCom;
  const commissionRate = settings.mode === 'summary' ? settings.turnoverCommissionRate : 0;
  const commission = settlements.reduce((sum, item) => sum + Math.abs(item.signed), 0) * commissionRate / 100;
  const commissionEffect = view === 'player' ? commission : -commission;
  const total = columnTotal + commissionEffect;
  const signed = (value: number) => `${value > 0 ? '+' : value < 0 ? '-' : ''}${money(value)}`;
  const header = ['No.', 'Match', 'Rule', 'ရွေးချယ်မှု', 'လောင်းငွေ', 'Result', '% (+)', '% (-)', 'WIN', 'LOSE', 'Com', 'Final', 'Status'];
  const details = settlements.map((item, index) => { const result = results[index]; return [String(index + 1), `${item.match.home} vs ${item.match.away}`, exportRuleLabel(item), selectionLabel(item), money(item.bet.amount), item.match.postponed ? 'P:P' : item.match.homeScore === null ? '' : `${item.match.homeScore}:${item.match.awayScore}`, result.gross > 0 ? String(item.band.rate) : '', result.gross < 0 ? String(item.band.rate) : '', result.gross > 0 ? money(result.gross) : '', result.gross < 0 ? `-${money(result.gross)}` : '', result.adjustment ? `${signed(result.adjustment)} (${adjustmentRate(result)}%)` : '', result.final ? signed(result.final) : '', item.band.outcome === 'refund' ? 'Refund' : result.finalLabel]; });
  const summary: [string, string][] = [['WIN gross', signed(grossWin)], ['WIN Com', signed(winCom)], ['WIN final', signed(grossWin + winCom)], ['LOSE gross', signed(grossLoss)], ['LOSE Com', signed(loseCom)], ['LOSE final', signed(grossLoss + loseCom)], ...(commissionRate ? [[`Turnover Com (${commissionRate}%)`, signed(commissionEffect)] as [string, string]] : []), ['TOTAL', signed(total)]];
  const footer = ['TOTAL', '', '', '', money(settlements.reduce((sum, item) => sum + item.bet.amount, 0)), '', '', '', money(grossWin), `-${money(grossLoss)}`, `WIN ${signed(winCom)} | LOSE ${signed(loseCom)}`, signed(columnTotal), 'Final column total'];
  const rows = [header, ...details, footer];
  const title = `${channelName(store, bookmaker)} · ${view === 'dai' ? 'Dai View' : 'Player View'}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;padding:22px;color:#13261a}h1{font-size:20px}h2{font-size:14px;margin:18px 0 6px}table{width:100%;border-collapse:collapse;font-size:10px}td,th{border:1px solid #8da393;padding:5px;text-align:left}th{background:#d6e7b0}.summary{width:320px}.summary td:last-child{text-align:right}.positive{color:#137645;font-weight:bold}.negative{color:#b23b36;font-weight:bold}</style></head><body><h1>Football Bet POS — ${escapeHtml(title)} (${date})</h1><table><thead><tr>${header.map(value => `<th>${escapeHtml(value)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(row => `<tr>${row.map(value => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table><h2>Summary</h2><table class="summary"><tbody>${summary.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`).join('')}</tbody></table></body></html>`;
  return { title: `football-settlement-${channelFileName(store, bookmaker)}-${date}`, html, count: settlements.length };
}
function BandFields({ label, value, onChange }: { label: string; value: Band; onChange: (v: Band) => void }) {
  return <div className="band"><span>{label}</span><select value={value.outcome} onChange={e => onChange(action(e.target.value as Outcome, value.rate))}>{(['win', 'loss', 'refund'] as Outcome[]).map(x => <option value={x} key={x}>{labels[x]}</option>)}</select>{value.outcome !== 'refund' && <input aria-label={`${label} rate`} type="number" min="0" max="100" value={value.rate} onChange={e => onChange(action(value.outcome, Number(e.target.value)))} />}</div>;
}
function RuleEditor({ rule, onChange, home = 'ဘယ်အသင်း', away = 'ညာအသင်း' }: { rule: Rule; onChange: (r: Rule) => void; home?: string; away?: string }) {
  const [showCustom, setShowCustom] = useState(false);
  const presets = rule.market === 'body' ? BODY_ODDS_PRESETS : TOTAL_ODDS_PRESETS;

  const handleMarketChange = (market: Market) => {
    onChange({ ...defaultRule(market), id: rule.id, provisional: rule.provisional });
  };

  const handlePresetSelect = (code: string) => {
    if (!code) return;
    const parsed = parseMyanmarOdds(code);
    if (parsed) {
      onChange({
        ...rule,
        code,
        line: parsed.line,
        below: parsed.below,
        equal: parsed.equal,
        above: parsed.above,
      });
    }
  };

  const handleCodeChange = (newCode: string) => {
    const parsed = parseMyanmarOdds(newCode);
    if (parsed) {
      onChange({
        ...rule,
        code: newCode,
        line: parsed.line,
        below: parsed.below,
        equal: parsed.equal,
        above: parsed.above,
      });
    } else {
      onChange({ ...rule, code: newCode });
    }
  };

  return (
    <div className="rule-editor">
      <div className="rule-top">
        <label>
          Market
          <select value={rule.market} onChange={e => handleMarketChange(e.target.value as Market)}>
            <option value="body">Body</option>
            <option value="total">O/U</option>
          </select>
        </label>
        <label>
          Quick Preset
          <select value={presets.some(p => p.code === rule.code) ? rule.code : ''} onChange={e => handlePresetSelect(e.target.value)}>
            <option value="">-- Preset ရွေးပါ --</option>
            {presets.map(p => (
              <option value={p.code} key={p.code}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Rule Code
          <input
            value={rule.code}
            onChange={e => handleCodeChange(e.target.value)}
            placeholder="ဥပမာ 1+80, 2-60, 0.5"
          />
        </label>
        <label>
          Line
          <input
            type="number"
            step="0.25"
            value={rule.line}
            onChange={e => onChange({ ...rule, line: Number(e.target.value) })}
          />
        </label>
        {rule.market === 'body' && <label>
          BD အခြေခံအသင်း
          <select value={bodyBaseSide(rule)} onChange={e => onChange({ ...rule, bodyBaseSide: e.target.value as 'home' | 'away' })}>
            <option value="home">{home || 'ဘယ်အသင်း'} (ဘယ်)</option>
            <option value="away">{away || 'ညာအသင်း'} (ညာ)</option>
          </select>
        </label>}
      </div>

      <div className="rule-summary-badge">
        <label className="badge-pill">Status: <select value={rule.provisional ? 'temporary' : 'confirmed'} onChange={e => onChange({ ...rule, provisional: e.target.value === 'temporary' })}><option value="confirmed">အတည် rule</option><option value="temporary">ယာယီ default</option></select></label>
        <span className="badge-pill">Line: <b>{rule.line}</b></span>
        {rule.market === 'body' && <span className="badge-pill">အခြေခံ: <b>{bodyBaseSide(rule) === 'home' ? home || 'ဘယ်အသင်း' : away || 'ညာအသင်း'}</b></span>}
        <span className="badge-pill">အောက်: <b>{formatBandSummary(rule.below)}</b></span>
        <span className="badge-pill">တိတိ: <b>{formatBandSummary(rule.equal)}</b></span>
        <span className="badge-pill">အထက်: <b>{formatBandSummary(rule.above)}</b></span>
      </div>

      <button
        type="button"
        className="link rule-customize-btn"
        onClick={() => setShowCustom(prev => !prev)}
      >
        {showCustom ? '▲ အချိုးများကို ပြန်ဝှက်ရန်' : '⚙️ အချိုးများကို အသေးစိတ် စိတ်ကြိုက်ပြင်ရန် (Custom Bands)'}
      </button>

      {showCustom && (
        <div className="bands">
          <BandFields label="Line အောက်" value={rule.below} onChange={below => onChange({ ...rule, below })} />
          <BandFields label="Line တိတိ" value={rule.equal} onChange={equal => onChange({ ...rule, equal })} />
          <BandFields label="Line အထက်" value={rule.above} onChange={above => onChange({ ...rule, above })} />
        </div>
      )}
    </div>
  );
}
function TeamSelect({ label, value, teams, onChange }: { label: string; value: string; teams: Team[]; onChange: (value: string) => void }) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  useEffect(() => setQuery(value), [value]);
  const matches = teams.filter(team => `${team.name} ${team.code}`.toLowerCase().includes(query.toLowerCase()));
  const choose = (team: Team) => { setQuery(team.name); onChange(team.name); setOpen(false); };
  return <label>{label}<div className="team-picker"><input value={query} placeholder="🔍 Team name / code ရှာရန်" onFocus={() => setOpen(true)} onChange={e => { setQuery(e.target.value); onChange(''); setOpen(true); }} onBlur={() => setTimeout(() => setOpen(false), 150)}/>{open && <div className="team-options">{matches.length ? matches.map(team => <button type="button" key={team.id} onMouseDown={e => e.preventDefault()} onClick={() => choose(team)}><b>{team.name}</b><code>{team.code}</code></button>) : <span>ကိုက်ညီသော Team မရှိပါ</span>}</div>}</div></label>;
}
export function App() {
  const [store, setStore] = useState<Store | null>(null); const [page, setPage] = useState<'matches' | 'ledger' | 'report' | 'settings'>('matches'); const [notice, setNotice] = useState(''); const [activeDate, setActiveDate] = useState(today());
  const [settingsTab, setSettingsTab] = useState<'general' | 'report' | 'matches' | 'voice' | 'automation'>('general');
  const [activeBookmaker, setActiveBookmaker] = useState<Bookmaker>('viber');
  const [transferDestination, setTransferDestination] = useState<Bookmaker>('messenger');
  const [newChannelName, setNewChannelName] = useState('');
  const [matchForm, setMatchForm] = useState({ time: '19:00', nextDay: false, home: '', away: '', rules: [defaultRule('body'), defaultRule('total')] as Rule[] }); const [editingMatchId, setEditingMatchId] = useState<string | null>(null);
  const [betForm, setBetForm] = useState({ matchId: '', ruleId: '', selection: 'home' as Selection, note: '', amount: '', lateReceivedAt: '', lateReason: '' }); const [editingBetId, setEditingBetId] = useState<string | null>(null); const [insertAfterBetId, setInsertAfterBetId] = useState<string | null>(null); const [matchSearch, setMatchSearch] = useState(''); const [matchListSearch, setMatchListSearch] = useState(''); const [quickEntry, setQuickEntry] = useState(''); const [quickCandidates, setQuickCandidates] = useState<{ request: QuickRequest; matches: Match[] } | null>(null); const [teamForm, setTeamForm] = useState({ name: '', code: '', voiceName: '' }); const [teamSearch, setTeamSearch] = useState(''); const [editingTeamId, setEditingTeamId] = useState<string | null>(null); const [editingTeamCode, setEditingTeamCode] = useState(''); const [editingTeamVoiceName, setEditingTeamVoiceName] = useState(''); const [deletingAllTeams, setDeletingAllTeams] = useState(false); const [recordingTeamId, setRecordingTeamId] = useState<string | null>(null); const [recordingCommonKey, setRecordingCommonKey] = useState<CommonVoiceKey | null>(null); const [voiceClipBusyId, setVoiceClipBusyId] = useState<string | null>(null); const [commonVoiceBusyKey, setCommonVoiceBusyKey] = useState<CommonVoiceKey | null>(null); const [reportSortMode, setReportSortMode] = useState<'latest' | 'ledger'>('latest'); const [confirmation, setConfirmation] = useState<{ message: string; resolve: (confirmed: boolean) => void } | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState(''); const [apiKeyConfigured, setApiKeyConfigured] = useState(false); const [apiMessage, setApiMessage] = useState(''); const [automationBusy, setAutomationBusy] = useState(false); const [nextAutomationCheckAt, setNextAutomationCheckAt] = useState<number | null>(null); const [automationClock, setAutomationClock] = useState(Date.now()); const [viberSendBusy, setViberSendBusy] = useState(false);
  const [fixturePicker, setFixturePicker] = useState<{ match: Match; fixtures: ApiFixture[]; searchDate: string } | null>(null); const [fixtureFilter, setFixtureFilter] = useState(''); const [fixturePickerLoading, setFixturePickerLoading] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false); const [bulkJson, setBulkJson] = useState(''); const [bulkPreview, setBulkPreview] = useState<BulkPreview | null>(null); const [bulkError, setBulkError] = useState(''); const [bulkApiQueue, setBulkApiQueue] = useState<string[]>([]); const [bulkApiBusy, setBulkApiBusy] = useState(false);
  const [transferPreview, setTransferPreview] = useState<TransferPreview | null>(null); const [transferBusy, setTransferBusy] = useState(false);
  const fixtureDateCache = useRef(new Map<string, ApiFixture[]>());
  const checkApiResultsRef = useRef<(manual?: boolean) => Promise<void>>(async () => undefined);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingTimeoutRef = useRef<number | null>(null);
  const voiceRunRef = useRef(0);
  const voiceAudioContextRef = useRef<AudioContext | null>(null);
  const activeVoiceSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const activeVoiceAudioFinishRef = useRef<(() => void) | null>(null);
  useEffect(() => { void window.footballPos.data.load().then(setStore); }, []);
  useEffect(() => { void window.footballPos.apiFootball.hasKey().then(setApiKeyConfigured); }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = store?.settings.theme ?? 'light';
  }, [store?.settings.theme]);
  useEffect(() => () => {
    if (recordingTimeoutRef.current !== null) window.clearTimeout(recordingTimeoutRef.current);
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
    recordingStreamRef.current?.getTracks().forEach(track => track.stop());
    window.speechSynthesis?.cancel();
    try { activeVoiceSourceRef.current?.stop(); } catch { /* already stopped */ }
    activeVoiceAudioFinishRef.current?.();
    void voiceAudioContextRef.current?.close();
  }, []);
  useEffect(() => {
    const rules = (store?.matches ?? []).flatMap(match => match.rules);
    document.querySelectorAll('option').forEach(option => {
      const rule = rules.find(item => item.id === (option as HTMLOptionElement).value);
      if (rule) option.textContent = `${rule.market === 'body' ? 'BD' : 'O/U'} — ${rule.code} [${rule.status === 'closed' ? 'ပိတ် · Late entry only' : rule.provisional ? 'ယာယီ · အကြေးမထွက်သေး' : 'ဖွင့်'}]`;
    });
  }, [store, betForm.matchId]);
  const save = async (next: Store) => { setStore(next); await window.footballPos.data.save(next); };
  const allTeams = store?.teams ?? []; const teams = allTeams.filter(team => team.bookmaker === activeBookmaker); const matches = store?.matches ?? []; const bets = store?.bets ?? []; const channels = store?.settings.channels ?? []; const enabledChannels = channels.filter(channel => channel.enabled); const activeChannel = channels.find(channel => channel.id === activeBookmaker); const otherChannels = enabledChannels.filter(channel => channel.id !== activeBookmaker); const dayMatches = matches.filter(x => x.date === activeDate && x.bookmaker === activeBookmaker); const dayBets = bets.filter(x => x.date === activeDate && x.bookmaker === activeBookmaker);
  const withActiveTeams = (nextTeams: Team[]) => [...allTeams.filter(team => team.bookmaker !== activeBookmaker), ...nextTeams];
  useEffect(() => {
    if (!store || enabledChannels.some(channel => channel.id === activeBookmaker)) return;
    const first = enabledChannels[0];
    if (first) setActiveBookmaker(first.id);
  }, [store, activeBookmaker, enabledChannels]);
  useEffect(() => {
    if (otherChannels.some(channel => channel.id === transferDestination)) return;
    setTransferDestination(otherChannels[0]?.id ?? '');
  }, [activeBookmaker, transferDestination, otherChannels]);
  useEffect(() => setTransferPreview(null), [activeBookmaker, activeDate]);
  const filteredTeams = useMemo(() => {
    const query = teamSearch.trim().toLowerCase();
    if (!query) return teams;
    return teams.filter(team => `${team.name} ${team.code} ${team.voiceName ?? ''} ${team.apiName ?? ''}`.toLowerCase().includes(query));
  }, [teams, teamSearch]);
  const filteredDayMatches = useMemo(() => {
    if (!matchSearch.trim()) return dayMatches;
    const q = matchSearch.toLowerCase();
    return dayMatches.filter(m => m.home.toLowerCase().includes(q) || m.away.toLowerCase().includes(q));
  }, [dayMatches, matchSearch]);
  const visibleMatchCards = useMemo(() => {
    const query = matchListSearch.trim().toLowerCase();
    if (!query) return dayMatches;
    return dayMatches.filter(match => {
      const homeCode = teams.find(team => team.name === match.home)?.code ?? '';
      const awayCode = teams.find(team => team.name === match.away)?.code ?? '';
      return [
        match.time, match.home, homeCode, match.away, awayCode, match.apiHome ?? '', match.apiAway ?? '', match.apiLeague ?? '', match.apiStatus ?? '',
        ...match.rules.map(rule => `${rule.market === 'body' ? 'bd body' : 'ou over under'} ${rule.code}`),
      ].join(' ').toLowerCase().includes(query);
    });
  }, [dayMatches, matchListSearch, teams]);
  useEffect(() => { const match = dayMatches.find(item => item.id === betForm.matchId); const active = match?.rules.find(rule => rule.status !== 'closed'); if (match && active && !match.rules.some(rule => rule.id === betForm.ruleId)) setBetForm(current => ({ ...current, ruleId: active.id, selection: active.market === 'total' ? 'up' : bodyBaseSide(active) })); }, [betForm.matchId]);
  const selectedMatch = dayMatches.find(x => x.id === betForm.matchId); const selectedRule = selectedMatch?.rules.find(x => x.id === betForm.ruleId);
  const settlements = useMemo(() => store ? sortBets(bets).map(b => { const m = matches.find(x => x.id === b.matchId); const r = b.ruleSnapshot ?? m?.rules.find(x => x.id === b.ruleId); return m && r ? settle(b, m, r) : null; }).filter(Boolean) as Settlement[] : [], [store, bets, matches]);
  const activeCommission = store?.settings.bookmakerSettings[activeBookmaker] ?? (activeBookmaker === 'viber'
    ? { mode: 'direct' as const, playerWinDeduction: 3, playerLossRebate: 2, winTaxRate: 0, turnoverCommissionRate: 0 }
    : fallbackSummarySettings());
  const currentView = store?.settings.view ?? 'dai';
  const daySettlements = settlements.filter(x => x.bet.date === activeDate && x.bet.bookmaker === activeBookmaker); const reportSettlements = sortSettlements(daySettlements, reportSortMode); const displayedResults = daySettlements.map(settlement => viewResult(settlement, activeCommission, currentView)); const totalBetAmount = daySettlements.reduce((n, x) => n + x.bet.amount, 0); const grossWin = displayedResults.filter(result => result.gross > 0).reduce((n, result) => n + result.gross, 0); const grossLoss = displayedResults.filter(result => result.gross < 0).reduce((n, result) => n + result.gross, 0); const winCom = displayedResults.filter(result => result.gross > 0).reduce((n, result) => n + result.adjustment, 0); const loseCom = displayedResults.filter(result => result.gross < 0).reduce((n, result) => n + result.adjustment, 0); const netWin = grossWin + winCom; const netLoss = grossLoss + loseCom; const columnTotal = netWin + netLoss; const turnover = daySettlements.reduce((n, settlement) => n + Math.abs(settlement.signed), 0); const commissionRate = activeCommission.mode === 'summary' ? activeCommission.turnoverCommissionRate : 0; const commission = turnover * commissionRate / 100; const commissionEffect = currentView === 'player' ? commission : -commission; const total = columnTotal + commissionEffect; const reportTotals: ReportTotals = { betAmount: totalBetAmount, grossWin, grossLoss, winCom, loseCom, netWin, netLoss, columnTotal, commission, commissionEffect, total, commissionRate, commissionLabel: 'Turnover Com' };
  const flash = (message: string) => { setNotice(message); setTimeout(() => setNotice(''), 3500); };
  const stopVoiceOutput = () => {
    voiceRunRef.current += 1;
    window.speechSynthesis?.cancel();
    try { activeVoiceSourceRef.current?.stop(); } catch { /* already stopped */ }
    activeVoiceAudioFinishRef.current?.();
    activeVoiceAudioFinishRef.current = null;
    activeVoiceSourceRef.current = null;
  };
  const speakPart = (text: string, run: number) => new Promise<void>(resolve => {
    if (!text || run !== voiceRunRef.current || !('speechSynthesis' in window)) return resolve();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = store?.settings.voiceConfirmation.rate ?? 1.35;
    utterance.lang = 'en-US';
    const englishVoice = window.speechSynthesis.getVoices().find(voice => voice.lang.toLowerCase().startsWith('en'));
    if (englishVoice) utterance.voice = englishVoice;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    window.speechSynthesis.speak(utterance);
  });
  const playRecordedClip = async (load: () => Promise<Uint8Array | null>, run: number) => {
    if (run !== voiceRunRef.current) return false;
    try {
      const bytes = await load();
      if (!bytes?.length || run !== voiceRunRef.current) return false;
      const encoded = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(encoded).set(bytes);
      const context = voiceAudioContextRef.current ?? new AudioContext();
      voiceAudioContextRef.current = context;
      if (context.state === 'suspended') await context.resume();
      const audio = await context.decodeAudioData(encoded);
      if (run !== voiceRunRef.current) return false;

      // Find speech in 10 ms windows and skip the quiet lead-in/tail. A small
      // padding keeps consonants natural while removing the long recording gap.
      const windowFrames = Math.max(32, Math.round(audio.sampleRate * 0.01));
      const windows = Math.ceil(audio.length / windowFrames);
      const levels = new Float32Array(windows);
      let peak = 0;
      for (let index = 0; index < windows; index += 1) {
        const from = index * windowFrames;
        const to = Math.min(audio.length, from + windowFrames);
        let squares = 0;
        let samples = 0;
        for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
          const data = audio.getChannelData(channel);
          for (let frame = from; frame < to; frame += 1) { squares += data[frame] * data[frame]; samples += 1; }
        }
        levels[index] = samples ? Math.sqrt(squares / samples) : 0;
        peak = Math.max(peak, levels[index]);
      }
      const threshold = Math.max(0.006, peak * 0.08);
      let first = 0;
      let last = windows - 1;
      while (first < windows && levels[first] < threshold) first += 1;
      while (last > first && levels[last] < threshold) last -= 1;
      const startFrame = first >= windows ? 0 : Math.max(0, first * windowFrames - Math.round(audio.sampleRate * 0.03));
      const endFrame = first >= windows ? audio.length : Math.min(audio.length, (last + 1) * windowFrames + Math.round(audio.sampleRate * 0.04));
      const offset = startFrame / audio.sampleRate;
      const duration = Math.max(0.05, (endFrame - startFrame) / audio.sampleRate);

      await new Promise<void>(resolve => {
        const source = context.createBufferSource();
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(); } };
        source.buffer = audio;
        source.playbackRate.value = store?.settings.voiceConfirmation.rate ?? 1.35;
        source.connect(context.destination);
        activeVoiceSourceRef.current = source;
        activeVoiceAudioFinishRef.current = finish;
        source.onended = finish;
        source.start(0, offset, duration);
      });
      return true;
    } catch {
      return false;
    } finally {
      activeVoiceSourceRef.current = null;
      activeVoiceAudioFinishRef.current = null;
    }
  };
  const playRecordedTeamName = (team: Team, run: number) => team.hasVoiceClip
    ? playRecordedClip(() => window.footballPos.teamVoice.load(team.id), run)
    : Promise.resolve(false);
  const playCommonVoice = async (key: CommonVoiceKey, fallback: string, run: number) => {
    const hasClip = store?.settings.voiceConfirmation.commonClips.includes(key) ?? false;
    if (hasClip && await playRecordedClip(() => window.footballPos.commonVoice.load(key), run)) return;
    await speakPart(fallback, run);
  };
  const playTeamName = async (teamName: string, run: number) => {
    const team = teams.find(item => item.name === teamName);
    if (!team || run !== voiceRunRef.current) return false;
    if (await playRecordedTeamName(team, run)) return true;
    if (team.voiceName?.trim()) { await speakPart(team.voiceName.trim(), run); return true; }
    return false;
  };
  const voiceGap = (run: number) => new Promise<void>(resolve => window.setTimeout(() => resolve(), run === voiceRunRef.current ? 80 : 0));
  const shortVoiceGap = (run: number) => new Promise<void>(resolve => window.setTimeout(() => resolve(), run === voiceRunRef.current ? 45 : 0));
  const amountVoiceParts = (amount: number): { digits: CommonVoiceKey[]; unit?: CommonVoiceKey } => {
    const rounded = Math.round(Math.abs(amount));
    const units: { key: CommonVoiceKey; value: number }[] = [{ key: 'm', value: 1_000_000 }, { key: 'l', value: 100_000 }, { key: 'w', value: 10_000 }, { key: 'k', value: 1_000 }];
    const unit = units.find(item => rounded >= item.value && rounded % item.value === 0);
    const value = unit ? rounded / unit.value : rounded;
    return { digits: String(value).split('').filter(digit => /\d/.test(digit)) as CommonVoiceKey[], unit: unit?.key };
  };
  const playAmount = async (amount: number, run: number) => {
    const parts = amountVoiceParts(amount);
    for (const digit of parts.digits) {
      await playCommonVoice(digit, digit, run);
      if (run !== voiceRunRef.current) return;
      await shortVoiceGap(run);
    }
    if (parts.unit) await playCommonVoice(parts.unit, parts.unit.toUpperCase(), run);
  };
  const testCommonVoice = async () => {
    if (!store?.settings.voiceConfirmation.enabled) return;
    stopVoiceOutput();
    const run = voiceRunRef.current;
    await playCommonVoice('body', 'Body', run);
    await voiceGap(run);
    await playAmount(250_000, run);
  };
  const speakBetConfirmation = async (match: Match, rule: Rule, selection: Selection, amount: number, quickEntryTeam?: string) => {
    if (!store?.settings.voiceConfirmation.enabled) return;
    stopVoiceOutput();
    const run = voiceRunRef.current;
    let saidTeam = false;
    if (rule.market === 'body') saidTeam = await playTeamName(selection === 'home' ? match.home : match.away, run);
    else if (quickEntryTeam) saidTeam = await playTeamName(quickEntryTeam, run);
    else {
      const saidHome = await playTeamName(match.home, run);
      if (saidHome) await voiceGap(run);
      const saidAway = await playTeamName(match.away, run);
      saidTeam = saidHome || saidAway;
    }
    if (run !== voiceRunRef.current) return;
    if (saidTeam) await voiceGap(run);
    const action: CommonVoiceKey = rule.market === 'body' ? 'body' : selection === 'up' ? 'over' : 'down';
    await playCommonVoice(action, action === 'body' ? 'Body' : action === 'over' ? 'Over' : 'Down', run);
    if (run !== voiceRunRef.current) return;
    await voiceGap(run);
    await playAmount(amount, run);
  };
  const askConfirm = (message: string) => new Promise<boolean>(resolve => setConfirmation({ message, resolve }));
  const closeConfirm = (confirmed: boolean) => { confirmation?.resolve(confirmed); setConfirmation(null); };
  const updateBookmakerSettings = (next: Partial<BookmakerSettings>) => {
    if (!store) return;
    void save({ ...store, settings: { ...store.settings, bookmakerSettings: { ...store.settings.bookmakerSettings, [activeBookmaker]: { ...activeCommission, ...next } } } });
  };
  const renameChannel = async (channel: Channel, value: string) => {
    if (!store) return;
    const name = value.trim();
    if (!name) return flash('Channel name အလွတ်ထား၍မရပါ။');
    if (channels.some(item => item.id !== channel.id && item.name.toLowerCase() === name.toLowerCase())) return flash(`“${name}” channel name ရှိပြီးသားဖြစ်သည်။`);
    if (name === channel.name) return;
    await save({ ...store, settings: { ...store.settings, channels: channels.map(item => item.id === channel.id ? { ...item, name } : item) } });
    flash(`${channel.name} ကို ${name} အဖြစ်ပြောင်းပြီးပါပြီ။`);
  };
  const toggleChannel = async (channel: Channel) => {
    if (!store || channel.id === activeBookmaker) return flash('လက်ရှိအသုံးပြုနေသော channel ကို disable မလုပ်မီ အခြား channel ရွေးပါ။');
    if (channel.enabled && enabledChannels.length <= 1) return flash('အနည်းဆုံး channel တစ်ခု ဖွင့်ထားရပါမည်။');
    await save({ ...store, settings: { ...store.settings, channels: channels.map(item => item.id === channel.id ? { ...item, enabled: !item.enabled } : item) } });
    flash(`${channel.name} ကို ${channel.enabled ? 'ပိတ်' : 'ဖွင့်'}ပြီးပါပြီ။ Data များမပျက်ပါ။`);
  };
  const addChannel = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!store) return;
    const name = newChannelName.trim();
    if (!name) return flash('Channel name ထည့်ပါ။');
    if (channels.some(channel => channel.name.toLowerCase() === name.toLowerCase())) return flash(`“${name}” channel ရှိပြီးသားဖြစ်သည်။`);
    const id = `channel-${uid()}`;
    const messengerSettings = store.settings.bookmakerSettings.messenger ?? fallbackSummarySettings();
    await save({ ...store, settings: { ...store.settings, channels: [...channels, { id, name, enabled: true }], bookmakerSettings: { ...store.settings.bookmakerSettings, [id]: { ...messengerSettings } } } });
    setNewChannelName('');
    setActiveBookmaker(id);
    flash(`${name} ကို Messenger commission default ဖြင့် ထည့်ပြီးပါပြီ။`);
  };
  const resetMatchForm = () => { setEditingMatchId(null); setMatchForm({ time: '19:00', nextDay: false, home: '', away: '', rules: [defaultRule('body'), defaultRule('total')] }); };
  const addMatch = async (e: React.FormEvent) => { e.preventDefault(); if (!store || !matchForm.home.trim() || !matchForm.away.trim()) return flash('အသင်းနှစ်သင်းလုံး ထည့်ပါ။'); const previous = editingMatchId ? matches.find(x => x.id === editingMatchId) : undefined; const history = previous?.rules.filter(rule => rule.status === 'closed') ?? []; const provisionalIds = new Set(previous?.rules.filter(rule => rule.provisional).map(rule => rule.id) ?? []); const finalizedRules = previous ? matchForm.rules.map(rule => provisionalIds.has(rule.id) ? { ...rule, provisional: false } : rule) : matchForm.rules; const nextDayKickoff = matchForm.nextDay || matchForm.time < '06:00'; const updated: Match = { id: previous?.id || uid(), time: matchForm.time, rules: previous ? [...history, ...finalizedRules] : matchForm.rules, date: activeDate, bookmaker: previous?.bookmaker ?? activeBookmaker, home: matchForm.home.trim(), away: matchForm.away.trim(), homeScore: previous?.homeScore ?? null, awayScore: previous?.awayScore ?? null, postponed: previous?.postponed ?? false, kickoffAt: kickoffIso(activeDate, matchForm.time, nextDayKickoff), apiFixtureId: previous?.apiFixtureId, apiHome: previous?.apiHome, apiAway: previous?.apiAway, apiSidesReversed: previous?.apiSidesReversed, apiStatus: previous?.apiStatus, apiLeague: previous?.apiLeague, resultSource: previous?.resultSource, resultCheckedAt: previous?.resultCheckedAt }; const provisionalBets = previous ? bets.filter(bet => bet.matchId === previous.id && provisionalIds.has(bet.ruleId)) : []; if (provisionalBets.length && !await askConfirm(`Temporary rule ဖြင့် ထိုးထားသော record ${provisionalBets.length} ခုကို ယခု actual rule ဖြင့် update လုပ်မလား?`)) return; const refreshedBets = previous ? bets.map(bet => { const newRule = updated.rules.find(rule => rule.id === bet.ruleId); return newRule && provisionalIds.has(bet.ruleId) ? { ...bet, ruleSnapshot: structuredClone(newRule) } : bet; }) : bets; await save({ ...store, matches: previous ? matches.map(x => x.id === previous.id ? updated : x) : [...matches, updated], bets: refreshedBets }); resetMatchForm(); flash(previous && provisionalBets.length ? `Actual rule ကိုအတည်ပြုပြီး record ${provisionalBets.length} ခုကို update လုပ်ပြီးပါပြီ။` : previous ? 'Active rule များကို ပြင်ပြီးပါပြီ။ ပိတ်ထားသော rule history မပြောင်းပါ။' : nextDayKickoff ? `Match ကို ${nextDate(activeDate)} မနက်အစောပိုင်း kickoff အဖြစ် သိမ်းပြီးပါပြီ။` : 'Match နှင့် temporary default rule များကို သိမ်းပြီးပါပြီ။'); };
  const parseBulkMatches = () => {
    setBulkError(''); setBulkPreview(null);
    try {
      const input: unknown = JSON.parse(bulkJson);
      if (!Array.isArray(input) || input.length === 0) throw new Error('JSON သည် match object များပါသော array ဖြစ်ရမည်။');
      if (input.length > 100) throw new Error('တစ်ကြိမ်လျှင် match 100 ပွဲအထိသာ ထည့်နိုင်ပါသည်။');
      const rows: BulkMatchRow[] = input.map((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Row ${index + 1}: object မဟုတ်ပါ။`);
        const item = value as Record<string, unknown>;
        if (typeof item.nextDay !== 'boolean') throw new Error(`Row ${index + 1}: nextDay ကို true သို့မဟုတ် false ထည့်ပါ။`);
        if (typeof item.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.time)) throw new Error(`Row ${index + 1}: time ကို HH:mm ဖြင့်ထည့်ပါ။`);
        if (!Array.isArray(item.teams) || item.teams.length !== 2 || item.teams.some(team => typeof team !== 'string' || !team.trim())) throw new Error(`Row ${index + 1}: teams တွင် အသင်းနှစ်သင်း အတိအကျလိုအပ်ပါသည်။`);
        const left = String(item.teams[0]).trim(); const right = String(item.teams[1]).trim();
        if (left === right) throw new Error(`Row ${index + 1}: ဘယ်/ညာအသင်း တူနေပါသည်။`);
        const bd = typeof item.bd === 'string' && item.bd.trim() ? item.bd.trim().toUpperCase() : undefined;
        const ou = typeof item.ou === 'string' && item.ou.trim() ? item.ou.trim().toUpperCase() : undefined;
        if (!bd && !ou) throw new Error(`Row ${index + 1}: bd သို့မဟုတ် ou အနည်းဆုံးတစ်ခု လိုအပ်ပါသည်။`);
        if (bd && !parseMyanmarOdds(bd)) throw new Error(`Row ${index + 1}: BD rule “${bd}” ကို နားမလည်ပါ။`);
        if (ou && !parseMyanmarOdds(ou)) throw new Error(`Row ${index + 1}: O/U rule “${ou}” ကို နားမလည်ပါ။`);
        return { nextDay: item.nextDay, time: item.time, teams: [left, right], bd, ou };
      });
      const rowKeys = new Set<string>();
      rows.forEach((row, index) => {
        const key = `${row.nextDay}:${row.time}:${row.teams[0]}:${row.teams[1]}`.toLowerCase();
        if (rowKeys.has(key)) throw new Error(`Row ${index + 1}: JSON ထဲတွင် match ထပ်နေပါသည်။`);
        rowKeys.add(key);
        const kickoff = kickoffIso(activeDate, row.time, row.nextDay);
        if (dayMatches.some(match => (match.kickoffAt === kickoff || (match.time === row.time && kickoffLocalDate(match.kickoffAt) === kickoffLocalDate(kickoff))) && match.home === row.teams[0] && match.away === row.teams[1])) throw new Error(`Row ${index + 1}: ${row.teams[0]} vs ${row.teams[1]} ကို ထည့်ပြီးသားဖြစ်သည်။`);
      });
      const missingCodes: Record<string, string> = {};
      [...new Set(rows.flatMap(row => row.teams))].filter(name => !teams.some(team => team.name === name)).forEach(name => { missingCodes[name] = ''; });
      setBulkPreview({ rows, missingCodes });
    } catch (error) { setBulkError(error instanceof Error ? error.message : 'JSON ကိုဖတ်မရပါ။'); }
  };
  const saveBulkMatches = async () => {
    if (!store || !bulkPreview) return;
    const entries = Object.entries(bulkPreview.missingCodes);
    const normalizedCodes = entries.map(([name, code]) => [name, code.trim().toLowerCase().replace(/\s+/g, '')] as const);
    const invalid = normalizedCodes.find(([, code]) => !/^[a-z0-9]+$/.test(code));
    if (invalid) return setBulkError(`${invalid[0]} အတွက် English letter/number short code ထည့်ပါ။`);
    const allCodes = [...teams.map(team => team.code.toLowerCase()), ...normalizedCodes.map(([, code]) => code)];
    if (new Set(allCodes).size !== allCodes.length) return setBulkError('Short code ထပ်နေပါသည်။ မတူသော code များသုံးပါ။');
    const newTeams: Team[] = normalizedCodes.map(([name, code]) => ({ id: uid(), bookmaker: activeBookmaker, name, code }));
    const createdMatches: Match[] = bulkPreview.rows.map(row => ({
      id: uid(), date: activeDate, bookmaker: activeBookmaker, time: row.time, home: row.teams[0], away: row.teams[1],
      homeScore: null, awayScore: null, postponed: false, kickoffAt: kickoffIso(activeDate, row.time, row.nextDay),
      rules: [...(row.bd ? [ruleFromCode('body', row.bd)] : []), ...(row.ou ? [ruleFromCode('total', row.ou)] : [])],
    }));
    await save({ ...store, teams: [...allTeams, ...newTeams], matches: [...matches, ...createdMatches] });
    setBulkPreview(null); setBulkJson(''); setBulkOpen(false); setBulkError('');
    flash(`Match ${createdMatches.length} ပွဲ${newTeams.length ? ` · Team အသစ် ${newTeams.length} သင်း` : ''} ကို တစ်ခါတည်းထည့်ပြီးပါပြီ။`);
  };
  const saveResult = async (m: Match, homeScore: string, awayScore: string, postponed: boolean) => { if (!store) return; if (!postponed && (homeScore === '' || awayScore === '')) return flash('Result နှစ်ဖက်လုံး ထည့်ပါ၊ သို့မဟုတ် P:P ကိုရွေးပါ။'); const updated = { ...m, homeScore: postponed ? null : Number(homeScore), awayScore: postponed ? null : Number(awayScore), postponed, resultSource: 'manual' as const }; await save({ ...store, matches: matches.map(x => x.id === m.id ? updated : x) }); flash(postponed ? 'P:P / Refund အဖြစ်သိမ်းပြီးပါပြီ။' : 'Result သိမ်းပြီး settlement ကို update လုပ်ပြီးပါပြီ။'); };
  const resetBetForm = () => { setEditingBetId(null); setInsertAfterBetId(null); setBetForm({ matchId: '', ruleId: '', selection: 'home', note: '', amount: '', lateReceivedAt: '', lateReason: '' }); };
  const addBet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store || !selectedMatch || !selectedRule || Number(betForm.amount) <= 0) return flash('Match, rule နှင့် လောင်းငွေကိုရွေးပါ။');
    let lateEntry = false;
    let lateReason = '';
    let placedAt = new Date().toISOString();
    if (selectedRule.status === 'closed') {
      if (!betForm.lateReceivedAt) return flash('Late entry အတွက် လက်ခံရရှိချိန် (Received time) ထည့်ပါ။');
      const received = new Date(betForm.lateReceivedAt);
      if (Number.isNaN(received.valueOf()) || (selectedRule.closedAt && received > new Date(selectedRule.closedAt))) {
        return flash('Received time သည် rule ပိတ်ချိန်မတိုင်မီ ဖြစ်ရမည်။');
      }
      if (!betForm.lateReason.trim()) return flash('Late entry ဖြစ်ရသည့် အကြောင်းရင်း ထည့်ပါ။');
      lateEntry = true;
      lateReason = betForm.lateReason.trim();
      placedAt = received.toISOString();
    }
    const isEditing = Boolean(editingBetId);
    const existingDayBets = sortBets(bets.filter(bet => bet.date === selectedMatch.date && bet.bookmaker === activeBookmaker && bet.id !== editingBetId));
    const insertAt = !isEditing && insertAfterBetId ? Math.max(0, existingDayBets.findIndex(bet => bet.id === insertAfterBetId) + 1) : existingDayBets.length;
    const previousBet = editingBetId ? bets.find(bet => bet.id === editingBetId) : undefined;
    const updated: Bet = {
      id: editingBetId || uid(),
      date: selectedMatch.date,
      bookmaker: selectedMatch.bookmaker,
      matchId: selectedMatch.id,
      ruleId: selectedRule.id,
      selection: betForm.selection,
      note: betForm.note.trim(),
      amount: Number(betForm.amount),
      ruleSnapshot: structuredClone(selectedRule),
      placedAt,
      lateEntry,
      lateReason,
      sortOrder: isEditing ? previousBet?.sortOrder : insertAt,
    };
    const reorderedDayBets = isEditing ? [] : existingDayBets.map((bet, index) => ({ ...bet, sortOrder: index >= insertAt ? index + 1 : index }));
    const nextBets = isEditing
      ? bets.map(x => x.id === editingBetId ? updated : x)
      : [...bets.filter(bet => bet.date !== selectedMatch.date || bet.bookmaker !== activeBookmaker), ...reorderedDayBets, updated];
    await save({ ...store, bets: nextBets });
    void speakBetConfirmation(selectedMatch, selectedRule, betForm.selection, Number(betForm.amount));
    resetBetForm();
    flash(isEditing ? 'လောင်းမှတ်တမ်း ပြင်ပြီးပါပြီ။' : lateEntry ? 'Late entry ကို rule အဟောင်းဖြင့် သိမ်းပြီးပါပြီ။' : 'လောင်းမှတ်တမ်း သိမ်းပြီးပါပြီ။');
  };
  const saveQuickBet = async (request: QuickRequest, match: Match) => {
    if (!store) return;
    const market: Market = request.action === 'b' ? 'body' : 'total';
    const rule = match.rules.find(item => item.market === market && item.status !== 'closed');
    if (!rule) return flash(`${match.home} vs ${match.away} အတွက် ${market === 'body' ? 'BD' : 'O/U'} ဖွင့်ထားသော rule မရှိသေးပါ။`);
    const selection: Selection = request.action === 'b'
      ? (match.home === request.team.name ? 'home' : 'away')
      : request.action === 'u' ? 'up' : 'down';
    const prior = sortBets(bets.filter(item => item.date === activeDate && item.bookmaker === activeBookmaker));
    const requestedIndex = insertAfterBetId ? prior.findIndex(item => item.id === insertAfterBetId) + 1 : prior.length;
    const insertAt = requestedIndex > 0 ? requestedIndex : prior.length;
    const shifted = prior.map((item, index) => ({ ...item, sortOrder: index >= insertAt ? index + 1 : index }));
    const bet: Bet = { id: uid(), date: activeDate, bookmaker: activeBookmaker, matchId: match.id, ruleId: rule.id, selection, note: '', amount: request.amount, sortOrder: insertAt, ruleSnapshot: structuredClone(rule), placedAt: new Date().toISOString(), lateEntry: false, lateReason: '' };
    await save({ ...store, bets: [...bets.filter(item => item.date !== activeDate || item.bookmaker !== activeBookmaker), ...shifted, bet] });
    void speakBetConfirmation(match, rule, selection, request.amount, request.team.name);
    setQuickEntry(''); setQuickCandidates(null); setInsertAfterBetId(null);
    const choice = market === 'body' ? (selection === 'home' ? match.home : match.away) : selection === 'up' ? 'Up' : 'Down';
    flash(`✓ ${match.home} vs ${match.away} · ${choice} · ${money(request.amount)} Ks သိမ်းပြီးပါပြီ။`);
  };
  const submitQuickEntry = async () => {
    const parsed = parseQuickEntry(quickEntry, teams);
    if (typeof parsed === 'string') return flash(parsed);
    const candidates = dayMatches.filter(match => match.home === parsed.team.name || match.away === parsed.team.name);
    if (candidates.length === 0) return flash(`${parsed.team.name} ပါသော ${activeDate} match မတွေ့ပါ။`);
    if (candidates.length > 1) { setQuickCandidates({ request: parsed, matches: candidates }); return; }
    await saveQuickBet(parsed, candidates[0]);
  };
  const stopTeamVoiceRecording = () => {
    if (recordingTimeoutRef.current !== null) { window.clearTimeout(recordingTimeoutRef.current); recordingTimeoutRef.current = null; }
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
  };
  const startTeamVoiceRecording = async (team: Team) => {
    if (!store || recordingTeamId || recordingCommonKey) return;
    if (!navigator.mediaDevices?.getUserMedia || !('MediaRecorder' in window)) return flash('ဤစက်တွင် microphone recording ကို မသုံးနိုင်ပါ။');
    try {
      stopVoiceOutput();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordingStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recordingChunksRef.current = [];
      recorder.ondataavailable = event => { if (event.data.size) recordingChunksRef.current.push(event.data); };
      recorder.onerror = () => flash('အသံဖမ်းနေစဉ် error ဖြစ်ပါသည်။');
      recorder.onstop = async () => {
        if (recordingTimeoutRef.current !== null) { window.clearTimeout(recordingTimeoutRef.current); recordingTimeoutRef.current = null; }
        stream.getTracks().forEach(track => track.stop());
        recordingStreamRef.current = null;
        mediaRecorderRef.current = null;
        setRecordingTeamId(null);
        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        recordingChunksRef.current = [];
        if (!blob.size) return flash('အသံမရပါ။ ထပ်မံဖမ်းကြည့်ပါ။');
        setVoiceClipBusyId(team.id);
        try {
          await window.footballPos.teamVoice.save(team.id, new Uint8Array(await blob.arrayBuffer()));
          const next = { ...store, teams: allTeams.map(item => item.id === team.id ? { ...item, hasVoiceClip: true } : item) };
          await save(next);
          flash(`${team.name} အသံကို သိမ်းပြီးပါပြီ။`);
        } catch (error) {
          flash(error instanceof Error ? error.message : 'အသံကို မသိမ်းနိုင်ပါ။');
        } finally { setVoiceClipBusyId(null); }
      };
      recorder.start();
      setRecordingTeamId(team.id);
      recordingTimeoutRef.current = window.setTimeout(stopTeamVoiceRecording, 4000);
    } catch (error) {
      recordingStreamRef.current?.getTracks().forEach(track => track.stop());
      recordingStreamRef.current = null;
      mediaRecorderRef.current = null;
      setRecordingTeamId(null);
      flash(error instanceof Error ? `Microphone မဖွင့်နိုင်ပါ: ${error.message}` : 'Microphone permission လိုအပ်ပါသည်။');
    }
  };
  const startCommonVoiceRecording = async (key: CommonVoiceKey, label: string) => {
    if (!store || recordingTeamId || recordingCommonKey) return;
    if (!navigator.mediaDevices?.getUserMedia || !('MediaRecorder' in window)) return flash('ဤစက်တွင် microphone recording ကို မသုံးနိုင်ပါ။');
    try {
      stopVoiceOutput();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordingStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recordingChunksRef.current = [];
      recorder.ondataavailable = event => { if (event.data.size) recordingChunksRef.current.push(event.data); };
      recorder.onerror = () => flash('အသံဖမ်းနေစဉ် error ဖြစ်ပါသည်။');
      recorder.onstop = async () => {
        if (recordingTimeoutRef.current !== null) { window.clearTimeout(recordingTimeoutRef.current); recordingTimeoutRef.current = null; }
        stream.getTracks().forEach(track => track.stop());
        recordingStreamRef.current = null;
        mediaRecorderRef.current = null;
        setRecordingCommonKey(null);
        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        recordingChunksRef.current = [];
        if (!blob.size) return flash('အသံမရပါ။ ထပ်မံဖမ်းကြည့်ပါ။');
        setCommonVoiceBusyKey(key);
        try {
          await window.footballPos.commonVoice.save(key, new Uint8Array(await blob.arrayBuffer()));
          const clips = Array.from(new Set([...store.settings.voiceConfirmation.commonClips, key]));
          await save({ ...store, settings: { ...store.settings, voiceConfirmation: { ...store.settings.voiceConfirmation, commonClips: clips } } });
          flash(`${label} အသံကို သိမ်းပြီးပါပြီ။`);
        } catch (error) {
          flash(error instanceof Error ? error.message : 'အသံကို မသိမ်းနိုင်ပါ။');
        } finally { setCommonVoiceBusyKey(null); }
      };
      recorder.start();
      setRecordingCommonKey(key);
      recordingTimeoutRef.current = window.setTimeout(stopTeamVoiceRecording, 3000);
    } catch (error) {
      recordingStreamRef.current?.getTracks().forEach(track => track.stop());
      recordingStreamRef.current = null;
      mediaRecorderRef.current = null;
      setRecordingCommonKey(null);
      flash(error instanceof Error ? `Microphone မဖွင့်နိုင်ပါ: ${error.message}` : 'Microphone permission လိုအပ်ပါသည်။');
    }
  };
  const previewCommonVoice = async (key: CommonVoiceKey) => {
    stopVoiceOutput();
    const run = voiceRunRef.current;
    if (!await playRecordedClip(() => window.footballPos.commonVoice.load(key), run)) flash('သိမ်းထားသောအသံကို မတွေ့ပါ။');
  };
  const removeCommonVoice = async (key: CommonVoiceKey, label: string) => {
    if (!store || !await askConfirm(`${label} အတွက် ဖမ်းထားသောအသံကို ဖျက်မလား?\n\nဖျက်ပြီးလျှင် system voice ကို ပြန်သုံးမည်။`)) return;
    setCommonVoiceBusyKey(key);
    try {
      await window.footballPos.commonVoice.remove(key);
      await save({ ...store, settings: { ...store.settings, voiceConfirmation: { ...store.settings.voiceConfirmation, commonClips: store.settings.voiceConfirmation.commonClips.filter(item => item !== key) } } });
      flash(`${label} အသံကို ဖျက်ပြီး system voice fallback ပြန်သုံးပါမည်။`);
    } finally { setCommonVoiceBusyKey(null); }
  };
  const previewTeamVoice = async (team: Team) => {
    stopVoiceOutput();
    const run = voiceRunRef.current;
    if (!await playRecordedTeamName(team, run)) flash('သိမ်းထားသောအသံကို မတွေ့ပါ။');
  };
  const removeTeamVoice = async (team: Team) => {
    if (!store || !await askConfirm(`${team.name} အတွက် ဖမ်းထားသောအသံကို ဖျက်မလား?`)) return;
    setVoiceClipBusyId(team.id);
    try {
      await window.footballPos.teamVoice.remove(team.id);
      await save({ ...store, teams: allTeams.map(item => item.id === team.id ? { ...item, hasVoiceClip: false } : item) });
      flash(`${team.name} အသံကို ဖျက်ပြီးပါပြီ။`);
    } finally { setVoiceClipBusyId(null); }
  };
  const addTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store) return;
    const name = teamForm.name.trim(); const code = teamForm.code.trim().toLowerCase().replace(/\s+/g, ''); const voiceName = teamForm.voiceName.trim();
    if (!name || !code) return flash('Team name နှင့် short code ထည့်ပါ။');
    if (!/^[a-z0-9]+$/.test(code)) return flash('Short code ကို English letter နှင့် number များသာ သုံးပါ။');
    if (teams.some(team => team.code.toLowerCase() === code)) return flash(`“${code}” short code ကို အသုံးပြုပြီးသားဖြစ်သည်။`);
    await save({ ...store, teams: [...allTeams, { id: uid(), bookmaker: activeBookmaker, name, code, voiceName: voiceName || undefined }] });
    setTeamForm({ name: '', code: '', voiceName: '' }); flash(`${name} (${code}) ကို Team list ထဲထည့်ပြီးပါပြီ။`);
  };
  const deleteTeam = async (team: Team) => {
    if (!store || !await askConfirm(`${team.name} (${team.code}) ကို Team list မှဖျက်မလား?\n\nရှိပြီးသား match နှင့် record များကို မဖျက်ပါ။`)) return;
    if (team.hasVoiceClip) await window.footballPos.teamVoice.remove(team.id);
    await save({ ...store, teams: allTeams.filter(item => item.id !== team.id) });
    flash(`${team.name} ကို Team list မှဖျက်ပြီးပါပြီ။`);
  };
  const deleteAllTeams = async () => {
    if (!store || teams.length === 0 || deletingAllTeams) return;
    const recordedCount = teams.filter(team => team.hasVoiceClip).length;
    const confirmed = await askConfirm(`${activeChannel?.name ?? activeBookmaker} ရှိ Team ${teams.length} သင်းလုံးကို ဖျက်မလား?\n\nShort code၊ API mapping နှင့် team voice recording ${recordedCount} ခုကိုပါ ဖျက်မည်။ အခြား channel team များ၊ ရှိပြီးသား match နှင့် လောင်းမှတ်တမ်းများကို မဖျက်ပါ။ ဤလုပ်ဆောင်ချက်ကို ပြန်ယူ၍မရပါ။`);
    if (!confirmed) return;
    setDeletingAllTeams(true);
    try {
      await Promise.all(teams.filter(team => team.hasVoiceClip).map(team => window.footballPos.teamVoice.remove(team.id)));
      await save({ ...store, teams: allTeams.filter(team => team.bookmaker !== activeBookmaker) });
      cancelEditingTeamCode();
      setTeamSearch('');
      setTeamForm({ name: '', code: '', voiceName: '' });
      flash(`Team ${teams.length} သင်းလုံးကို ဖျက်ပြီးပါပြီ။ Match နှင့် လောင်းမှတ်တမ်းများကို မပြောင်းပါ။`);
    } catch (error) {
      flash(error instanceof Error ? `Team များကို ဖျက်မရပါ: ${error.message}` : 'Team များကို ဖျက်မရပါ။');
    } finally {
      setDeletingAllTeams(false);
    }
  };
  const startEditingTeamCode = (team: Team) => { setEditingTeamId(team.id); setEditingTeamCode(team.code); setEditingTeamVoiceName(team.voiceName ?? ''); };
  const cancelEditingTeamCode = () => { setEditingTeamId(null); setEditingTeamCode(''); setEditingTeamVoiceName(''); };
  const saveTeamCode = async (team: Team) => {
    if (!store) return;
    const code = editingTeamCode.trim().toLowerCase().replace(/\s+/g, '');
    const voiceName = editingTeamVoiceName.trim();
    if (!code) return flash('Short code ထည့်ပါ။');
    if (!/^[a-z0-9]+$/.test(code)) return flash('Short code ကို English letter နှင့် number များသာ သုံးပါ။');
    if (teams.some(item => item.id !== team.id && item.code.toLowerCase() === code)) return flash(`“${code}” short code ကို အခြား Team တွင် အသုံးပြုပြီးသားဖြစ်သည်။`);
    await save({ ...store, teams: allTeams.map(item => item.id === team.id ? { ...item, code, voiceName: voiceName || undefined } : item) });
    cancelEditingTeamCode();
    flash(`${team.name} short code ကို “${code}” အဖြစ်ပြောင်းပြီးပါပြီ။`);
  };
  const editMatch = (m: Match) => { setEditingMatchId(m.id); setMatchForm({ time: m.time, nextDay: kickoffLocalDate(m.kickoffAt) === nextDate(m.date), home: m.home, away: m.away, rules: m.rules.filter(rule => rule.status !== 'closed') }); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const commitRuleChange = async (m: Match, drafts: Rule[]) => { const markets = drafts.map(rule => rule.market); const closing = m.rules.filter(rule => rule.status !== 'closed' && markets.includes(rule.market)).map(rule => `${rule.market === 'body' ? 'BD' : 'O/U'} ${rule.code}`).join(', '); if (!await askConfirm(`${closing || 'လက်ရှိအကြေး'} ကို ပိတ်ပြီး rule အသစ်ဖွင့်မလား?\n\nအရင်လောင်းမှတ်တမ်းများ မပျက်ပါ။`)) return false; const now = new Date().toISOString(); const activeDrafts = drafts.map(rule => ({ ...rule, status: 'active' as const, effectiveAt: now, closedAt: undefined })); const next: Match = { ...m, rules: [...m.rules.map(rule => rule.status === 'closed' || !markets.includes(rule.market) ? rule : { ...rule, status: 'closed' as const, closedAt: now }), ...activeDrafts] }; await save({ ...store!, matches: matches.map(x => x.id === m.id ? next : x) }); flash('Rule အသစ်ကိုဖွင့်ပြီး အဟောင်း rule ကို history အဖြစ်ပိတ်ထားပါပြီ။'); return true; };
  const deleteMatch = async (m: Match) => { const linked = bets.filter(x => x.matchId === m.id).length; if (!await askConfirm(`“${m.home} vs ${m.away}” ကိုဖျက်မလား? ချိတ်ထားသော လောင်းမှတ်တမ်း ${linked} ခုလည်း ဖျက်မည်။`)) return; await save({ ...store!, matches: matches.filter(x => x.id !== m.id), bets: bets.filter(x => x.matchId !== m.id) }); if (editingMatchId === m.id) resetMatchForm(); flash('Match နှင့် ချိတ်ထားသော record များ ဖျက်ပြီးပါပြီ။'); };
  const insertBetAfter = (s: Settlement) => {
    resetBetForm();
    setInsertAfterBetId(s.bet.id);
    setPage('ledger');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    flash(`No. ${daySettlements.findIndex(row => row.bet.id === s.bet.id) + 1} နောက်တွင် record အသစ်ထည့်ပါမည်။`);
  };
  const editBet = (s: Settlement) => {
    setEditingBetId(s.bet.id);
    setBetForm({
      matchId: s.bet.matchId,
      ruleId: s.bet.ruleId,
      selection: s.bet.selection,
      note: s.bet.note,
      amount: String(s.bet.amount),
      lateReceivedAt: s.bet.placedAt ? s.bet.placedAt.slice(0, 16) : '',
      lateReason: s.bet.lateReason || '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const deleteBet = async (s: Settlement) => { if (!await askConfirm(`ထိုးငွေ ${money(s.bet.amount)} Ks record ကိုဖျက်မလား?`)) return; const remainingDay = sortBets(bets.filter(x => x.date === s.bet.date && x.bookmaker === s.bet.bookmaker && x.id !== s.bet.id)).map((bet, index) => ({ ...bet, sortOrder: index })); await save({ ...store!, bets: [...bets.filter(x => x.date !== s.bet.date || x.bookmaker !== s.bet.bookmaker), ...remainingDay] }); if (editingBetId === s.bet.id) resetBetForm(); if (insertAfterBetId === s.bet.id) setInsertAfterBetId(null); flash('လောင်းမှတ်တမ်း ဖျက်ပြီးပါပြီ။'); };
  const saveApiKey = async () => {
    if (!apiKeyInput.trim()) return setApiMessage('API key ထည့်ပါ။');
    const saved = await window.footballPos.apiFootball.saveKey(apiKeyInput);
    setApiKeyInput(''); setApiKeyConfigured(saved);
    setApiMessage(saved ? 'API key ကို macOS ကာကွယ်ထားသော storage တွင် သိမ်းပြီးပါပြီ။' : 'API key ကို လုံခြုံစွာ မသိမ်းနိုင်ပါ။');
  };
  const testApi = async () => { setApiMessage('စမ်းသပ်နေသည်…'); const result = await window.footballPos.apiFootball.test(); setApiMessage(result.message); setApiKeyConfigured(result.ok || apiKeyConfigured); };
  const loadFixtureDate = async (date: string, refresh = false) => {
    const cached = refresh ? undefined : fixtureDateCache.current.get(date);
    if (cached) return cached;
    const fixtures = await window.footballPos.apiFootball.fixturesByDate(date);
    fixtureDateCache.current.set(date, fixtures);
    return fixtures;
  };
  const sortFixturesForMatch = (match: Match, fixtures: ApiFixture[]) => {
    const targetTime = new Date(match.kickoffAt ?? kickoffIso(match.date, match.time, match.time < '06:00')).valueOf();
    const left = teams.find(team => team.name === match.home); const right = teams.find(team => team.name === match.away);
    const knownTeamHits = (fixture: ApiFixture) => [left, right].filter(team => team && (teamMatchesApi(team, fixture.homeId, fixture.home) || teamMatchesApi(team, fixture.awayId, fixture.away))).length;
    return [...fixtures].sort((a, b) => knownTeamHits(b) - knownTeamHits(a) || Math.abs(new Date(a.kickoffAt).valueOf() - targetTime) - Math.abs(new Date(b.kickoffAt).valueOf() - targetTime));
  };
  const openFixtureForMatch = async (match: Match) => {
    const searchDate = kickoffLocalDate(match.kickoffAt) || (match.time < '06:00' ? nextDate(match.date) : match.date);
    const fixtures = sortFixturesForMatch(match, await loadFixtureDate(searchDate));
    setFixtureFilter(''); setFixturePicker({ match, fixtures, searchDate });
  };
  const teamMatchesApi = (team: Team | undefined, apiId: number, apiName: string) => {
    if (!team) return false;
    if (team.apiTeamId) return team.apiTeamId === apiId;
    const knownName = team.apiName?.trim() || team.voiceName?.trim();
    return Boolean(knownName && normalizeApiName(knownName) === normalizeApiName(apiName));
  };
  const mappedFixtureForMatch = (match: Match, fixtures: ApiFixture[], teamList: Team[]) => {
    const left = teamList.find(team => team.name === match.home);
    const right = teamList.find(team => team.name === match.away);
    const targetTime = new Date(match.kickoffAt ?? kickoffIso(match.date, match.time, match.time < '06:00')).valueOf();
    const candidates = fixtures.flatMap(fixture => {
      if (Math.abs(new Date(fixture.kickoffAt).valueOf() - targetTime) > 3 * 60 * 60 * 1_000) return [];
      if (teamMatchesApi(left, fixture.homeId, fixture.home) && teamMatchesApi(right, fixture.awayId, fixture.away)) return [{ fixture, reversed: false }];
      if (teamMatchesApi(left, fixture.awayId, fixture.away) && teamMatchesApi(right, fixture.homeId, fixture.home)) return [{ fixture, reversed: true }];
      return [];
    });
    return candidates.length === 1 ? candidates[0] : null;
  };
  const matchWithFixture = (match: Match, fixture: ApiFixture, apiSidesReversed: boolean): Match => ({
    ...match,
    time: new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Yangon', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(fixture.kickoffAt)),
    kickoffAt: fixture.kickoffAt, apiFixtureId: fixture.id, apiHome: fixture.home, apiAway: fixture.away, apiSidesReversed,
    apiStatus: fixture.status, apiLeague: fixture.league, resultCheckedAt: new Date().toISOString(),
    homeScore: null, awayScore: null, resultSource: undefined,
  });
  const learnApiTeams = (teamList: Team[], match: Match, fixture: ApiFixture, reversed: boolean) => {
    const leftApi = reversed ? { id: fixture.awayId, name: fixture.away } : { id: fixture.homeId, name: fixture.home };
    const rightApi = reversed ? { id: fixture.homeId, name: fixture.home } : { id: fixture.awayId, name: fixture.away };
    return teamList.map(team => team.name === match.home ? { ...team, apiTeamId: leftApi.id, apiName: leftApi.name } : team.name === match.away ? { ...team, apiTeamId: rightApi.id, apiName: rightApi.name } : team);
  };
  const learnExistingApiNames = (teamList: Team[]) => matches.filter(match => match.bookmaker === activeBookmaker).reduce((knownTeams, match) => {
    if (!match.apiHome || !match.apiAway) return knownTeams;
    const leftName = match.apiSidesReversed ? match.apiAway : match.apiHome;
    const rightName = match.apiSidesReversed ? match.apiHome : match.apiAway;
    return knownTeams.map(team => team.name === match.home && !team.apiName ? { ...team, apiName: leftName } : team.name === match.away && !team.apiName ? { ...team, apiName: rightName } : team);
  }, teamList);
  const linkApiFixture = async (match: Match) => {
    if (!apiKeyConfigured) return flash('Settings တွင် API-Football key အရင်ထည့်ပါ။');
    try {
      setBulkApiQueue([]);
      await openFixtureForMatch(match);
    } catch (error) { flash(error instanceof Error ? error.message : 'Fixture ရှာမရပါ။'); }
  };
  const searchApiFixtureDate = async () => {
    if (!fixturePicker || fixturePickerLoading) return;
    setFixturePickerLoading(true);
    try {
      const fixtures = await loadFixtureDate(fixturePicker.searchDate, true);
      const sorted = sortFixturesForMatch(fixturePicker.match, fixtures);
      setFixtureFilter('');
      setFixturePicker(current => current ? { ...current, fixtures: sorted } : null);
    } catch (error) { flash(error instanceof Error ? error.message : 'Fixture ရှာမရပါ။'); }
    finally { setFixturePickerLoading(false); }
  };
  const chooseApiFixture = async (fixture: ApiFixture, apiSidesReversed: boolean) => {
    if (!store || !fixturePicker) return;
    const alreadyLinked = matches.find(match => match.id !== fixturePicker.match.id
      && match.date === fixturePicker.match.date
      && match.bookmaker === fixturePicker.match.bookmaker
      && match.apiFixtureId === fixture.id);
    if (alreadyLinked) return flash(`ဒီ API fixture ကို ${alreadyLinked.home} vs ${alreadyLinked.away} နှင့် ချိတ်ထားပြီးသားဖြစ်သည်။`);
    const updated = matchWithFixture(fixturePicker.match, fixture, apiSidesReversed);
    const remaining = bulkApiQueue.filter(id => id !== updated.id);
    let updatedMatches = matches.map(match => match.id === updated.id ? updated : match);
    let updatedTeams = learnApiTeams(teams, fixturePicker.match, fixture, apiSidesReversed);
    const usedFixtureIds = new Set(updatedMatches
      .filter(match => match.apiFixtureId && match.date === fixturePicker.match.date && match.bookmaker === fixturePicker.match.bookmaker)
      .map(match => match.apiFixtureId as number));
    const unresolved: string[] = [];
    let newlyAutoLinked = 0;
    for (const id of remaining) {
      const queued = updatedMatches.find(match => match.id === id);
      if (!queued) continue;
      const date = kickoffLocalDate(queued.kickoffAt) || (queued.time < '06:00' ? nextDate(queued.date) : queued.date);
      const mapped = mappedFixtureForMatch(queued, fixtureDateCache.current.get(date) ?? [], updatedTeams);
      if (!mapped || usedFixtureIds.has(mapped.fixture.id)) { unresolved.push(id); continue; }
      const linked = matchWithFixture(queued, mapped.fixture, mapped.reversed);
      updatedMatches = updatedMatches.map(match => match.id === id ? linked : match);
      updatedTeams = learnApiTeams(updatedTeams, queued, mapped.fixture, mapped.reversed);
      usedFixtureIds.add(mapped.fixture.id); newlyAutoLinked += 1;
    }
    await save({ ...store, teams: withActiveTeams(updatedTeams), matches: updatedMatches });
    setBulkApiQueue(unresolved);
    setFixturePicker(null);
    if (unresolved.length) {
      const next = updatedMatches.find(match => match.id === unresolved[0]);
      if (next) await openFixtureForMatch(next);
      flash(`Team mapping မှတ်ထားပြီး ${newlyAutoLinked ? `${newlyAutoLinked} ပွဲ ထပ်မံ auto-link လုပ်ခဲ့သည်။ ` : ''}ကျန် ${unresolved.length} ပွဲ။`);
    } else flash(`API Fixture #${fixture.id} ချိတ်ပြီး Team mapping မှတ်ထားပါပြီ${newlyAutoLinked ? ` · နောက်ထပ် ${newlyAutoLinked} ပွဲ auto-link ပြီးပါပြီ` : ''}။`);
  };
  const bulkLinkApiMatches = async () => {
    if (!store || bulkApiBusy) return;
    if (!apiKeyConfigured) return flash('Settings တွင် API-Football key အရင်ထည့်ပါ။');
    const targets = dayMatches.filter(match => !match.apiFixtureId);
    if (!targets.length) return flash('ဤစာရင်းရက်ရှိ match အားလုံး API ချိတ်ပြီးသားဖြစ်သည်။');
    setBulkApiBusy(true);
    try {
      const dates = [...new Set(targets.map(match => kickoffLocalDate(match.kickoffAt) || (match.time < '06:00' ? nextDate(match.date) : match.date)))];
      const fixturesByDate = new Map<string, ApiFixture[]>();
      for (const date of dates) fixturesByDate.set(date, await loadFixtureDate(date));
      let nextTeams = learnExistingApiNames(teams);
      let autoCount = 0;
      const unresolved: string[] = [];
      const usedFixtureIds = new Set(matches
        .filter(match => match.apiFixtureId && match.date === activeDate && match.bookmaker === activeBookmaker)
        .map(match => match.apiFixtureId as number));
      const nextMatches = matches.map(match => {
        if (!targets.some(target => target.id === match.id)) return match;
        const date = kickoffLocalDate(match.kickoffAt) || (match.time < '06:00' ? nextDate(match.date) : match.date);
        const mapped = mappedFixtureForMatch(match, fixturesByDate.get(date) ?? [], nextTeams);
        if (!mapped || usedFixtureIds.has(mapped.fixture.id)) { unresolved.push(match.id); return match; }
        autoCount += 1;
        usedFixtureIds.add(mapped.fixture.id);
        nextTeams = learnApiTeams(nextTeams, match, mapped.fixture, mapped.reversed);
        return matchWithFixture(match, mapped.fixture, mapped.reversed);
      });
      await save({ ...store, teams: withActiveTeams(nextTeams), matches: nextMatches });
      setBulkApiQueue(unresolved);
      if (unresolved.length) {
        const first = nextMatches.find(match => match.id === unresolved[0]);
        if (first) await openFixtureForMatch(first);
        flash(`${autoCount} ပွဲ auto-link ပြီးပါပြီ။ မသိသေးသော ${unresolved.length} ပွဲကို တစ်ပွဲစီရွေးပါ။`);
      } else flash(`Match ${autoCount} ပွဲလုံး API auto-link ပြီးပါပြီ။`);
    } catch (error) { flash(error instanceof Error ? error.message : 'API fixtures များကို မချိတ်နိုင်ပါ။'); }
    finally { setBulkApiBusy(false); }
  };
  const toggleApiSides = async (match: Match) => {
    if (!store || !match.apiFixtureId) return;
    const updated: Match = { ...match, apiSidesReversed: !match.apiSidesReversed, homeScore: match.resultSource === 'api-football' ? match.awayScore : match.homeScore, awayScore: match.resultSource === 'api-football' ? match.homeScore : match.awayScore };
    const nextStore = { ...store, matches: matches.map(item => item.id === match.id ? updated : item) };
    await save(nextStore);
    if (match.resultSource === 'api-football' && store.settings.automation.autoExportPdf) {
      const report = automatedReport(nextStore, match.date, match.bookmaker);
      if (report.count) await window.footballPos.data.exportPdfAuto(report.title, report.html);
    }
    flash(`API result ဘယ်/ညာကို ${updated.apiSidesReversed ? 'ပြောင်း' : 'မူရင်း'} mapping အဖြစ် ပြင်ပြီးပါပြီ။`);
  };
  const processReadyReports = async (baseStore: Store, candidateKeys: string[]) => {
    const exported = new Set(baseStore.settings.automation.exportedReports);
    const sent = new Set(baseStore.settings.viberDelivery.sentReports);
    const pending = new Set(baseStore.settings.viberDelivery.pendingReports);
    let delivery = baseStore.settings.viberDelivery;
    const candidateDates = [...new Set(candidateKeys.map(key => key.split(':')[0]).filter(Boolean))].sort();
    for (const date of candidateDates) {
      const channelReports = baseStore.settings.channels.filter(channel => channel.enabled).map(channel => {
        const bookmakerValue = channel.id;
        const key = `${date}:${bookmakerValue}`;
        const groupBets = baseStore.bets.filter(bet => bet.date === date && bet.bookmaker === bookmakerValue);
        const involvedIds = new Set(groupBets.map(bet => bet.matchId));
        const ready = groupBets.length > 0 && [...involvedIds].every(id => {
          const match = baseStore.matches.find(item => item.id === id);
          return Boolean(match && (match.postponed || (match.homeScore !== null && match.awayScore !== null)));
        });
        return { bookmakerValue, channelName: channel.name, key, hasBets: groupBets.length > 0, ready };
      });
      const readyUnsent = channelReports.filter(item => item.ready && !sent.has(item.key));
      if (delivery.autoSend && delivery.groupName.trim()) readyUnsent.forEach(item => pending.add(item.key));

      // Exporting can happen as soon as each report is complete. Delivery is grouped by
      // accounting date: wait for every enabled channel that has bets before opening
      // Viber, then send all ready PDFs back-to-back in this automation cycle.
      const filePaths = new Map<string, string>();
      for (const item of readyUnsent) {
        if (!baseStore.settings.automation.autoExportPdf) continue;
        try {
          const report = automatedReport(baseStore, date, item.bookmakerValue);
          if (!report.count) continue;
          filePaths.set(item.key, await window.footballPos.data.exportPdfAuto(report.title, report.html));
          exported.add(item.key);
        } catch (error) {
          delivery = { ...delivery, lastStatus: 'failed', lastMessage: error instanceof Error ? error.message : 'PDF auto export မအောင်မြင်ပါ။' };
        }
      }

      if (!delivery.autoSend || !delivery.groupName.trim()) continue;
      const unsentExpected = channelReports.filter(item => item.hasBets && !sent.has(item.key));
      if (!unsentExpected.length || !unsentExpected.every(item => item.ready)) continue;

      const sentLabels: string[] = [];
      let sendFailed = false;
      for (const item of unsentExpected) {
        try {
          let filePath = filePaths.get(item.key) ?? '';
          if (!filePath) {
            const report = automatedReport(baseStore, date, item.bookmakerValue);
            if (!report.count) continue;
            filePath = await window.footballPos.data.exportPdfAuto(report.title, report.html);
            exported.add(item.key);
          }
          const result = await window.footballPos.viber.sendFile(delivery.groupName, filePath);
          if (!result.ok) {
            delivery = { ...delivery, lastStatus: 'failed', lastMessage: result.message };
            sendFailed = true;
            break;
          }
          sent.add(item.key);
          pending.delete(item.key);
          sentLabels.push(item.channelName);
        } catch (error) {
          delivery = { ...delivery, lastStatus: 'failed', lastMessage: error instanceof Error ? error.message : 'PDF auto export/send မအောင်မြင်ပါ။' };
          sendFailed = true;
          break;
        }
      }
      if (sentLabels.length && !sendFailed) {
        delivery = { ...delivery, lastStatus: 'sent', lastMessage: `${date} ${sentLabels.join(' + ')} PDF ကို Viber group သို့ အလိုအလျောက်ပို့ပြီးပါပြီ။`, lastSentAt: new Date().toISOString() };
      }
    }
    return {
      ...baseStore,
      settings: {
        ...baseStore.settings,
        automation: { ...baseStore.settings.automation, exportedReports: [...exported] },
        viberDelivery: { ...delivery, sentReports: [...sent], pendingReports: [...pending] },
      },
    };
  };
  const reportKeysForDates = (dates: string[]) => [...new Set(dates)].flatMap(date => enabledChannels.map(channel => `${date}:${channel.id}`));
  const checkApiResults = async (manual = false) => {
    if (!store || !apiKeyConfigured || automationBusy) return;
    const linked = matches.filter(match => match.apiFixtureId && match.resultSource !== 'manual' && (!match.apiHome || !match.apiAway || !match.apiStatus || !finalApiStatuses.has(match.apiStatus) || match.homeScore === null || match.awayScore === null));
    const retryDeliveryKeys = store.settings.viberDelivery.autoSend ? store.settings.viberDelivery.pendingReports : [];
    const manualDeliveryKeys = manual && store.settings.viberDelivery.autoSend ? reportKeysForDates([activeDate]) : [];
    if (!linked.length && !retryDeliveryKeys.length && !manualDeliveryKeys.length) { if (manual) flash('စစ်ဆေးရန် ချိတ်ထားသော pending match မရှိပါ။'); return; }
    setAutomationBusy(true);
    try {
      if (!linked.length) {
        const sentBefore = new Set(store.settings.viberDelivery.sentReports).size;
        const deliveredStore = await processReadyReports(store, [...retryDeliveryKeys, ...manualDeliveryKeys]);
        await save(deliveredStore);
        if (manual) {
          const sentCount = new Set(deliveredStore.settings.viberDelivery.sentReports).size - sentBefore;
          flash(sentCount > 0 ? `Ready ဖြစ်သော PDF ${sentCount} ဖိုင်ကို Viber သို့ပို့ပြီးပါပြီ။` : 'လက်ရှိရက်၏ enabled channel report များကို စစ်ပြီးပါပြီ။ ပို့ရန် ready ဖြစ်သော PDF အသစ်မရှိပါ။');
        }
        return;
      }
      const fixtures: ApiFixture[] = [];
      const pendingDates = [...new Set(linked.map(match => kickoffLocalDate(match.kickoffAt) || match.date))].sort();
      for (const date of pendingDates) fixtures.push(...await window.footballPos.apiFootball.fixturesByDate(date));
      const byId = new Map(fixtures.map(fixture => [fixture.id, fixture]));
      let settledCount = 0;
      const checkedAt = new Date().toISOString();
      const nextMatches = matches.map(match => {
        if (!match.apiFixtureId || match.resultSource === 'manual') return match;
        const fixture = byId.get(match.apiFixtureId);
        if (!fixture) return match;
        const final = finalApiStatuses.has(fixture.status);
        const apiHomeScore = fixture.fullTimeHome ?? fixture.homeScore;
        const apiAwayScore = fixture.fullTimeAway ?? fixture.awayScore;
        const homeScore = match.apiSidesReversed ? apiAwayScore : apiHomeScore;
        const awayScore = match.apiSidesReversed ? apiHomeScore : apiAwayScore;
        if (final && homeScore !== null && awayScore !== null) { settledCount += match.homeScore === null || match.awayScore === null ? 1 : 0; return { ...match, homeScore, awayScore, postponed: false, apiHome: fixture.home, apiAway: fixture.away, apiLeague: fixture.league, apiStatus: fixture.status, resultSource: 'api-football' as const, resultCheckedAt: checkedAt }; }
        return { ...match, apiHome: fixture.home, apiAway: fixture.away, apiLeague: fixture.league, apiStatus: fixture.status, resultCheckedAt: checkedAt };
      });
      let nextStore: Store = { ...store, matches: nextMatches };
      await save(nextStore);
      // A result check is date-based, not tied to the channel currently selected in the UI.
      // When any channel has a match checked for an accounting date, evaluate every enabled channel so
      // a ready, unsent counterpart is not left behind until another result changes.
      const affectedDates = [
        ...linked.map(match => match.date),
        ...retryDeliveryKeys.map(key => key.split(':')[0]).filter(Boolean),
      ];
      const groupKeys = [...new Set([...reportKeysForDates(affectedDates), ...retryDeliveryKeys, ...manualDeliveryKeys])];
      const sentBefore = new Set(nextStore.settings.viberDelivery.sentReports).size;
      nextStore = await processReadyReports(nextStore, groupKeys);
      await save(nextStore);
      if (manual) {
        const sentCount = new Set(nextStore.settings.viberDelivery.sentReports).size - sentBefore;
        const resultMessage = settledCount ? `API မှ result ${settledCount} ပွဲ update လုပ်ပြီးပါပြီ။` : 'API စစ်ပြီးပါပြီ။ Final result အသစ်မရှိသေးပါ။';
        flash(sentCount > 0 ? `${resultMessage} PDF ${sentCount} ဖိုင်ကို Viber သို့ပို့ပြီးပါပြီ။` : resultMessage);
      }
    } catch (error) { if (manual) flash(error instanceof Error ? error.message : 'Result စစ်ဆေးမှု မအောင်မြင်ပါ။'); }
    finally { setAutomationBusy(false); }
  };
  checkApiResultsRef.current = checkApiResults;
  useEffect(() => {
    const automation = store?.settings.automation;
    if (!automation?.enabled || !apiKeyConfigured) { setNextAutomationCheckAt(null); return; }
    const pollMs = Math.max(5, automation.pollMinutes) * 60_000;
    const inWindow = () => inTimeWindow(myanmarClock(), automation.windowStart, automation.windowEnd);
    if (inWindow()) void checkApiResultsRef.current();
    setNextAutomationCheckAt(Date.now() + pollMs);
    const scheduler = window.setInterval(() => {
      setNextAutomationCheckAt(Date.now() + pollMs);
      if (inWindow()) void checkApiResultsRef.current();
    }, pollMs);
    const clock = window.setInterval(() => setAutomationClock(Date.now()), 1_000);
    return () => { window.clearInterval(scheduler); window.clearInterval(clock); };
  }, [store?.settings.automation.enabled, store?.settings.automation.pollMinutes, store?.settings.automation.windowStart, store?.settings.automation.windowEnd, apiKeyConfigured]);
  const exportTransferFile = async () => {
    if (!store || transferBusy) return;
    if (!dayMatches.length && !dayBets.length) return flash(`${activeDate} အတွက် export လုပ်ရန် data မရှိပါ။`);
    setTransferBusy(true);
    try {
      const matchIds = new Map(dayMatches.map(match => [match.id, match.sourceId ?? match.id]));
      const ruleIds = new Map(dayMatches.flatMap(match => match.rules.map(rule => [`${match.id}:${rule.id}`, rule.sourceId ?? rule.id] as const)));
      const referencedTeamNames = new Set(dayMatches.flatMap(match => [normalizeTeamName(match.home), normalizeTeamName(match.away)]));
      const transferTeams = teams.filter(team => referencedTeamNames.has(normalizeTeamName(team.name))).map(team => {
        const { bookmaker: _bookmaker, hasVoiceClip: _hasVoiceClip, sourceId, ...rest } = team;
        return { ...rest, id: sourceId ?? team.id };
      });
      const transferMatches = dayMatches.map(match => {
        const { bookmaker: _bookmaker, date: _date, sourceId, rules, ...rest } = match;
        return { ...rest, id: sourceId ?? match.id, rules: rules.map(rule => { const { sourceId: ruleSourceId, ...ruleRest } = rule; return { ...ruleRest, id: ruleSourceId ?? rule.id }; }) };
      });
      const transferBets = sortBets(dayBets).map(bet => {
        const { bookmaker: _bookmaker, date: _date, sourceId, ruleSnapshot, ...rest } = bet;
        const mappedRuleId = ruleIds.get(`${bet.matchId}:${bet.ruleId}`) ?? bet.ruleId;
        const snapshot = ruleSnapshot ? (() => { const { sourceId: snapshotSourceId, ...snapshotRest } = ruleSnapshot; return { ...snapshotRest, id: snapshotSourceId ?? mappedRuleId }; })() : undefined;
        return { ...rest, id: sourceId ?? bet.id, matchId: matchIds.get(bet.matchId) ?? bet.matchId, ruleId: mappedRuleId, ruleSnapshot: snapshot };
      });
      const exported = await window.footballPos.transfer.export({ format: 'football-bet-pos-transfer', version: 1, packageId: uid(), exportedAt: new Date().toISOString(), sourceDate: activeDate, data: { teams: transferTeams, matches: transferMatches, bets: transferBets } });
      if (exported) flash(`${activeDate} data ကို .fbpos transfer file အဖြစ် export ပြီးပါပြီ။`);
    } catch (error) { flash(error instanceof Error ? error.message : 'Transfer file export မလုပ်နိုင်ပါ။'); }
    finally { setTransferBusy(false); }
  };
  const uniqueImportCode = (requested: string, used: Set<string>) => {
    const base = /^[a-z0-9]+$/.test(requested.trim().toLowerCase()) ? requested.trim().toLowerCase() : 'team';
    let candidate = base; let suffix = 2;
    while (used.has(candidate)) candidate = `${base}${suffix++}`;
    used.add(candidate); return candidate;
  };
  const chooseTransferFile = async () => {
    if (!store || transferBusy) return;
    setTransferBusy(true);
    try {
      const packageData = await window.footballPos.transfer.import();
      if (!packageData) return;
      if (!packageData.sourceDate || packageData.data.matches.some(match => !match.id || !Array.isArray(match.rules)) || packageData.data.bets.some(bet => !bet.id || !bet.matchId || !bet.ruleId)) throw new Error('Transfer data structure မပြည့်စုံပါ။');
      const importedMatchRules = new Map(packageData.data.matches.map(match => [match.id, new Set(match.rules.map(rule => rule.id))]));
      if (packageData.data.bets.some(bet => !importedMatchRules.get(bet.matchId)?.has(bet.ruleId))) throw new Error('Transfer file ထဲရှိ record နှင့် match/rule ဆက်စပ်မှု မမှန်ပါ။');
      const usedCodes = new Set(teams.map(team => team.code.toLowerCase()));
      const teamPlans = packageData.data.teams.map(source => {
        const existing = teams.find(team => team.sourceId === source.id || team.id === source.id || (source.apiTeamId && team.apiTeamId === source.apiTeamId) || normalizeTeamName(team.name) === normalizeTeamName(source.name));
        return { source, existing, code: existing?.code ?? uniqueImportCode(source.code, usedCodes) };
      });
      const duplicateMatchIds = new Set(packageData.data.matches.filter(source => matches.some(match => match.bookmaker === activeBookmaker && match.date === activeDate && (match.sourceId === source.id || match.id === source.id))).map(match => match.id));
      const duplicateBetIds = new Set(packageData.data.bets.filter(source => bets.some(bet => bet.bookmaker === activeBookmaker && bet.date === activeDate && (bet.sourceId === source.id || bet.id === source.id))).map(bet => bet.id));
      setTransferPreview({ packageData, teamPlans, newMatches: packageData.data.matches.length - duplicateMatchIds.size, duplicateMatches: duplicateMatchIds.size, newBets: packageData.data.bets.length - duplicateBetIds.size, duplicateBets: duplicateBetIds.size });
    } catch (error) { flash(error instanceof Error ? error.message : 'Transfer file import မလုပ်နိုင်ပါ။'); }
    finally { setTransferBusy(false); }
  };
  const updateImportTeamCode = (sourceId: string, code: string) => setTransferPreview(current => current ? { ...current, teamPlans: current.teamPlans.map(plan => plan.source.id === sourceId ? { ...plan, code } : plan) } : null);
  const confirmTransferImport = async () => {
    if (!store || !transferPreview || transferBusy) return;
    const newPlans = transferPreview.teamPlans.filter(plan => !plan.existing);
    const codes = [...teams.map(team => team.code.toLowerCase()), ...newPlans.map(plan => plan.code.trim().toLowerCase())];
    if (newPlans.some(plan => !/^[a-z0-9]+$/.test(plan.code.trim().toLowerCase()))) return flash('Imported team short code များကို English letter/number ဖြင့်ဖြည့်ပါ။');
    if (new Set(codes).size !== codes.length) return flash('Imported team short code ထပ်နေပါသည်။ မတူသော code ပြင်ပေးပါ။');
    setTransferBusy(true);
    try {
      const backupPath = await window.footballPos.data.backup(store);
      const importedTeams: Team[] = newPlans.map(plan => ({ ...plan.source, id: uid(), sourceId: plan.source.id, bookmaker: activeBookmaker, code: plan.code.trim().toLowerCase(), hasVoiceClip: false }));
      const teamBySourceId = new Map<string, Team>();
      transferPreview.teamPlans.forEach(plan => { const target = plan.existing ?? importedTeams.find(team => team.sourceId === plan.source.id); if (target) teamBySourceId.set(plan.source.id, target); });
      const teamNameMap = new Map(transferPreview.teamPlans.map(plan => [normalizeTeamName(plan.source.name), (plan.existing ?? teamBySourceId.get(plan.source.id))?.name ?? plan.source.name]));
      const importedMatches: Match[] = [];
      const updatedExistingMatches = new Map<string, Match>();
      const matchBySourceId = new Map<string, Match>();
      const ruleBySourceKey = new Map<string, Rule>();
      for (const source of transferPreview.packageData.data.matches) {
        const existing = matches.find(match => match.bookmaker === activeBookmaker && match.date === activeDate && (match.sourceId === source.id || match.id === source.id));
        if (existing) {
          let updated = updatedExistingMatches.get(existing.id) ?? existing;
          source.rules.forEach(sourceRule => {
            let targetRule = updated.rules.find(rule => rule.sourceId === sourceRule.id || rule.id === sourceRule.id);
            if (!targetRule) {
              targetRule = { ...sourceRule, id: uid(), sourceId: sourceRule.id };
              updated = { ...updated, rules: [...updated.rules, targetRule] };
            }
            ruleBySourceKey.set(`${source.id}:${sourceRule.id}`, targetRule);
          });
          updatedExistingMatches.set(existing.id, updated);
          matchBySourceId.set(source.id, updated);
          continue;
        }
        const rules = source.rules.map(sourceRule => { const rule: Rule = { ...sourceRule, id: uid(), sourceId: sourceRule.id }; ruleBySourceKey.set(`${source.id}:${sourceRule.id}`, rule); return rule; });
        const nextDayKickoff = kickoffLocalDate(source.kickoffAt) === nextDate(transferPreview.packageData.sourceDate) || (!source.kickoffAt && source.time < '06:00');
        const match: Match = { ...source, id: uid(), sourceId: source.id, bookmaker: activeBookmaker, date: activeDate, home: teamNameMap.get(normalizeTeamName(source.home)) ?? source.home, away: teamNameMap.get(normalizeTeamName(source.away)) ?? source.away, kickoffAt: kickoffIso(activeDate, source.time, nextDayKickoff), rules };
        importedMatches.push(match); matchBySourceId.set(source.id, match);
      }
      const existingDayCount = bets.filter(bet => bet.bookmaker === activeBookmaker && bet.date === activeDate).length;
      const importedBets: Bet[] = [];
      for (const source of transferPreview.packageData.data.bets) {
        if (bets.some(bet => bet.bookmaker === activeBookmaker && bet.date === activeDate && (bet.sourceId === source.id || bet.id === source.id))) continue;
        const match = matchBySourceId.get(source.matchId);
        const rule = ruleBySourceKey.get(`${source.matchId}:${source.ruleId}`);
        if (!match || !rule) continue;
        const snapshot = source.ruleSnapshot ? { ...source.ruleSnapshot, id: rule.id, sourceId: source.ruleId } : structuredClone(rule);
        importedBets.push({ ...source, id: uid(), sourceId: source.id, bookmaker: activeBookmaker, date: activeDate, matchId: match.id, ruleId: rule.id, ruleSnapshot: snapshot, sortOrder: existingDayCount + importedBets.length });
      }
      const nextMatches = matches.map(match => updatedExistingMatches.get(match.id) ?? match);
      await save({ ...store, teams: [...allTeams, ...importedTeams], matches: [...nextMatches, ...importedMatches], bets: [...bets, ...importedBets] });
      setTransferPreview(null);
      flash(`Import ပြီးပါပြီ — Team ${importedTeams.length} · Match ${importedMatches.length} · Record ${importedBets.length}။ Backup: ${backupPath}`);
    } catch (error) { flash(error instanceof Error ? error.message : 'Transfer data import မလုပ်နိုင်ပါ။'); }
    finally { setTransferBusy(false); }
  };
  const transferDayData = async (mode: 'move' | 'copy') => {
    if (!store) return;
    const destination = transferDestination;
    const destinationChannel = channels.find(channel => channel.id === destination && channel.enabled);
    if (!destinationChannel || destination === activeBookmaker) return flash('Data ပို့မည့် အခြား channel ကိုရွေးပါ။');
    const destinationLabel = destinationChannel.name;
    if (!dayMatches.length && !dayBets.length) return flash(`${activeDate} အတွက် ပြောင်းရွှေ့ရန် data မရှိပါ။`);
    const destinationMatches = matches.filter(match => match.date === activeDate && match.bookmaker === destination).length;
    const destinationBets = bets.filter(bet => bet.date === activeDate && bet.bookmaker === destination).length;
    const warning = destinationMatches || destinationBets ? `\n\n${destinationLabel} တွင် ယနေ့ match ${destinationMatches} ပွဲ၊ record ${destinationBets} ခု ရှိပြီးသားဖြစ်သည်။ အသစ်များကို ထပ်ပေါင်းမည်။` : '';
    if (!await askConfirm(`${activeDate} မှ match ${dayMatches.length} ပွဲနှင့် record ${dayBets.length} ခုကို ${destinationLabel} သို့ ${mode === 'move' ? 'ရွှေ့' : 'ကူးယူ'}မလား?${warning}`)) return;
    const referencedNames = new Set(dayMatches.flatMap(match => [normalizeTeamName(match.home), normalizeTeamName(match.away)]));
    const destinationTeams = allTeams.filter(team => team.bookmaker === destination);
    const usedDestinationCodes = new Set(destinationTeams.map(team => team.code.toLowerCase()));
    const copiedDestinationTeams: Team[] = [];
    const destinationTeamName = new Map<string, string>();
    teams.filter(team => referencedNames.has(normalizeTeamName(team.name))).forEach(sourceTeam => {
      const existing = destinationTeams.find(team => (sourceTeam.apiTeamId && team.apiTeamId === sourceTeam.apiTeamId) || normalizeTeamName(team.name) === normalizeTeamName(sourceTeam.name));
      const target = existing ?? {
        ...structuredClone(sourceTeam),
        id: uid(),
        sourceId: sourceTeam.sourceId ?? sourceTeam.id,
        bookmaker: destination,
        code: uniqueImportCode(sourceTeam.code, usedDestinationCodes),
        hasVoiceClip: false,
      };
      if (!existing) copiedDestinationTeams.push(target);
      destinationTeamName.set(normalizeTeamName(sourceTeam.name), target.name);
    });
    const forDestination = (match: Match): Match => ({
      ...match,
      bookmaker: destination,
      home: destinationTeamName.get(normalizeTeamName(match.home)) ?? match.home,
      away: destinationTeamName.get(normalizeTeamName(match.away)) ?? match.away,
    });
    if (mode === 'move') {
      await save({
        ...store,
        teams: [...allTeams, ...copiedDestinationTeams],
        matches: matches.map(match => match.date === activeDate && match.bookmaker === activeBookmaker ? forDestination(match) : match),
        bets: bets.map(bet => bet.date === activeDate && bet.bookmaker === activeBookmaker ? { ...bet, bookmaker: destination } : bet),
      });
    } else {
      const matchIdMap = new Map<string, string>();
      const ruleIdMap = new Map<string, string>();
      const copiedMatches = dayMatches.map(match => {
        const matchId = uid();
        matchIdMap.set(match.id, matchId);
        const rules = match.rules.map(rule => { const ruleId = uid(); ruleIdMap.set(`${match.id}:${rule.id}`, ruleId); return { ...structuredClone(rule), id: ruleId, sourceId: rule.sourceId ?? rule.id }; });
        return forDestination({ ...structuredClone(match), id: matchId, sourceId: match.sourceId ?? match.id, rules });
      });
      const destinationOrderStart = bets.filter(bet => bet.date === activeDate && bet.bookmaker === destination).length;
      const copiedBets = sortBets(dayBets).flatMap((bet, index) => {
        const matchId = matchIdMap.get(bet.matchId);
        const ruleId = ruleIdMap.get(`${bet.matchId}:${bet.ruleId}`);
        if (!matchId || !ruleId) return [];
        const ruleSnapshot = bet.ruleSnapshot ? { ...structuredClone(bet.ruleSnapshot), id: ruleId } : undefined;
        return [{ ...structuredClone(bet), id: uid(), sourceId: bet.sourceId ?? bet.id, bookmaker: destination, matchId, ruleId, ruleSnapshot, sortOrder: destinationOrderStart + index }];
      });
      await save({ ...store, teams: [...allTeams, ...copiedDestinationTeams], matches: [...matches, ...copiedMatches], bets: [...bets, ...copiedBets] });
    }
    resetBetForm(); resetMatchForm(); setActiveBookmaker(destination);
    flash(`${activeDate} data ကို ${destinationLabel} သို့ ${mode === 'move' ? 'ရွှေ့' : 'ကူးယူ'}ပြီးပါပြီ။`);
  };
  (window as any).footballPosActions = { editMatch, deleteMatch, editBet, deleteBet, insertBetAfter, commitRuleChange, linkApiFixture, toggleApiSides };
  const reportSummaryRows = (): [string, string][] => {
    const signed = (value: number) => `${value > 0 ? '+' : value < 0 ? '-' : ''}${money(value)}`;
    return [
      ['WIN gross', signed(grossWin)], ['WIN Com', signed(winCom)], ['WIN final', signed(netWin)],
      ['LOSE gross', signed(grossLoss)], ['LOSE Com', signed(loseCom)], ['LOSE final', signed(netLoss)],
      ...(commissionRate ? [[`Turnover Com (${commissionRate}%)`, signed(commissionEffect)] as [string, string]] : []),
      ['TOTAL', signed(total)],
    ];
  };
  const reportRows = () => {
    const exportSettlements = sortSettlements(daySettlements, 'ledger');
    const details = exportSettlements.map((s, i) => { const result = viewResult(s, activeCommission, store!.settings.view); return [String(i + 1), `${s.match.home} vs ${s.match.away}`, exportRuleLabel(s), selectionLabel(s), money(s.bet.amount), s.match.postponed ? 'P:P' : s.match.homeScore === null ? '' : `${s.match.homeScore}:${s.match.awayScore}`, result.gross > 0 ? String(s.band.rate) : '', result.gross < 0 ? String(s.band.rate) : '', result.gross > 0 ? money(result.gross) : '', result.gross < 0 ? `-${money(result.gross)}` : '', result.adjustment ? `${result.adjustment < 0 ? '-' : '+'}${money(result.adjustment)} (${adjustmentRate(result)}%)` : '', result.final ? `${result.final < 0 ? '-' : ''}${money(result.final)}` : '', s.label === 'Pending' ? 'Pending' : s.band.outcome === 'refund' ? 'Refund' : result.finalLabel]; });
    return [['No.', 'Match', 'Rule', 'ရွေးချယ်မှု', 'လောင်းငွေ', 'Result', '% (+)', '% (-)', 'WIN', 'LOSE', 'Com', 'Final', 'Status'], ...details, ['TOTAL', '', '', '', money(totalBetAmount), '', '', '', money(grossWin), `-${money(grossLoss)}`, `WIN ${winCom < 0 ? '-' : '+'}${money(winCom)} | LOSE ${loseCom < 0 ? '-' : '+'}${money(loseCom)}`, `${columnTotal < 0 ? '-' : ''}${money(columnTotal)}`, 'Final column total']];
  };
  const csvRows = () => [...reportRows(), [], ['Summary', 'Value'], ...reportSummaryRows()];
  const pdfCell = (value: string, column: number) => { const safe = escapeHtml(value); const positive = (column === 8 && Boolean(value)) || (column === 10 && value.startsWith('+')) || (column === 11 && Boolean(value) && !value.startsWith('-')); const negative = (column === 9 && Boolean(value)) || (column === 10 && value.startsWith('-')) || (column === 11 && value.startsWith('-')); return `<td class="${positive ? 'positive' : negative ? 'negative' : ''}">${safe}</td>`; };
  const exportPdf = async () => {
    const rows = reportRows();
    const summary = reportSummaryRows();
    const title = `${channelName(store!, activeBookmaker)} · ${store!.settings.view === 'dai' ? 'Dai View' : 'Player View'}`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;padding:22px;color:#13261a}h1{font-size:20px}h2{font-size:14px;margin:18px 0 6px}table{width:100%;border-collapse:collapse;font-size:10px}td,th{border:1px solid #8da393;padding:5px;text-align:left}th{background:#d6e7b0}.summary{width:320px}.summary td:last-child{text-align:right}.positive{color:#137645;font-weight:bold}.negative{color:#b23b36;font-weight:bold}.legend{font-size:10px;color:#5e715f}</style></head><body><h1>Football Bet POS — ${escapeHtml(title)} (${activeDate})</h1><table><thead><tr>${rows[0].map(x => `<th>${escapeHtml(x)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(r => `<tr>${r.map((x, index) => pdfCell(x, index)).join('')}</tr>`).join('')}</tbody></table><h2>Summary</h2><table class="summary"><thead><tr><th>Summary</th><th>Value</th></tr></thead><tbody>${summary.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td class="${value.startsWith('+') ? 'positive' : value.startsWith('-') ? 'negative' : ''}">${escapeHtml(value)}</td></tr>`).join('')}</tbody></table><p class="legend">↔ = BD မူရင်းအခြေခံ rule သည် ညာအသင်းဘက်ဖြစ်သည်။</p></body></html>`;
    if (await window.footballPos.data.exportPdf(`football-settlement-${channelFileName(store!, activeBookmaker)}-${activeDate}`, html)) flash('PDF export ပြီးပါပြီ။');
  };
  const testViberGroupSelection = async () => {
    if (!store || viberSendBusy) return;
    const groupName = store.settings.viberDelivery.groupName.trim();
    if (!groupName) return flash('Settings တွင် Viber group name အတိအကျ ထည့်ပါ။');
    setViberSendBusy(true);
    try {
      const result = await window.footballPos.viber.selectGroup(groupName);
      const nextDelivery = {
        ...store.settings.viberDelivery,
        lastStatus: result.ok ? 'idle' as const : 'failed' as const,
        lastMessage: result.message,
        lastSentAt: undefined,
      };
      await save({ ...store, settings: { ...store.settings, viberDelivery: nextDelivery } });
      flash(result.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Viber group ကို မရွေးနိုင်ပါ။';
      await save({ ...store, settings: { ...store.settings, viberDelivery: { ...store.settings.viberDelivery, lastStatus: 'failed', lastMessage: message, lastSentAt: undefined } } });
      flash(message);
    }
    finally { setViberSendBusy(false); }
  };
  const sendCurrentReportToViber = async () => {
    if (!store || viberSendBusy) return;
    const delivery = store.settings.viberDelivery;
    if (!delivery.groupName.trim()) return flash('Settings တွင် Viber test group name အတိအကျ ထည့်ပါ။');
    const report = automatedReport(store, activeDate, activeBookmaker);
    if (!report.count) return flash(`${activeDate} အတွက် ပို့ရန် report record မရှိပါ။`);
    setViberSendBusy(true);
    try {
      const filePath = await window.footballPos.data.exportPdfAuto(report.title, report.html);
      const result = await window.footballPos.viber.sendFile(delivery.groupName, filePath);
      const reportKey = `${activeDate}:${activeBookmaker}`;
      const nextDelivery = {
        ...delivery,
        sentReports: result.ok ? [...new Set([...delivery.sentReports, reportKey])] : delivery.sentReports,
        pendingReports: result.ok ? delivery.pendingReports.filter(key => key !== reportKey) : delivery.pendingReports,
        lastStatus: result.ok ? 'sent' as const : 'failed' as const,
        lastMessage: result.message,
        lastSentAt: result.ok ? new Date().toISOString() : delivery.lastSentAt,
      };
      await save({ ...store, settings: { ...store.settings, viberDelivery: nextDelivery } });
      flash(result.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Viber သို့ PDF မပို့နိုင်ပါ။';
      await save({ ...store, settings: { ...store.settings, viberDelivery: { ...delivery, lastStatus: 'failed', lastMessage: message, lastSentAt: undefined } } });
      flash(message);
    } finally { setViberSendBusy(false); }
  };
  const automationSettings = store?.settings.automation;
  const automationWindowActive = automationSettings ? inTimeWindow(myanmarClock(new Date(automationClock)), automationSettings.windowStart, automationSettings.windowEnd) : false;
  const automationSecondsLeft = nextAutomationCheckAt ? Math.max(0, Math.ceil((nextAutomationCheckAt - automationClock) / 1_000)) : 0;
  const automationStatus = automationBusy
    ? 'Result စစ်ဆေးနေသည်…'
    : !automationSettings?.enabled
      ? 'Automation ပိတ်ထားသည်။'
      : !apiKeyConfigured
        ? 'API key မရှိသေးသောကြောင့် automation မစနိုင်ပါ။'
        : automationWindowActive
          ? `နောက်တစ်ကြိမ် အလိုအလျောက်စစ်ရန် ${countdownLabel(automationSecondsLeft)}`
          : `စစ်ဆေးချိန်ပြင်ပ · Scheduler နိုးရန် ${countdownLabel(automationSecondsLeft)} · API request မသုံးပါ`;
  (window as Window & { footballPosReportMode?: boolean }).footballPosReportMode = page === 'report';
  if (fixturePicker) {
    const query = fixtureFilter.trim().toLowerCase();
    const visible = fixturePicker.fixtures.filter(fixture => !query || `${fixture.home} ${fixture.away} ${fixture.league}`.toLowerCase().includes(query)).slice(0, 100);
    return <main><section className="card" style={{ maxWidth: '1000px', margin: '30px auto' }}><p className="eyebrow">LINK API FIXTURE</p><h2>Software: {fixturePicker.match.home} vs {fixturePicker.match.away}</h2><p className="muted">စာရင်းရက်: <b>{fixturePicker.match.date}</b> · Default သည် match ၏ actual kickoff date ဖြစ်သည်။ မနက် 06:00 မတိုင်မီပွဲကို နောက်တစ်ရက်အဖြစ် အလိုအလျောက်ရွေးပြီး လိုအပ်လျှင် manual ပြောင်းနိုင်သည်။</p><div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '12px' }}><label style={{ margin: 0 }}>API fixture ရှာမည့်ရက်<input type="date" value={fixturePicker.searchDate} onChange={e => setFixturePicker({ ...fixturePicker, searchDate: e.target.value })}/></label><button type="button" disabled={fixturePickerLoading} onClick={() => void searchApiFixtureDate()}>{fixturePickerLoading ? 'ရှာနေသည်…' : 'ဤရက်ကို အသစ်ပြန်ယူမည်'}</button><small className="muted">ရက်တစ်ရက်သာ ရှာသဖြင့် ပထမ load သို့မဟုတ် အသစ်ပြန်ယူမှုသည် request 1 ခု။ Cache ရှိသော နောက်ထပ် link သည် request 0 ခု။</small></div><p className="muted">API Match ၏ Home/Away အစဉ်နှင့် Software ၏ ဘယ်/ညာအစဉ်ကို နှိုင်းပြီး ချိတ်နည်းရွေးပါ။ မှားလျှင် result ပြောင်းပြန်ဖြစ်နိုင်သည်။</p><input autoFocus value={fixtureFilter} onChange={e => setFixtureFilter(e.target.value)} placeholder="Loaded list ထဲမှ English team or league name ရှာပါ"/><button type="button" className="secondary" onClick={() => setFixturePicker(null)}>မချိတ်တော့ပါ</button><div className="table-wrap"><table><thead><tr><th>Myanmar Time</th><th>League</th><th>API Match</th><th>Status</th><th>Mapping ရွေးရန်</th></tr></thead><tbody>{visible.map(fixture => <tr key={fixture.id}><td>{new Date(fixture.kickoffAt).toLocaleString('en-GB', { timeZone: 'Asia/Yangon', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td><td>{fixture.league}</td><td><b>{fixture.home}</b> vs <b>{fixture.away}</b></td><td>{fixture.status}</td><td><button type="button" onClick={() => void chooseApiFixture(fixture, false)}>API အစဉ်အတိုင်း</button><button type="button" className="secondary" onClick={() => void chooseApiFixture(fixture, true)}>ဘယ်/ညာ ပြောင်းချိတ်</button></td></tr>)}{visible.length === 0 && <tr><td colSpan={5} className="empty">ကိုက်ညီသော fixture မတွေ့ပါ။ English အသင်းနာမည် တစ်စိတ်တစ်ပိုင်းဖြင့် ရှာပါ။</td></tr>}</tbody></table></div></section></main>;
  }
  if (!store) return <main className="loading">Football Bet POS ဖွင့်နေသည်…</main>;
  return <main><header><div><p className="eyebrow">OFFLINE DESKTOP POS</p><h1>Football Bet POS</h1></div><div className="workspace-picker" style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' }}><div className="day-picker"><label>ဒိုင် / Channel<select value={activeBookmaker} onChange={e => { setActiveBookmaker(e.target.value); resetBetForm(); resetMatchForm(); }}>{enabledChannels.map(channel => <option value={channel.id} key={channel.id}>{channel.name}</option>)}</select></label><small>Match နှင့် လောင်းကြေး သီးခြားထားသည်</small></div><div className="day-picker"><label>အလုပ်လုပ်မည့်ရက်<input type="date" value={activeDate} onChange={e => { setActiveDate(e.target.value); resetBetForm(); resetMatchForm(); }}/></label><small>ရက်ပြောင်းလျှင် စာရင်းများ မပေါင်းပါ</small></div></div><nav>{([['matches','Matches & Rules'],['ledger','လောင်းမှတ်တမ်း'],['report','Daily Report'],['settings','Settings']] as const).map(([id, text]) => <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}>{text}</button>)}</nav></header>{notice && <div className="notice">{notice}</div>}<div className="page-content">
  {page === 'matches' && <section className="grid"><article className="card form-card"><h2>Match အသစ်နှင့် Rule သတ်မှတ်ရန်</h2><p className="muted">{activeDate} အတွက် match ထည့်နေသည်။ အသင်းများကို Settings → Team list မှာ အရင်သတ်မှတ်ပြီး short code ဖြင့် Quick Entry သုံးနိုင်သည်။</p>{teams.length === 0 && <div className="team-warning">Team list မရှိသေးပါ။ Settings မှာ အသင်းနှင့် short code အရင်ထည့်ပါ။</div>}<form onSubmit={addMatch}><div className="form-grid"><label>Time<input type="time" value={matchForm.time} onChange={e => setMatchForm({ ...matchForm, time: e.target.value })}/></label><TeamSelect label="ဘယ်အသင်း" value={matchForm.home} teams={teams} onChange={home => setMatchForm({ ...matchForm, home })}/><TeamSelect label="ညာအသင်း" value={matchForm.away} teams={teams} onChange={away => setMatchForm({ ...matchForm, away })}/></div>{matchForm.rules.map((rule, index) => <div className="rule-box" key={rule.id}><div className="rule-head"><b>{index + 1}. Flexible rule</b>{matchForm.rules.length > 1 && <button type="button" className="link danger" onClick={() => setMatchForm({ ...matchForm, rules: matchForm.rules.filter(x => x.id !== rule.id) })}>ဖျက်</button>}</div><RuleEditor rule={rule} home={matchForm.home} away={matchForm.away} onChange={next => setMatchForm({ ...matchForm, rules: matchForm.rules.map(x => x.id === rule.id ? next : x) })}/></div>)}<button type="button" className="secondary" onClick={() => setMatchForm({ ...matchForm, rules: [...matchForm.rules, defaultRule('body')] })}>+ Rule ထပ်ထည့်</button><button type="submit">Match သိမ်းမည်</button></form></article><article className="card scroll-list-card"><h2>{activeDate} Match များ</h2><div className="match-list-toolbar"><div className="match-list-search"><input value={matchListSearch} onChange={e => setMatchListSearch(e.target.value)} placeholder="🔍 Team name/code, time, league သို့ rule code ရှာရန်"/>{matchListSearch && <button type="button" className="link" onClick={() => setMatchListSearch('')}>ရှင်းမည်</button>}</div><span>{visibleMatchCards.length} / {dayMatches.length} ပွဲ</span></div><div className="card-scroll">{dayMatches.length === 0 ? <p className="muted">ဤရက်အတွက် Match မရှိသေးပါ။ ရက်ဟောင်း data မပေါင်းပါ။</p> : visibleMatchCards.length === 0 ? <p className="empty">“{matchListSearch}” နှင့်ကိုက်ညီသော Match မတွေ့ပါ။</p> : visibleMatchCards.map(m => <MatchCard key={m.id} match={m} onSave={saveResult}/>)}</div></article></section>}
  {page === 'ledger' && (
    <section className="grid">
      <article className="card form-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <h2>{editingBetId ? 'လောင်းမှတ်တမ်း ပြင်ရန်' : 'လောင်းမှတ်တမ်း ထည့်ရန်'}</h2>
          {editingBetId && <span className="edit-badge">Editing Mode</span>}
        </div>
        <p className="muted">{activeDate} အတွက် မှတ်တမ်းထည့်နေသည်။ အသင်း သို့မဟုတ် Over/Under ကို ချက်ချင်းနှိပ်၍ ရွေးချယ်နိုင်ပါသည်။</p>
        <div className="quick-entry-box">
          <div><b>⚡ Quick Entry</b><small>ဥပမာ <code>chb50000</code> (BD) · <code>chu50k</code> (Up) · <code>mud5w</code> (Down)</small></div>
          <div className="quick-entry-controls"><input autoFocus value={quickEntry} onChange={e => { setQuickEntry(e.target.value); setQuickCandidates(null); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void submitQuickEntry(); } }} placeholder="team code + b/u/d + amount"/><button type="button" onClick={() => void submitQuickEntry()}>Enter ↵</button></div>
          <small><b>b</b> = Body · <b>u</b> = Up · <b>d</b> = Down · <b>k</b> = 1,000 · <b>w</b> = 10,000 · <b>l</b> = 100,000 · <b>m</b> = 1,000,000</small>
          {insertAfterBetId && <small className="quick-insert-note">↳ Quick Entry record ကို ရွေးထားသော No. ၏နောက်သို့ ထည့်မည်</small>}
          {quickCandidates && <div className="quick-candidates"><b>{quickCandidates.request.team.name} ပါသော match {quickCandidates.matches.length} ပွဲတွေ့သည် — တစ်ပွဲရွေးပါ</b><div>{quickCandidates.matches.map(match => <button type="button" className="secondary" key={match.id} onClick={() => void saveQuickBet(quickCandidates.request, match)}>{match.time} · {match.home} vs {match.away}</button>)}</div></div>}
          <div className="quick-match-reference"><b>ဒီနေ့ Match code များ</b><div>{dayMatches.length === 0 ? <small>Match မရှိသေးပါ။</small> : dayMatches.map(match => { const homeCode = teams.find(team => team.name === match.home)?.code ?? '—'; const awayCode = teams.find(team => team.name === match.away)?.code ?? '—'; return <div className="quick-match-card" key={match.id}><span>{match.time}</span><b>{match.home} <code>{homeCode}</code></b><em>vs</em><b>{match.away} <code>{awayCode}</code></b></div>; })}</div></div>
        </div>
        {insertAfterBetId && <div className="late-entry-box" style={{ marginBottom: '12px' }}><b>↳ ရွေးထားသော record ၏နောက်တွင် ထည့်မည်</b><button type="button" className="link" style={{ float: 'right' }} onClick={() => setInsertAfterBetId(null)}>မထည့်တော့ပါ</button><small style={{ display: 'block', marginTop: '3px' }}>သိမ်းပြီးလျှင် နောက်က No. များ အလိုအလျောက်ရွှေ့မည်။</small></div>}
        
        <form onSubmit={addBet}>
          <div>
            <label style={{ marginBottom: '6px' }}>
              Match ရွေးပါ
              <input
                type="text"
                placeholder="🔍 အသင်းနာမည်ဖြင့် ရှာရန်..."
                value={matchSearch}
                onChange={e => setMatchSearch(e.target.value)}
                style={{ marginBottom: '6px' }}
              />
            </label>
            <select
              value={betForm.matchId}
              onChange={e => {
                const m = dayMatches.find(x => x.id === e.target.value);
                const activeRule = m?.rules.find(r => r.status !== 'closed') || m?.rules[0];
                setBetForm({
                  ...betForm,
                  matchId: e.target.value,
                  ruleId: activeRule?.id || '',
                  selection: activeRule?.market === 'total' ? 'up' : 'home',
                });
              }}
            >
              <option value="">-- Match ရွေးပါ ({filteredDayMatches.length} ပွဲ) --</option>
              {filteredDayMatches.map(m => (
                <option value={m.id} key={m.id}>
                  {m.time} — {m.home} vs {m.away}
                </option>
              ))}
            </select>
          </div>

          {selectedMatch && (
            <>
              <div className="selected-match-card">
                <span className="match-time-badge">{selectedMatch.time}</span>
                <span className="match-teams-display">
                  <b>{selectedMatch.home}</b> <em style={{ margin: '0 6px', color: '#68786c' }}>vs</em> <b>{selectedMatch.away}</b>
                </span>
              </div>

              <label>
                အကြေး (Rule) ရွေးပါ
                <div className="rule-pills">
                  {selectedMatch.rules.map(r => (
                    <button
                      key={r.id}
                      type="button"
                      className={`rule-pill ${betForm.ruleId === r.id ? 'selected' : ''} ${r.status === 'closed' ? 'closed' : ''}`}
                      onClick={() => setBetForm(curr => ({
                        ...curr,
                        ruleId: r.id,
                        selection: r.market === 'total' ? 'up' : bodyBaseSide(r)
                      }))}
                    >
                      <span>{r.market === 'body' ? '⚽ BD' : '🎯 O/U'} <b>{r.code}</b>{r.market === 'body' && <> · {ruleBaseLabel(selectedMatch, r)} အခြေခံ</>}</span>
                      {r.status === 'closed' && <small style={{ marginLeft: '4px', color: '#b23b36' }}>[ပိတ်]</small>}
                    </button>
                  ))}
                </div>
              </label>

              {selectedRule && (
                <label>
                  ရွေးချယ်မှု (Selection)
                  <div className="selection-buttons">
                    {selectedRule.market === 'body' ? (
                      <>
                        <button
                          type="button"
                          className={`select-btn ${betForm.selection === 'home' ? 'selected' : ''}`}
                          onClick={() => setBetForm({ ...betForm, selection: 'home' })}
                        >
                          <span className="team-role">အိမ်ရှင် (ဘယ်)</span>
                          <span className="team-name">{selectedMatch.home}</span>
                        </button>
                        <button
                          type="button"
                          className={`select-btn ${betForm.selection === 'away' ? 'selected' : ''}`}
                          onClick={() => setBetForm({ ...betForm, selection: 'away' })}
                        >
                          <span className="team-role">အဝေးကွင်း (ညာ)</span>
                          <span className="team-name">{selectedMatch.away}</span>
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className={`select-btn ${betForm.selection === 'up' ? 'selected' : ''}`}
                          onClick={() => setBetForm({ ...betForm, selection: 'up' })}
                        >
                          <span className="team-role">ဂိုးပေါင်း</span>
                          <span className="team-name">⬆️ Over (အထက်)</span>
                        </button>
                        <button
                          type="button"
                          className={`select-btn ${betForm.selection === 'down' ? 'selected' : ''}`}
                          onClick={() => setBetForm({ ...betForm, selection: 'down' })}
                        >
                          <span className="team-role">ဂိုးပေါင်း</span>
                          <span className="team-name">⬇️ Under (အောက်)</span>
                        </button>
                      </>
                    )}
                  </div>
                </label>
              )}

              {selectedRule?.status === 'closed' && (
                <div className="late-entry-box">
                  <div className="late-entry-title">⚠️ Late Entry သတိပေးချက်</div>
                  <p style={{ margin: '3px 0 8px', fontSize: '11px', color: '#773531' }}>
                    ဤ rule သည် {selectedRule.closedAt ? new Date(selectedRule.closedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'ယခင်'} တွင် ပိတ်ထားပြီးဖြစ်သည်။ အရင်လက်ခံထားသော စာရင်းဖြစ်ပါက အချက်အလက်ဖြည့်ပါ။
                  </p>
                  <label style={{ fontSize: '12px', marginTop: '6px' }}>
                    လက်ခံရရှိချိန် (Received Time)
                    <input
                      type="datetime-local"
                      value={betForm.lateReceivedAt}
                      onChange={e => setBetForm({ ...betForm, lateReceivedAt: e.target.value })}
                    />
                  </label>
                  <label style={{ fontSize: '12px', marginTop: '6px' }}>
                    နောက်ကျရသည့် အကြောင်းရင်း
                    <input
                      value={betForm.lateReason}
                      onChange={e => setBetForm({ ...betForm, lateReason: e.target.value })}
                      placeholder="ဥပမာ: ဖုန်းလိုင်းမမိ၍ နောက်ကျမှ သွင်းခြင်း"
                    />
                  </label>
                </div>
              )}
            </>
          )}

          <label>
            မှတ်ချက် / အသင်းအမည်
            <input
              value={betForm.note}
              onChange={e => setBetForm({ ...betForm, note: e.target.value })}
              placeholder="ဥပမာ: ဦးအောင်, ဖုန်းနံပါတ် သို့မဟုတ် Team name"
            />
          </label>

          <label>
            ထိုးငွေ (Ks)
            <div className="amount-wrap">
              <input
                type="number"
                min="1"
                value={betForm.amount}
                onChange={e => setBetForm({ ...betForm, amount: e.target.value })}
                placeholder="ဥပမာ 50000"
              />
              {Number(betForm.amount) > 0 && (
                <span className="amount-preview">{money(Number(betForm.amount))} Ks</span>
              )}
            </div>
            <div className="quick-stakes">
              {[5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000].map(amt => (
                <button
                  key={amt}
                  type="button"
                  className="stake-chip"
                  onClick={() => setBetForm({ ...betForm, amount: String(amt) })}
                >
                  {money(amt)}
                </button>
              ))}
              <button
                type="button"
                className="stake-chip clear"
                onClick={() => setBetForm({ ...betForm, amount: '' })}
              >
                ✕ ရှင်းမည်
              </button>
            </div>
          </label>

          <div className="form-actions">
            {editingBetId && (
              <button type="button" className="secondary" onClick={resetBetForm}>
                ✕ မပြင်တော့ပါ
              </button>
            )}
            <button type="submit">
              {editingBetId ? '💾 ပြင်ဆင်ချက် သိမ်းမည်' : '+ လောင်းမှတ်တမ်း သိမ်းမည်'}
            </button>
          </div>
        </form>
      </article>

      <article className="card scroll-list-card">
        <h2>{activeDate} မှတ်တမ်းများ ({dayBets.length})</h2>
        <LedgerTable rows={daySettlements} settings={activeCommission} view={store.settings.view} onInsertAfter={insertBetAfter} sortable />
      </article>
    </section>
  )}
  {page === 'settings' && <nav className="settings-tabs" aria-label="Settings sections">
    <button type="button" className={settingsTab === 'general' ? 'selected' : ''} onClick={() => setSettingsTab('general')}>⚙️ General</button>
    <button type="button" className={settingsTab === 'report' ? 'selected' : ''} onClick={() => setSettingsTab('report')}>📊 Report & Data</button>
    <button type="button" className={settingsTab === 'matches' ? 'selected' : ''} onClick={() => setSettingsTab('matches')}>⚽ Match Setup</button>
    <button type="button" className={settingsTab === 'voice' ? 'selected' : ''} onClick={() => setSettingsTab('voice')}>🔊 Voice</button>
    <button type="button" className={settingsTab === 'automation' ? 'selected' : ''} onClick={() => setSettingsTab('automation')}>🌙 Automation</button>
  </nav>}
  {page === 'settings' && settingsTab === 'general' && <div className="settings-card-stack"><section className="card appearance-card"><p className="eyebrow">APPEARANCE</p><h2>App Theme</h2><p className="muted">ညပိုင်းအသုံးပြုရာတွင် မျက်စိမစူးစေရန် Dark theme သို့ပြောင်းနိုင်သည်။ PDF report များသည် print ထုတ်ရန် Light ပုံစံအတိုင်းရှိမည်။</p><div className="theme-toggle" role="group" aria-label="App theme"><button type="button" className={store.settings.theme === 'light' ? 'selected' : ''} onClick={() => void save({ ...store, settings: { ...store.settings, theme: 'light' } })}>☀️ Light</button><button type="button" className={store.settings.theme === 'dark' ? 'selected' : ''} onClick={() => void save({ ...store, settings: { ...store.settings, theme: 'dark' } })}>🌙 Dark</button></div></section><section className="card channel-management-card"><p className="eyebrow">CHANNEL MANAGEMENT</p><h2>ဒိုင် / Channel များ</h2><p className="muted">Channel တစ်ခုစီ၏ team list၊ match၊ လောင်းမှတ်တမ်း၊ commission နှင့် PDF သီးခြားဖြစ်သည်။ API key၊ automation schedule နှင့် Viber destination ကို အားလုံးမျှဝေသုံးသည်။</p><div className="channel-list">{channels.map(channel => <div className={channel.enabled ? '' : 'disabled'} key={channel.id}><span className="channel-status-dot"/><input key={`${channel.id}:${channel.name}`} defaultValue={channel.name} aria-label={`${channel.name} name`} onBlur={e => void renameChannel(channel, e.target.value)}/><small>{channel.id === 'viber' ? 'Direct commission' : 'Messenger-style commission'}</small><button type="button" className="secondary" disabled={channel.id === activeBookmaker} onClick={() => void toggleChannel(channel)}>{channel.enabled ? 'Disable' : 'Enable'}</button></div>)}</div><form className="add-channel-form" onSubmit={addChannel}><label>Channel အသစ်<input value={newChannelName} onChange={e => setNewChannelName(e.target.value)} placeholder="ဥပမာ Channel 5"/></label><button type="submit">+ Channel ထည့်မည်</button></form><p className="muted">Channel အသစ်သည် လက်ရှိ Messenger commission rule ကို copy ယူပြီးစတင်မည်။ Report Settings မှာ rate များပြင်နိုင်သည်။</p></section></div>}
  {page === 'settings' && settingsTab === 'voice' && <section className="card voice-confirmation-card settings-tab-card">
    <p className="eyebrow">VOICE CONFIRMATION</p>
    <h2>လောင်းမှတ်တမ်း အသံဖြင့်အတည်ပြုရန်</h2>
    <p className="muted">Team၊ Body/Over/Down၊ ဂဏန်းနှင့် unit အသံဖိုင်ရှိလျှင် recorded voice ကိုသုံးမည်။ မဖမ်းရသေးသောအသံတိုင်းကို system voice ဖြင့် အလိုအလျောက် fallback ပြောမည်။ အသံမြန်နှုန်းသည် recorded နှင့် system voice နှစ်မျိုးလုံးကို သက်ရောက်သည်။</p>
    <label className="check" style={{ margin: '12px 0' }}><input type="checkbox" checked={store.settings.voiceConfirmation.enabled} onChange={e => { if (!e.target.checked) stopVoiceOutput(); void save({ ...store, settings: { ...store.settings, voiceConfirmation: { ...store.settings.voiceConfirmation, enabled: e.target.checked } } }); }}/> Record သိမ်းပြီးတိုင်း အသံထွက်မည်</label>
    <div className="voice-controls"><label>အသံအားလုံး၏ မြန်နှုန်း<select value={store.settings.voiceConfirmation.rate} onChange={e => void save({ ...store, settings: { ...store.settings, voiceConfirmation: { ...store.settings.voiceConfirmation, rate: Number(e.target.value) } } })}><option value={1}>Normal</option><option value={1.2}>Fast</option><option value={1.35}>Faster</option><option value={1.5}>Very fast</option></select></label><button type="button" className="secondary" disabled={!store.settings.voiceConfirmation.enabled} onClick={() => void testCommonVoice()}>🔊 Body 250,000 စမ်းမည်</button></div>
    <h3 className="common-voice-title">Common voice recordings</h3>
    <p className="muted">အသံတစ်ခုချင်းကိုပြောပြီး ရပ်ပြီးသိမ်းမည်ကိုနှိပ်ပါ။ မနှိပ်လျှင် ၃ စက္ကန့်တွင် အလိုအလျောက်သိမ်းမည်။</p>
    <div className="common-voice-grid">{commonVoiceOptions.map(option => {
      const hasClip = store.settings.voiceConfirmation.commonClips.includes(option.key);
      const recording = recordingCommonKey === option.key;
      const anyRecording = Boolean(recordingCommonKey || recordingTeamId);
      return <div className={`common-voice-item ${hasClip ? 'has-recording' : ''}`} key={option.key}>
        <b>{option.label}</b><small>{hasClip ? '🎙 Recorded' : 'System voice fallback'}</small>
        <div><button type="button" className={recording ? 'recording' : 'secondary'} disabled={(anyRecording && !recording) || commonVoiceBusyKey === option.key} onClick={() => recording ? stopTeamVoiceRecording() : void startCommonVoiceRecording(option.key, option.label)}>{recording ? '⏹ သိမ်း' : hasClip ? '🎙 ပြန်ဖမ်း' : '🎙 ဖမ်း'}</button>{hasClip && <button type="button" className="secondary" disabled={anyRecording || commonVoiceBusyKey === option.key} onClick={() => void previewCommonVoice(option.key)}>▶</button>}{hasClip && <button type="button" className="link danger" disabled={anyRecording || commonVoiceBusyKey === option.key} onClick={() => void removeCommonVoice(option.key, option.label)}>ဖျက်</button>}</div>
      </div>;
    })}</div>
  </section>}
  {page === 'settings' && settingsTab === 'automation' && <div className="settings-card-stack"><section className="card"><p className="eyebrow">OVERNIGHT AUTOMATION</p><h2>API-Football Result Automation</h2><p className="muted">API key ကို encrypted storage တွင်သိမ်းသည်။ Project file နှင့် report များထဲ မထည့်ပါ။ Automation ဖွင့်ထားစဉ် Mac နှင့် display ကို app က အိပ်မသွားအောင် ထိန်းထားမည်။ Mac ကို charger ချိတ်၊ lid ဖွင့်ပြီး manually lock မလုပ်ပါနှင့်။</p><label>API Key<input type="password" autoComplete="off" value={apiKeyInput} onChange={e => setApiKeyInput(e.target.value)} placeholder={apiKeyConfigured ? 'Key သိမ်းပြီးသား — အသစ်ပြောင်းရန်သာ ထည့်ပါ' : 'API-Football key ထည့်ပါ'}/></label><button type="button" onClick={() => void saveApiKey()}>Key လုံခြုံစွာသိမ်းမည်</button><button type="button" className="secondary" onClick={() => void testApi()}>Connection စမ်းမည်</button>{apiMessage && <p className="muted">{apiMessage}</p>}<label className="check" style={{ margin: '14px 0 8px' }}><input type="checkbox" checked={store.settings.automation.enabled} onChange={e => void save({ ...store, settings: { ...store.settings, automation: { ...store.settings.automation, enabled: e.target.checked } } })}/> ညပိုင်း result အလိုအလျောက်စစ်မည် · Mac/display awake ထားမည်</label><div className="form-grid"><label>စစ်ဆေးချိန်မှ<input type="time" value={store.settings.automation.windowStart} onChange={e => void save({ ...store, settings: { ...store.settings, automation: { ...store.settings.automation, windowStart: e.target.value } } })}/></label><label>စစ်ဆေးချိန်အထိ<input type="time" value={store.settings.automation.windowEnd} onChange={e => void save({ ...store, settings: { ...store.settings, automation: { ...store.settings.automation, windowEnd: e.target.value } } })}/></label><label>မိနစ်ခြား<input type="number" min="5" max="60" value={store.settings.automation.pollMinutes} onChange={e => void save({ ...store, settings: { ...store.settings, automation: { ...store.settings.automation, pollMinutes: Math.max(5, Number(e.target.value) || 10) } } })}/></label></div><button type="button" disabled={automationBusy} onClick={() => void checkApiResults(true)}>{automationBusy ? 'စစ်ဆေးနေသည်…' : 'Result ယခုစစ်မည်'}</button><div className={`automation-status ${automationWindowActive ? 'active' : ''}`}><span className="automation-dot"/><div><b>{automationStatus}</b>{automationSettings?.enabled && <small>Mac/display awake · Myanmar time window {automationSettings.windowStart}–{automationSettings.windowEnd} · {automationSettings.pollMinutes} မိနစ်ခြား</small>}</div></div></section>
  <section className="card viber-delivery-card"><p className="eyebrow">VIBER AUTO DELIVERY</p><h2>PDF ကို Viber Group သို့ပို့ရန်</h2><p className="muted">ပို့မည့်အချိန်တွင် configured group name ကို Viber conversation search ဖြင့်ရှာပြီး ရွေးပါမည်။ Accounting date တစ်ရက်တွင် enabled channel များ၌ data ရှိပါက အဆိုပါ report အားလုံး ready ဖြစ်သည်အထိစောင့်ပြီး PDF များကို တစ်ဆက်တည်းပို့မည်။</p><label>Viber Group Name<input value={store.settings.viberDelivery.groupName} onChange={e => void save({ ...store, settings: { ...store.settings, viberDelivery: { ...store.settings.viberDelivery, groupName: e.target.value } } })} placeholder="ဥပမာ ဒိုင် gp စစ် test"/></label><button type="button" className="secondary" disabled={viberSendBusy || !store.settings.viberDelivery.groupName.trim()} onClick={() => void testViberGroupSelection()}>{viberSendBusy ? 'Viber ကိုစစ်နေသည်…' : 'Configured Group ကို ရှာဖွင့် စမ်းမည်'}</button><label className="check" style={{ margin: '14px 0 8px' }}><input type="checkbox" checked={store.settings.viberDelivery.autoSend} disabled={!store.settings.viberDelivery.groupName.trim()} onChange={e => void save({ ...store, settings: { ...store.settings, viberDelivery: { ...store.settings.viberDelivery, autoSend: e.target.checked } } })}/> PDF ထွက်ပြီးလျှင် ဤ Viber group သို့ အလိုအလျောက်ပို့မည်</label><button type="button" disabled={viberSendBusy || !store.settings.viberDelivery.groupName.trim()} onClick={() => void sendCurrentReportToViber()}>{viberSendBusy ? 'Viber သို့ပို့နေသည်…' : `လက်ရှိ ${activeChannel?.name ?? activeBookmaker} Report PDF ကို Test ပို့မည်`}</button>{store.settings.viberDelivery.lastMessage && <div className={`automation-status ${store.settings.viberDelivery.lastStatus === 'sent' ? 'active' : ''}`}><span className="automation-dot"/><div><b>{store.settings.viberDelivery.lastMessage}</b>{store.settings.viberDelivery.lastSentAt && <small>{new Date(store.settings.viberDelivery.lastSentAt).toLocaleString('en-GB', { timeZone: 'Asia/Yangon' })}</small>}</div></div>}<p className="muted">App နှင့် Viber ကိုဖွင့်ထားရမည်။ Group name ကို အခြား chat နှင့် မတူအောင် unique ဖြစ်စေပါ။ ရှာဖွေရွေးချယ်မှု မအောင်မြင်လျှင် PDF မပို့ဘဲ နောက် interval တွင် retry လုပ်သည်။ ပို့ပြီးသော date/channel ကို ထပ်မပို့ပါ။</p></section></div>}
  {page === 'settings' && settingsTab === 'report' && <section className="card settings-tab-card"><p className="eyebrow">CURRENT DATE DATA</p><h2>{activeDate} · {activeChannel?.name ?? activeBookmaker}</h2><p className="muted">Match {dayMatches.length} ပွဲနှင့် လောင်းမှတ်တမ်း {dayBets.length} ခုကို ရွေးထားသော channel သို့ ရွှေ့နိုင်သည်၊ သို့မဟုတ် မူရင်းကိုထားပြီး copy ကူးနိုင်သည်။</p><label className="transfer-destination">ပို့မည့် Channel<select value={transferDestination} onChange={e => setTransferDestination(e.target.value)}>{otherChannels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label><button type="button" disabled={!transferDestination} onClick={() => void transferDayData('move')}>ရွေးထားသော Channel သို့ ရွှေ့မည်</button><button type="button" className="secondary" disabled={!transferDestination} onClick={() => void transferDayData('copy')}>မူရင်းထားပြီး Copy ကူးမည်</button></section>}
  {page === 'settings' && settingsTab === 'report' && <section className="card settings-tab-card transfer-file-card"><p className="eyebrow">DEVICE TRANSFER</p><h2>.fbpos Import / Export</h2><p className="muted">လက်ရှိရွေးထားသော <b>{activeChannel?.name ?? activeBookmaker}</b> · <b>{activeDate}</b> data ကို transfer လုပ်သည်။ Commission၊ voice files၊ API key၊ automation နှင့် Viber setting မပါပါ။</p><button type="button" disabled={transferBusy || (!dayMatches.length && !dayBets.length)} onClick={() => void exportTransferFile()}>{transferBusy ? 'လုပ်ဆောင်နေသည်…' : '⬆ .fbpos Export'}</button><button type="button" className="secondary" disabled={transferBusy} onClick={() => void chooseTransferFile()}>{transferBusy ? 'ဖတ်နေသည်…' : '⬇ .fbpos Import ရွေးမည်'}</button>{transferPreview && <div className="transfer-preview"><div className="transfer-preview-head"><b>Import Preview</b><span>Target: {activeChannel?.name ?? activeBookmaker} · {activeDate}</span></div>{transferPreview.packageData.sourceDate !== activeDate && <div className="transfer-date-warning">မူရင်းရက် {transferPreview.packageData.sourceDate} ကို ရွေးထားသော {activeDate} သို့ ပြောင်းထည့်မည်။</div>}<div className="transfer-counts"><span>Teams <b>{transferPreview.teamPlans.filter(plan => !plan.existing).length} new</b> / {transferPreview.teamPlans.filter(plan => plan.existing).length} existing</span><span>Matches <b>{transferPreview.newMatches} new</b> / {transferPreview.duplicateMatches} duplicate</span><span>Records <b>{transferPreview.newBets} new</b> / {transferPreview.duplicateBets} duplicate</span></div>{transferPreview.teamPlans.some(plan => !plan.existing) && <div className="transfer-team-codes"><b>အသစ်ထည့်မည့် Team short codes</b>{transferPreview.teamPlans.filter(plan => !plan.existing).map(plan => <label key={plan.source.id}><span>{plan.source.name}</span><input value={plan.code} maxLength={12} onChange={e => updateImportTeamCode(plan.source.id, e.target.value)}/></label>)}</div>}<div className="transfer-preview-actions"><button type="button" className="secondary" onClick={() => setTransferPreview(null)}>မလုပ်တော့ပါ</button><button type="button" disabled={transferBusy} onClick={() => void confirmTransferImport()}>Backup ယူပြီး Import မည်</button></div></div>}</section>}
  {page === 'report' && <section className="card report"><div className="report-head"><div><p className="eyebrow">{(activeChannel?.name ?? activeBookmaker).toUpperCase()} DAILY SETTLEMENT · {store.settings.view === 'dai' ? 'ဒိုင် View' : 'Player View'}</p><h2>{activeDate} စာရင်း</h2></div><div><button className="secondary" onClick={async () => { if (await window.footballPos.data.exportCsv(csvRows())) flash('Excel CSV export ပြီးပါပြီ။'); }}>Excel CSV ထုတ်</button><button onClick={() => void exportPdf()}>PDF ထုတ်</button></div></div><LedgerTable rows={reportSettlements} settings={activeCommission} view={store.settings.view} totals={reportTotals} sortable sortMode={reportSortMode} onSortModeChange={setReportSortMode}/><SummaryPanel totals={reportTotals}/></section>}
  {page === 'settings' && (settingsTab === 'report' || settingsTab === 'matches') && <section className={`settings-page settings-page-${settingsTab}`}>
    {settingsTab === 'report' && <article className="card settings">
      <h2>{activeChannel?.name ?? activeBookmaker} Report Settings</h2>
      <p className="muted">ဒိုင်တစ်ခုချင်းစီ၏ commission rule ကို သီးခြားသိမ်းသည်။ View ပြောင်းခြင်းသည် record data ကို မပြောင်းပါ။</p>
      <label>View<select value={store.settings.view} onChange={e => void save({ ...store, settings: { ...store.settings, view: e.target.value as ViewMode } })}><option value="dai">ဒိုင် View</option><option value="player">Player View</option></select></label>
      {activeCommission.mode === 'direct' ? <>
        <label>Player နိုင်လျှင် ဖြတ်မည့်နှုန်း (%)<input type="number" min="0" max="100" value={activeCommission.playerWinDeduction} onChange={e => updateBookmakerSettings({ playerWinDeduction: percent(Number(e.target.value)) })}/></label>
        <label>Player ရှုံးလျှင် ပြန်ပေးမည့်နှုန်း (%)<input type="number" min="0" max="100" value={activeCommission.playerLossRebate} onChange={e => updateBookmakerSettings({ playerLossRebate: percent(Number(e.target.value)) })}/></label>
        <p className="muted">Direct rule: Player Win {activeCommission.playerWinDeduction}% · Player Lose {activeCommission.playerLossRebate}%</p>
      </> : <>
        <label>Gross WIN မှ ဖြတ်မည့်နှုန်း (%)<input type="number" min="0" max="100" value={activeCommission.winTaxRate} onChange={e => updateBookmakerSettings({ winTaxRate: percent(Number(e.target.value)) })}/></label>
        <label>Gross WIN + LOSE ပေါ် Player ကိုပေးမည့် Commission (%)<input type="number" min="0" max="100" value={activeCommission.turnoverCommissionRate} onChange={e => updateBookmakerSettings({ turnoverCommissionRate: percent(Number(e.target.value)) })}/></label>
        <p className="muted">Summary rule: WIN ကို {activeCommission.winTaxRate}% ဖြတ်ပြီး စုစုပေါင်း settled turnover ပေါ် {activeCommission.turnoverCommissionRate}% ကို Player အား ပြန်ပေးသည်။</p>
      </>}
    </article>}
    {settingsTab === 'matches' && <article className="card bulk-import-card">
      <p className="eyebrow">BULK MATCH SETUP</p>
      <h2>{activeDate} Match များကို JSON ဖြင့်ထည့်ရန်</h2>
      <p className="muted">JSON ၏ left team ကို Body base team အဖြစ်ယူသည်။ <code>nextDay: true</code> သည် accounting date နောက်တစ်နေ့ kickoff ဖြစ်သော်လည်း report ကို {activeDate} ထဲမှာပဲထားမည်။</p>
      <button type="button" className="secondary" onClick={() => { setBulkOpen(open => !open); setBulkError(''); }}>{bulkOpen ? 'JSON Import ပိတ်မည်' : '⚡ JSON Import ဖွင့်မည်'}</button>
      <button type="button" disabled={bulkApiBusy || dayMatches.length === 0} onClick={() => void bulkLinkApiMatches()}>{bulkApiBusy ? 'API fixtures ရှာနေသည်…' : `API မချိတ်ရသေးသော Match အားလုံးချိတ်မည်`}</button>
      <p className="muted">Actual kickoff date တစ်ရက်လျှင် API request တစ်ခုသာသုံးပြီး cache ထားမည်။ Team mapping သိပြီးသားပွဲကို auto-link လုပ်ပြီး မသိသေးသောပွဲများကို တစ်ပွဲစီရွေးခိုင်းမည်။</p>
      {bulkOpen && <div className="bulk-import-box">
        <textarea value={bulkJson} onChange={e => { setBulkJson(e.target.value); setBulkPreview(null); setBulkError(''); }} spellCheck={false} placeholder={'[\n  {\n    "nextDay": true,\n    "time": "01:45",\n    "teams": ["လိုင်ယွန်", "ပဲလေ့စ်"],\n    "bd": "D",\n    "ou": "3D"\n  }\n]'}/>
        <div className="bulk-actions"><button type="button" className="secondary" onClick={() => { setBulkJson('[\n  {\n    "nextDay": true,\n    "time": "01:45",\n    "teams": ["လိုင်ယွန်", "ပဲလေ့စ်"],\n    "bd": "D",\n    "ou": "3D"\n  },\n  {\n    "nextDay": true,\n    "time": "01:45",\n    "teams": ["လေဗာကူဆင်", "လက်ပေါ့နန်"],\n    "bd": "1-50",\n    "ou": "4+90"\n  }\n]'); setBulkPreview(null); setBulkError(''); }}>နမူနာထည့်မည်</button><button type="button" onClick={parseBulkMatches}>JSON စစ်မည်</button></div>
        {bulkError && <div className="bulk-error">{bulkError}</div>}
        {bulkPreview && <div className="bulk-preview">
          <div className="bulk-summary"><b>✓ Match {bulkPreview.rows.length} ပွဲ မှန်ကန်သည်</b><span>Team အသစ် {Object.keys(bulkPreview.missingCodes).length} သင်း</span></div>
          {Object.keys(bulkPreview.missingCodes).length > 0 && <div className="bulk-team-codes"><b>Team အသစ်များအတွက် Quick Entry short code ဖြည့်ပါ</b>{Object.keys(bulkPreview.missingCodes).map(name => <label key={name}><span>{name}</span><input value={bulkPreview.missingCodes[name]} maxLength={12} placeholder="ဥပမာ ly" onChange={e => setBulkPreview(current => current ? { ...current, missingCodes: { ...current.missingCodes, [name]: e.target.value } } : null)}/></label>)}</div>}
          <div className="bulk-match-preview">{bulkPreview.rows.map((row, index) => <div key={`${row.time}-${index}`}><span>{row.nextDay ? nextDate(activeDate) : activeDate} · {row.time}</span><b>{row.teams[0]} <em>vs</em> {row.teams[1]}</b><small>{row.bd ? `BD ${row.bd}` : ''}{row.bd && row.ou ? ' · ' : ''}{row.ou ? `O/U ${row.ou}` : ''}</small></div>)}</div>
          <button type="button" onClick={() => void saveBulkMatches()}>အားလုံးသိမ်းမည်</button>
        </div>}
      </div>}
    </article>}
    {settingsTab === 'matches' && <article className="card team-card">
      <div className="team-card-heading"><h2>{activeChannel?.name ?? activeBookmaker} Team list · Quick Code · Voice</h2><button type="button" className="danger-button" disabled={teams.length === 0 || deletingAllTeams} onClick={() => void deleteAllTeams()}>{deletingAllTeams ? 'ဖျက်နေသည်…' : `Team အားလုံးဖျက်မည် (${teams.length})`}</button></div>
      <p className="muted">မြန်မာအသင်းအမည်နှင့် Quick Entry short code သတ်မှတ်ပါ။ Team name အသံကိုဖမ်းနိုင်ပြီး English voice name သည် မထည့်လည်းရပါသည်။</p>
      <form className="team-form" onSubmit={addTeam}>
        <label>Team name<input value={teamForm.name} onChange={e => setTeamForm({ ...teamForm, name: e.target.value })} placeholder="မန်ချက်စတာ ယူနိုက်တက်"/></label>
        <label>Short code<input value={teamForm.code} onChange={e => setTeamForm({ ...teamForm, code: e.target.value })} placeholder="mu" maxLength={12}/></label>
        <label>English voice name (optional)<input value={teamForm.voiceName} onChange={e => setTeamForm({ ...teamForm, voiceName: e.target.value })} placeholder="Manchester United"/></label>
        <button type="submit">+ Team ထည့်မည်</button>
      </form>
      <div className="team-list-toolbar"><input value={teamSearch} onChange={e => setTeamSearch(e.target.value)} placeholder="🔍 Team name, short code, voice/API name ရှာရန်"/><span>{filteredTeams.length} / {teams.length}</span></div>
      {teams.length === 0 ? <p className="muted">Team မရှိသေးပါ။</p> : filteredTeams.length === 0 ? <p className="muted">“{teamSearch}” နှင့်ကိုက်ညီသော Team မတွေ့ပါ။</p> : <div className="team-list">{filteredTeams.map(team => <div key={team.id}>
        <b>{team.name}</b>
        {editingTeamId === team.id ? <div className="team-code-edit">
          <input autoFocus value={editingTeamCode} onChange={e => setEditingTeamCode(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void saveTeamCode(team); } if (e.key === 'Escape') cancelEditingTeamCode(); }} placeholder="Short code" maxLength={12}/>
          <input value={editingTeamVoiceName} onChange={e => setEditingTeamVoiceName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void saveTeamCode(team); } if (e.key === 'Escape') cancelEditingTeamCode(); }} placeholder="English name (optional)"/>
          <button type="button" onClick={() => void saveTeamCode(team)}>သိမ်းမည်</button>
          <button type="button" className="secondary" onClick={cancelEditingTeamCode}>မလုပ်တော့ပါ</button>
        </div> : <>
          <span className="team-voice-name">{team.hasVoiceClip ? '🎙 အသံရှိ' : team.voiceName ? `🔊 ${team.voiceName}` : 'အသံမရှိ'}</span>
          {team.apiName && <span className="team-api-name">API: {team.apiName}</span>}
          <code>{team.code}</code>
          <button type="button" className="link" onClick={() => startEditingTeamCode(team)}>Code/Voice ပြင်</button>
          <button type="button" className="link danger" onClick={() => void deleteTeam(team)}>ဖျက်</button>
        </>}
        <div className="team-voice-actions">
          <button type="button" className={recordingTeamId === team.id ? 'recording' : 'secondary'} disabled={Boolean(recordingCommonKey) || Boolean(recordingTeamId && recordingTeamId !== team.id) || voiceClipBusyId === team.id} onClick={() => recordingTeamId === team.id ? stopTeamVoiceRecording() : void startTeamVoiceRecording(team)}>{recordingTeamId === team.id ? '⏹ ရပ်ပြီးသိမ်းမည်' : team.hasVoiceClip ? '🎙 ပြန်ဖမ်းမည်' : '🎙 အသံဖမ်းမည်'}</button>
          {team.hasVoiceClip && <button type="button" className="secondary" disabled={voiceClipBusyId === team.id || Boolean(recordingTeamId)} onClick={() => void previewTeamVoice(team)}>▶ နားထောင်မည်</button>}
          {team.hasVoiceClip && <button type="button" className="link danger" disabled={voiceClipBusyId === team.id || Boolean(recordingTeamId)} onClick={() => void removeTeamVoice(team)}>အသံဖျက်</button>}
        </div>
      </div>)}</div>}
    </article>}
  </section>}
  </div>{confirmation && <div className="confirm-overlay" role="dialog" aria-modal="true"><div className="confirm-modal"><h3>အတည်ပြုပါ</h3><p>{confirmation.message}</p><div><button type="button" className="secondary" onClick={() => closeConfirm(false)}>မလုပ်တော့ပါ</button><button type="button" autoFocus onClick={() => closeConfirm(true)}>အတည်ပြုမည်</button></div></div></div>}</main>;
}
function MatchCard({ match, onSave }: { match: Match; onSave: (m: Match, h: string, a: string, p: boolean) => void }) {
  const [h, setH] = useState(match.homeScore?.toString() ?? '');
  const [a, setA] = useState(match.awayScore?.toString() ?? '');
  const [p, setP] = useState(match.postponed);
  const [drafts, setDrafts] = useState<Rule[] | null>(null);
  useEffect(() => { setH(match.homeScore?.toString() ?? ''); setA(match.awayScore?.toString() ?? ''); setP(match.postponed); }, [match.homeScore, match.awayScore, match.postponed]);
  const actions = (window as any).footballPosActions;
  const compact = { padding: '5px 8px', margin: '0 3px 0 0', fontSize: '11px' };
  const group = { display: 'flex', alignItems: 'center', gap: '3px' };
  const startChange = (markets: Market[]) => setDrafts(markets.map(market => { const current = match.rules.find(rule => rule.market === market && rule.status !== 'closed'); return current ? { ...structuredClone(current), id: uid(), status: 'active' as const, effectiveAt: new Date().toISOString(), closedAt: undefined } : defaultRule(market); }));
  const describe = (band: Band) => band.outcome === 'refund' ? 'Refund' : `${band.rate}% ${band.outcome === 'win' ? 'Win' : 'Loss'}`;
  const kickoffDate = kickoffLocalDate(match.kickoffAt);
  const mappedApiHome = match.apiSidesReversed ? match.apiAway : match.apiHome;
  const mappedApiAway = match.apiSidesReversed ? match.apiHome : match.apiAway;
  return <div className="match" style={{ alignItems: 'flex-start' }}><div style={{ flex: 1 }}><b>{match.time} · {match.home} <em>vs</em> {match.away}</b>{kickoffDate && kickoffDate !== match.date && <small style={{ display: 'block', color: '#8a5b16', marginTop: '3px' }}>↳ တကယ်ကန်မည့်ရက် {kickoffDate} မနက်အစောပိုင်း · Report date {match.date}</small>}{match.apiFixtureId ? <small style={{ display: 'block', color: finalApiStatuses.has(match.apiStatus ?? '') ? '#137645' : '#55705a', marginTop: '3px' }}>API match: {match.apiHome || '?'} vs {match.apiAway || '?'} · #{match.apiFixtureId} · {match.apiLeague} · {match.apiStatus || 'NS'}{match.resultSource === 'api-football' ? ' · Auto result' : ''}<span style={{ display: 'block', marginTop: '3px', color: '#334f39' }}>ချိတ်ထားပုံ: {match.home} ← {mappedApiHome || '?'} · {match.away} ← {mappedApiAway || '?'}</span></small> : <small style={{ display: 'block', color: '#a13c35', marginTop: '3px' }}>API fixture မချိတ်ရသေးပါ</small>}<div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '7px' }}>{match.rules.map(r => <div key={r.id} style={{ border: `1px solid ${r.status === 'closed' ? '#d7c7c5' : r.provisional ? '#e8ab3e' : '#9bc28a'}`, background: r.status === 'closed' ? '#fbf5f4' : r.provisional ? '#fff7e7' : '#f2f8ed', borderRadius: '6px', padding: '5px 7px', fontSize: '11px' }}><b>{r.market === 'body' ? 'BD' : 'O/U'} {r.code}</b>{r.market === 'body' && <> · <span>အခြေခံ: {ruleBaseLabel(match, r)}</span></>} · {r.status === 'closed' ? 'ပိတ်' : r.provisional ? 'ယာယီ · အကြေးမထွက်သေး' : 'အတည် · ဖွင့်'}<small style={{ display: 'block', marginTop: '2px', color: '#627563' }}>အောက် {describe(r.below)} · တိတိ {describe(r.equal)} · အထက် {describe(r.above)}</small></div>)}</div></div><div className="result" style={{ flexWrap: 'wrap', justifyContent: 'flex-end', rowGap: '7px', maxWidth: '540px' }}><div style={group}><span style={{ fontSize: '11px', color: '#607565', fontWeight: 700 }}>RESULT</span><input type="number" min="0" disabled={p} value={h} onChange={e => setH(e.target.value)}/><span>:</span><input type="number" min="0" disabled={p} value={a} onChange={e => setA(e.target.value)}/><label className="check"><input type="checkbox" checked={p} onChange={e => setP(e.target.checked)}/>P:P</label><button style={compact} onClick={() => onSave(match, h, a, p)}>သိမ်း</button></div><div style={group}><button style={compact} className="secondary" onClick={() => void actions.linkApiFixture(match)}>{match.apiFixtureId ? 'API Link ပြောင်း' : 'API Match ချိတ်'}</button>{match.apiFixtureId && <button style={compact} className="secondary" onClick={() => void actions.toggleApiSides(match)}>API ဘက်ပြောင်း</button>}<span style={{ fontSize: '11px', color: '#607565', fontWeight: 700 }}>ကြေးပြောင်း</span><button style={compact} className="secondary" onClick={() => startChange(['body'])}>BD</button><button style={compact} className="secondary" onClick={() => startChange(['total'])}>O/U</button><button style={compact} className="secondary" onClick={() => startChange(['body', 'total'])}>Both</button><button style={compact} className="secondary" onClick={() => actions.editMatch(match)}>ပြင်</button><button style={{ ...compact, background: '#a13c35' }} onClick={() => void actions.deleteMatch(match)}>ဖျက်</button></div>{drafts && <div style={{ width: '100%', background: '#f5f8f0', border: '1px solid #bdd6ad', borderRadius: '8px', padding: '10px' }}><b style={{ fontSize: '12px' }}>Rule အသစ် — ပိတ်မည့်အကြေးကို confirm မလုပ်မီ ပြင်ပါ</b>{drafts.map(rule => <RuleEditor key={rule.id} rule={rule} home={match.home} away={match.away} onChange={next => setDrafts(current => current?.map(x => x.id === rule.id ? next : x) ?? null)}/>)}<button style={compact} className="secondary" onClick={() => setDrafts(null)}>Cancel</button><button style={compact} onClick={async () => { if (await actions.commitRuleChange(match, drafts)) setDrafts(null); }}>Confirm & ဖွင့်</button></div>}</div></div>;
}
function LedgerTable({ rows, settings, view, totals, onInsertAfter, sortable = false, sortMode: controlledSortMode, onSortModeChange }: { rows: Settlement[]; settings: BookmakerSettings; view: ViewMode; totals?: ReportTotals; onInsertAfter?: (settlement: Settlement) => void; sortable?: boolean; sortMode?: 'latest' | 'ledger'; onSortModeChange?: (mode: 'latest' | 'ledger') => void }) {
  const [filterText, setFilterText] = useState('');
  const [localSortMode, setLocalSortMode] = useState<'latest' | 'ledger'>('latest');
  const [expandedBaseBetIds, setExpandedBaseBetIds] = useState<Set<string>>(() => new Set());
  const sortMode = controlledSortMode ?? localSortMode;
  const editable = !(window as Window & { footballPosReportMode?: boolean }).footballPosReportMode;
  const actions = (window as any).footballPosActions;

  const filtered = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(s =>
      s.bet.note.toLowerCase().includes(q) ||
      s.match.home.toLowerCase().includes(q) ||
      s.match.away.toLowerCase().includes(q) ||
      s.rule.code.toLowerCase().includes(q) ||
      selectionLabel(s).toLowerCase().includes(q) ||
      s.label.toLowerCase().includes(q)
    );
  }, [rows, filterText]);
  const displayRows = useMemo(() => sortMode === 'latest'
    ? [...filtered].sort((a, b) => (b.bet.placedAt ?? '').localeCompare(a.bet.placedAt ?? '') || b.bet.id.localeCompare(a.bet.id))
    : filtered, [filtered, sortMode]);

  return (
    <div className="table-wrap">
      <div className="table-header-tools">
        <span style={{ fontSize: '12px', color: '#68786c' }}>
          မှတ်တမ်း <b>{rows.length}</b> ခု {filterText && `(တွေ့ရှိ: ${filtered.length})`}
        </span>
        <input
          type="text"
          className="table-search-input"
          placeholder="🔍 မှတ်ချက် / အသင်း ရှာရန်..."
          value={filterText}
          onChange={e => setFilterText(e.target.value)}
        />
        {sortable && <select className="ledger-sort" value={sortMode} onChange={e => { const next = e.target.value as 'latest' | 'ledger'; onSortModeChange ? onSortModeChange(next) : setLocalSortMode(next); }}><option value="latest">နောက်ဆုံးသွင်းထားတာ အပေါ်</option><option value="ledger">No. အစဉ်အတိုင်း</option></select>}
      </div>
      <table>
        <thead>
          <tr>
            <th>No.</th>
            <th>မှတ်ချက်</th>
            <th>Match / Rule</th>
            <th>ထိုးငွေ</th>
            <th>Result</th>
            <th>% (+)</th>
            <th>% (-)</th>
            <th>WIN</th>
            <th>LOSE</th>
            <th>Com</th>
            <th>Final</th>
            <th>Status</th>
            {editable && <th>Action</th>}
          </tr>
        </thead>
        <tbody>
          {displayRows.length === 0 ? (
            <tr>
              <td colSpan={editable ? 13 : 12} className="empty">
                {filterText ? 'ရှာဖွေမှုနှင့် ကိုက်ညီသော မှတ်တမ်းမရှိပါ' : 'မှတ်တမ်းမရှိသေးပါ'}
              </td>
            </tr>
          ) : (
            displayRows.map(s => { const result = viewResult(s, settings, view); const comRate = adjustmentRate(result); const hasBaseReference = isOppositeSelection(s.bet, s.rule); const baseExpanded = expandedBaseBetIds.has(s.bet.id); return <tr key={s.bet.id}>
                <td>{rows.findIndex(row => row.bet.id === s.bet.id) + 1}</td>
                <td>{s.bet.note || '—'}</td>
                <td>
                  <b>{s.match.home}</b> vs <b>{s.match.away}</b>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '5px', alignItems: 'center' }}>
                    <span style={{ background: '#edf5e8', color: '#164e2d', border: '1px solid #c9dec2', borderRadius: '4px', padding: '2px 5px', fontSize: '11px', fontWeight: 700 }}>{selectionLabel(s)}</span>
                    <span style={{ background: '#f4f6f2', color: '#34513b', border: '1px solid #d9e2d5', borderRadius: '4px', padding: '2px 5px', fontSize: '11px', fontWeight: 700 }}>{usedRuleLabel(s)}</span>
                    {hasBaseReference && <button type="button" title={`ဒိုင်မူရင်း: ${sourceRuleLabel(s)}`} onClick={() => setExpandedBaseBetIds(current => { const next = new Set(current); baseExpanded ? next.delete(s.bet.id) : next.add(s.bet.id); return next; })} style={{ background: '#fff8e8', color: '#75551e', border: '1px solid #e6c46e', borderRadius: '4px', padding: '2px 5px', fontSize: '11px', margin: 0 }}>Base {baseExpanded ? '▾' : '▸'}</button>}
                  </div>
                  {hasBaseReference && baseExpanded && <small style={{ color: '#75551e' }}>Base: {baseRuleReference(s)}</small>}
                </td>
                <td>{money(s.bet.amount)}</td>
                <td>{s.match.postponed ? 'P:P' : s.match.homeScore === null ? '—' : `${s.match.homeScore}:${s.match.awayScore}`}</td>
                <td>{result.gross > 0 ? s.band.rate : ''}</td>
                <td>{result.gross < 0 ? s.band.rate : ''}</td>
                <td className={result.gross > 0 ? 'win' : ''} style={result.gross > 0 ? { color: '#137645', fontWeight: 700 } : undefined}>{result.gross > 0 ? money(result.gross) : ''}</td>
                <td className={result.gross < 0 ? 'loss' : ''} style={result.gross < 0 ? { color: '#b23b36', fontWeight: 700 } : undefined}>{result.gross < 0 ? `-${money(result.gross)}` : ''}</td>
                <td className={result.adjustment > 0 ? 'win' : result.adjustment < 0 ? 'loss' : ''}>{result.adjustment ? <>{result.adjustment > 0 ? '+' : '-'}{money(result.adjustment)} <small>({comRate}%)</small></> : ''}</td>
                <td className={result.final > 0 ? 'win' : result.final < 0 ? 'loss' : ''}>{result.final ? `${result.final < 0 ? '-' : ''}${money(result.final)}` : '—'}</td>
                <td>{s.label === 'Pending' ? 'Pending' : s.band.outcome === 'refund' ? 'Refund' : result.finalLabel}</td>
                {editable && (
                  <td>
                    {onInsertAfter && <button className="table-action" title="ဤ record ၏နောက်တွင် အသစ်ထည့်ရန်" onClick={() => onInsertAfter(s)}>အောက်ထည့်</button>}
                    <button className="table-action" onClick={() => actions.editBet(s)}>ပြင်</button>
                    <button className="table-action delete" onClick={() => void actions.deleteBet(s)}>ဖျက်</button>
                  </td>
                )}
              </tr>; })
          )}
        </tbody>
        {totals && <tfoot><tr className="table-total-row"><td colSpan={3}>TOTAL</td><td>{money(totals.betAmount)}</td><td colSpan={3}></td><td className="win">{money(totals.grossWin)}</td><td className="loss">-{money(totals.grossLoss)}</td><td className="com-total"><span className={totals.winCom < 0 ? 'loss' : 'win'}>WIN {totals.winCom < 0 ? '-' : '+'}{money(totals.winCom)}</span><span className={totals.loseCom < 0 ? 'loss' : 'win'}>LOSE {totals.loseCom < 0 ? '-' : '+'}{money(totals.loseCom)}</span></td><td className={totals.columnTotal > 0 ? 'win' : totals.columnTotal < 0 ? 'loss' : ''}>{totals.columnTotal < 0 ? '-' : ''}{money(totals.columnTotal)}</td><td>Final column total</td></tr></tfoot>}
      </table>
    </div>
  );
}
