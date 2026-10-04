import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApiFixture, Band, Bet, Bookmaker, BookmakerSettings, Market, Match, Outcome, Rule, Selection, Settlement, Store, Team, ViewMode } from '../shared/models';
import { BODY_ODDS_PRESETS, TOTAL_ODDS_PRESETS, formatBandSummary, parseMyanmarOdds } from '../shared/odds';

const uid = () => crypto.randomUUID();
const localDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yangon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const today = () => localDate();
const nextDate = (date: string) => { const value = new Date(`${date}T12:00:00+06:30`); value.setUTCDate(value.getUTCDate() + 1); return localDate(value); };
const kickoffIso = (date: string, time: string, nextDay: boolean) => `${nextDay ? nextDate(date) : date}T${time}:00+06:30`;
const kickoffLocalDate = (iso?: string) => iso ? localDate(new Date(iso)) : '';
const finalApiStatuses = new Set(['FT', 'AET', 'PEN']);
const money = (n: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(n));
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
function automatedReport(store: Store, date: string, bookmaker: Bookmaker) {
  const settings = store.settings.bookmakerSettings[bookmaker];
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
  const safe = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const title = `${bookmaker === 'viber' ? 'Viber' : 'Messenger'} · ${view === 'dai' ? 'Dai View' : 'Player View'}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;padding:22px;color:#13261a}h1{font-size:20px}h2{font-size:14px;margin:18px 0 6px}table{width:100%;border-collapse:collapse;font-size:10px}td,th{border:1px solid #8da393;padding:5px;text-align:left}th{background:#d6e7b0}.summary{width:320px}.summary td:last-child{text-align:right}.positive{color:#137645;font-weight:bold}.negative{color:#b23b36;font-weight:bold}</style></head><body><h1>Football Bet POS — ${title} (${date})</h1><table><thead><tr>${header.map(value => `<th>${safe(value)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(row => `<tr>${row.map(value => `<td>${safe(value)}</td>`).join('')}</tr>`).join('')}</tbody></table><h2>Summary</h2><table class="summary"><tbody>${summary.map(([label, value]) => `<tr><td>${safe(label)}</td><td>${safe(value)}</td></tr>`).join('')}</tbody></table></body></html>`;
  return { title: `football-settlement-${bookmaker}-${date}`, html, count: settlements.length };
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
  const [activeBookmaker, setActiveBookmaker] = useState<Bookmaker>('viber');
  const [matchForm, setMatchForm] = useState({ time: '19:00', nextDay: false, home: '', away: '', rules: [defaultRule('body'), defaultRule('total')] as Rule[] }); const [editingMatchId, setEditingMatchId] = useState<string | null>(null);
  const [betForm, setBetForm] = useState({ matchId: '', ruleId: '', selection: 'home' as Selection, note: '', amount: '', lateReceivedAt: '', lateReason: '' }); const [editingBetId, setEditingBetId] = useState<string | null>(null); const [insertAfterBetId, setInsertAfterBetId] = useState<string | null>(null); const [matchSearch, setMatchSearch] = useState(''); const [quickEntry, setQuickEntry] = useState(''); const [quickCandidates, setQuickCandidates] = useState<{ request: QuickRequest; matches: Match[] } | null>(null); const [teamForm, setTeamForm] = useState({ name: '', code: '' }); const [reportSortMode, setReportSortMode] = useState<'latest' | 'ledger'>('latest'); const [confirmation, setConfirmation] = useState<{ message: string; resolve: (confirmed: boolean) => void } | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState(''); const [apiKeyConfigured, setApiKeyConfigured] = useState(false); const [apiMessage, setApiMessage] = useState(''); const [automationBusy, setAutomationBusy] = useState(false);
  const [fixturePicker, setFixturePicker] = useState<{ match: Match; fixtures: ApiFixture[]; searchDate: string } | null>(null); const [fixtureFilter, setFixtureFilter] = useState(''); const [fixturePickerLoading, setFixturePickerLoading] = useState(false);
  const fixtureDateCache = useRef(new Map<string, ApiFixture[]>());
  useEffect(() => { void window.footballPos.data.load().then(setStore); }, []);
  useEffect(() => { void window.footballPos.apiFootball.hasKey().then(setApiKeyConfigured); }, []);
  useEffect(() => {
    const rules = (store?.matches ?? []).flatMap(match => match.rules);
    document.querySelectorAll('option').forEach(option => {
      const rule = rules.find(item => item.id === (option as HTMLOptionElement).value);
      if (rule) option.textContent = `${rule.market === 'body' ? 'BD' : 'O/U'} — ${rule.code} [${rule.status === 'closed' ? 'ပိတ် · Late entry only' : rule.provisional ? 'ယာယီ · အကြေးမထွက်သေး' : 'ဖွင့်'}]`;
    });
  }, [store, betForm.matchId]);
  const save = async (next: Store) => { setStore(next); await window.footballPos.data.save(next); };
  const teams = store?.teams ?? []; const matches = store?.matches ?? []; const bets = store?.bets ?? []; const dayMatches = matches.filter(x => x.date === activeDate && x.bookmaker === activeBookmaker); const dayBets = bets.filter(x => x.date === activeDate && x.bookmaker === activeBookmaker);
  const filteredDayMatches = useMemo(() => {
    if (!matchSearch.trim()) return dayMatches;
    const q = matchSearch.toLowerCase();
    return dayMatches.filter(m => m.home.toLowerCase().includes(q) || m.away.toLowerCase().includes(q));
  }, [dayMatches, matchSearch]);
  useEffect(() => { const match = dayMatches.find(item => item.id === betForm.matchId); const active = match?.rules.find(rule => rule.status !== 'closed'); if (match && active && !match.rules.some(rule => rule.id === betForm.ruleId)) setBetForm(current => ({ ...current, ruleId: active.id, selection: active.market === 'total' ? 'up' : bodyBaseSide(active) })); }, [betForm.matchId]);
  const selectedMatch = dayMatches.find(x => x.id === betForm.matchId); const selectedRule = selectedMatch?.rules.find(x => x.id === betForm.ruleId);
  const settlements = useMemo(() => store ? sortBets(bets).map(b => { const m = matches.find(x => x.id === b.matchId); const r = b.ruleSnapshot ?? m?.rules.find(x => x.id === b.ruleId); return m && r ? settle(b, m, r) : null; }).filter(Boolean) as Settlement[] : [], [store, bets, matches]);
  const activeCommission = store?.settings.bookmakerSettings[activeBookmaker] ?? (activeBookmaker === 'viber'
    ? { mode: 'direct' as const, playerWinDeduction: 3, playerLossRebate: 2, winTaxRate: 0, turnoverCommissionRate: 0 }
    : { mode: 'summary' as const, playerWinDeduction: 0, playerLossRebate: 0, winTaxRate: 5, turnoverCommissionRate: 2 });
  const currentView = store?.settings.view ?? 'dai';
  const daySettlements = settlements.filter(x => x.bet.date === activeDate && x.bet.bookmaker === activeBookmaker); const reportSettlements = sortSettlements(daySettlements, reportSortMode); const displayedResults = daySettlements.map(settlement => viewResult(settlement, activeCommission, currentView)); const totalBetAmount = daySettlements.reduce((n, x) => n + x.bet.amount, 0); const grossWin = displayedResults.filter(result => result.gross > 0).reduce((n, result) => n + result.gross, 0); const grossLoss = displayedResults.filter(result => result.gross < 0).reduce((n, result) => n + result.gross, 0); const winCom = displayedResults.filter(result => result.gross > 0).reduce((n, result) => n + result.adjustment, 0); const loseCom = displayedResults.filter(result => result.gross < 0).reduce((n, result) => n + result.adjustment, 0); const netWin = grossWin + winCom; const netLoss = grossLoss + loseCom; const columnTotal = netWin + netLoss; const turnover = daySettlements.reduce((n, settlement) => n + Math.abs(settlement.signed), 0); const commissionRate = activeCommission.mode === 'summary' ? activeCommission.turnoverCommissionRate : 0; const commission = turnover * commissionRate / 100; const commissionEffect = currentView === 'player' ? commission : -commission; const total = columnTotal + commissionEffect; const reportTotals: ReportTotals = { betAmount: totalBetAmount, grossWin, grossLoss, winCom, loseCom, netWin, netLoss, columnTotal, commission, commissionEffect, total, commissionRate, commissionLabel: 'Turnover Com' };
  const flash = (message: string) => { setNotice(message); setTimeout(() => setNotice(''), 3500); };
  const askConfirm = (message: string) => new Promise<boolean>(resolve => setConfirmation({ message, resolve }));
  const closeConfirm = (confirmed: boolean) => { confirmation?.resolve(confirmed); setConfirmation(null); };
  const updateBookmakerSettings = (next: Partial<BookmakerSettings>) => {
    if (!store) return;
    void save({ ...store, settings: { ...store.settings, bookmakerSettings: { ...store.settings.bookmakerSettings, [activeBookmaker]: { ...activeCommission, ...next } } } });
  };
  const resetMatchForm = () => { setEditingMatchId(null); setMatchForm({ time: '19:00', nextDay: false, home: '', away: '', rules: [defaultRule('body'), defaultRule('total')] }); };
  const addMatch = async (e: React.FormEvent) => { e.preventDefault(); if (!store || !matchForm.home.trim() || !matchForm.away.trim()) return flash('အသင်းနှစ်သင်းလုံး ထည့်ပါ။'); const previous = editingMatchId ? matches.find(x => x.id === editingMatchId) : undefined; const history = previous?.rules.filter(rule => rule.status === 'closed') ?? []; const provisionalIds = new Set(previous?.rules.filter(rule => rule.provisional).map(rule => rule.id) ?? []); const finalizedRules = previous ? matchForm.rules.map(rule => provisionalIds.has(rule.id) ? { ...rule, provisional: false } : rule) : matchForm.rules; const nextDayKickoff = matchForm.nextDay || matchForm.time < '06:00'; const updated: Match = { id: previous?.id || uid(), time: matchForm.time, rules: previous ? [...history, ...finalizedRules] : matchForm.rules, date: activeDate, bookmaker: previous?.bookmaker ?? activeBookmaker, home: matchForm.home.trim(), away: matchForm.away.trim(), homeScore: previous?.homeScore ?? null, awayScore: previous?.awayScore ?? null, postponed: previous?.postponed ?? false, kickoffAt: kickoffIso(activeDate, matchForm.time, nextDayKickoff), apiFixtureId: previous?.apiFixtureId, apiHome: previous?.apiHome, apiAway: previous?.apiAway, apiSidesReversed: previous?.apiSidesReversed, apiStatus: previous?.apiStatus, apiLeague: previous?.apiLeague, resultSource: previous?.resultSource, resultCheckedAt: previous?.resultCheckedAt }; const provisionalBets = previous ? bets.filter(bet => bet.matchId === previous.id && provisionalIds.has(bet.ruleId)) : []; if (provisionalBets.length && !await askConfirm(`Temporary rule ဖြင့် ထိုးထားသော record ${provisionalBets.length} ခုကို ယခု actual rule ဖြင့် update လုပ်မလား?`)) return; const refreshedBets = previous ? bets.map(bet => { const newRule = updated.rules.find(rule => rule.id === bet.ruleId); return newRule && provisionalIds.has(bet.ruleId) ? { ...bet, ruleSnapshot: structuredClone(newRule) } : bet; }) : bets; await save({ ...store, matches: previous ? matches.map(x => x.id === previous.id ? updated : x) : [...matches, updated], bets: refreshedBets }); resetMatchForm(); flash(previous && provisionalBets.length ? `Actual rule ကိုအတည်ပြုပြီး record ${provisionalBets.length} ခုကို update လုပ်ပြီးပါပြီ။` : previous ? 'Active rule များကို ပြင်ပြီးပါပြီ။ ပိတ်ထားသော rule history မပြောင်းပါ။' : nextDayKickoff ? `Match ကို ${nextDate(activeDate)} မနက်အစောပိုင်း kickoff အဖြစ် သိမ်းပြီးပါပြီ။` : 'Match နှင့် temporary default rule များကို သိမ်းပြီးပါပြီ။'); };
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
  const addTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store) return;
    const name = teamForm.name.trim(); const code = teamForm.code.trim().toLowerCase().replace(/\s+/g, '');
    if (!name || !code) return flash('Team name နှင့် short code ထည့်ပါ။');
    if (!/^[a-z0-9]+$/.test(code)) return flash('Short code ကို English letter နှင့် number များသာ သုံးပါ။');
    if (teams.some(team => team.code.toLowerCase() === code)) return flash(`“${code}” short code ကို အသုံးပြုပြီးသားဖြစ်သည်။`);
    await save({ ...store, teams: [...teams, { id: uid(), name, code }] });
    setTeamForm({ name: '', code: '' }); flash(`${name} (${code}) ကို Team list ထဲထည့်ပြီးပါပြီ။`);
  };
  const deleteTeam = async (team: Team) => {
    if (!store || !await askConfirm(`${team.name} (${team.code}) ကို Team list မှဖျက်မလား?\n\nရှိပြီးသား match နှင့် record များကို မဖျက်ပါ။`)) return;
    await save({ ...store, teams: teams.filter(item => item.id !== team.id) });
    flash(`${team.name} ကို Team list မှဖျက်ပြီးပါပြီ။`);
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
  const linkApiFixture = async (match: Match) => {
    if (!apiKeyConfigured) return flash('Settings တွင် API-Football key အရင်ထည့်ပါ။');
    try {
      const searchDate = kickoffLocalDate(match.kickoffAt) || (match.time < '06:00' ? nextDate(match.date) : match.date);
      const fixtures = await loadFixtureDate(searchDate);
      const targetTime = new Date(match.kickoffAt ?? kickoffIso(match.date, match.time, match.time < '06:00')).valueOf();
      fixtures.sort((a, b) => Math.abs(new Date(a.kickoffAt).valueOf() - targetTime) - Math.abs(new Date(b.kickoffAt).valueOf() - targetTime));
      setFixtureFilter(''); setFixturePicker({ match, fixtures, searchDate });
    } catch (error) { flash(error instanceof Error ? error.message : 'Fixture ရှာမရပါ။'); }
  };
  const searchApiFixtureDate = async () => {
    if (!fixturePicker || fixturePickerLoading) return;
    setFixturePickerLoading(true);
    try {
      const fixtures = await loadFixtureDate(fixturePicker.searchDate, true);
      const targetTime = new Date(fixturePicker.match.kickoffAt ?? kickoffIso(fixturePicker.match.date, fixturePicker.match.time, fixturePicker.match.time < '06:00')).valueOf();
      fixtures.sort((a, b) => Math.abs(new Date(a.kickoffAt).valueOf() - targetTime) - Math.abs(new Date(b.kickoffAt).valueOf() - targetTime));
      setFixtureFilter('');
      setFixturePicker(current => current ? { ...current, fixtures } : null);
    } catch (error) { flash(error instanceof Error ? error.message : 'Fixture ရှာမရပါ။'); }
    finally { setFixturePickerLoading(false); }
  };
  const chooseApiFixture = async (fixture: ApiFixture, apiSidesReversed: boolean) => {
    if (!store || !fixturePicker) return;
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Yangon', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(fixture.kickoffAt));
    const updated: Match = { ...fixturePicker.match, time, kickoffAt: fixture.kickoffAt, apiFixtureId: fixture.id, apiHome: fixture.home, apiAway: fixture.away, apiSidesReversed, apiStatus: fixture.status, apiLeague: fixture.league, resultCheckedAt: new Date().toISOString(), homeScore: null, awayScore: null, resultSource: undefined };
    await save({ ...store, matches: matches.map(match => match.id === updated.id ? updated : match) });
    setFixturePicker(null); flash(`API Fixture #${fixture.id} ကို ${apiSidesReversed ? 'ဘယ်/ညာ ပြောင်းပြီး' : 'API အစဉ်အတိုင်း'} ချိတ်ပြီးပါပြီ။`);
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
  const checkApiResults = async (manual = false) => {
    if (!store || !apiKeyConfigured || automationBusy) return;
    const linked = matches.filter(match => match.apiFixtureId && match.resultSource !== 'manual' && (!match.apiHome || !match.apiAway || !match.apiStatus || !finalApiStatuses.has(match.apiStatus) || match.homeScore === null || match.awayScore === null));
    if (!linked.length) { if (manual) flash('စစ်ဆေးရန် ချိတ်ထားသော pending match မရှိပါ။'); return; }
    setAutomationBusy(true);
    try {
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
      if (store.settings.automation.autoExportPdf && settledCount) {
        const exported = new Set(store.settings.automation.exportedReports);
        const groupKeys = [...new Set(linked.map(match => `${match.date}:${match.bookmaker}`))];
        for (const key of groupKeys) {
          if (exported.has(key)) continue;
          const [date, bookmakerValue] = key.split(':') as [string, Bookmaker];
          const groupBets = nextStore.bets.filter(bet => bet.date === date && bet.bookmaker === bookmakerValue);
          const involvedIds = new Set(groupBets.map(bet => bet.matchId));
          const ready = groupBets.length > 0 && [...involvedIds].every(id => { const match = nextMatches.find(item => item.id === id); return Boolean(match && (match.postponed || (match.homeScore !== null && match.awayScore !== null))); });
          if (!ready) continue;
          const report = automatedReport(nextStore, date, bookmakerValue);
          if (report.count) { await window.footballPos.data.exportPdfAuto(report.title, report.html); exported.add(key); }
        }
        if (exported.size !== store.settings.automation.exportedReports.length) {
          nextStore = { ...nextStore, settings: { ...nextStore.settings, automation: { ...nextStore.settings.automation, exportedReports: [...exported] } } };
          await save(nextStore);
        }
      }
      if (manual) flash(settledCount ? `API မှ result ${settledCount} ပွဲ update လုပ်ပြီးပါပြီ။` : 'API စစ်ပြီးပါပြီ။ Final result အသစ်မရှိသေးပါ။');
    } catch (error) { if (manual) flash(error instanceof Error ? error.message : 'Result စစ်ဆေးမှု မအောင်မြင်ပါ။'); }
    finally { setAutomationBusy(false); }
  };
  useEffect(() => {
    const automation = store?.settings.automation;
    if (!automation?.enabled || !apiKeyConfigured) return;
    const inWindow = () => { const value = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Yangon', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); return value >= automation.windowStart && value <= automation.windowEnd; };
    if (inWindow()) void checkApiResults();
    const timer = window.setInterval(() => { if (inWindow()) void checkApiResults(); }, Math.max(5, automation.pollMinutes) * 60_000);
    return () => window.clearInterval(timer);
  }, [store?.settings.automation.enabled, store?.settings.automation.pollMinutes, store?.settings.automation.windowStart, store?.settings.automation.windowEnd, apiKeyConfigured]);
  const transferDayData = async (mode: 'move' | 'copy') => {
    if (!store) return;
    const destination: Bookmaker = activeBookmaker === 'viber' ? 'messenger' : 'viber';
    const destinationLabel = destination === 'viber' ? 'Viber' : 'Messenger';
    if (!dayMatches.length && !dayBets.length) return flash(`${activeDate} အတွက် ပြောင်းရွှေ့ရန် data မရှိပါ။`);
    const destinationMatches = matches.filter(match => match.date === activeDate && match.bookmaker === destination).length;
    const destinationBets = bets.filter(bet => bet.date === activeDate && bet.bookmaker === destination).length;
    const warning = destinationMatches || destinationBets ? `\n\n${destinationLabel} တွင် ယနေ့ match ${destinationMatches} ပွဲ၊ record ${destinationBets} ခု ရှိပြီးသားဖြစ်သည်။ အသစ်များကို ထပ်ပေါင်းမည်။` : '';
    if (!await askConfirm(`${activeDate} မှ match ${dayMatches.length} ပွဲနှင့် record ${dayBets.length} ခုကို ${destinationLabel} သို့ ${mode === 'move' ? 'ရွှေ့' : 'ကူးယူ'}မလား?${warning}`)) return;
    if (mode === 'move') {
      await save({
        ...store,
        matches: matches.map(match => match.date === activeDate && match.bookmaker === activeBookmaker ? { ...match, bookmaker: destination } : match),
        bets: bets.map(bet => bet.date === activeDate && bet.bookmaker === activeBookmaker ? { ...bet, bookmaker: destination } : bet),
      });
    } else {
      const matchIdMap = new Map<string, string>();
      const ruleIdMap = new Map<string, string>();
      const copiedMatches = dayMatches.map(match => {
        const matchId = uid();
        matchIdMap.set(match.id, matchId);
        const rules = match.rules.map(rule => { const ruleId = uid(); ruleIdMap.set(`${match.id}:${rule.id}`, ruleId); return { ...structuredClone(rule), id: ruleId }; });
        return { ...structuredClone(match), id: matchId, bookmaker: destination, rules };
      });
      const destinationOrderStart = bets.filter(bet => bet.date === activeDate && bet.bookmaker === destination).length;
      const copiedBets = sortBets(dayBets).flatMap((bet, index) => {
        const matchId = matchIdMap.get(bet.matchId);
        const ruleId = ruleIdMap.get(`${bet.matchId}:${bet.ruleId}`);
        if (!matchId || !ruleId) return [];
        const ruleSnapshot = bet.ruleSnapshot ? { ...structuredClone(bet.ruleSnapshot), id: ruleId } : undefined;
        return [{ ...structuredClone(bet), id: uid(), bookmaker: destination, matchId, ruleId, ruleSnapshot, sortOrder: destinationOrderStart + index }];
      });
      await save({ ...store, matches: [...matches, ...copiedMatches], bets: [...bets, ...copiedBets] });
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
    const details = reportSettlements.map((s, i) => { const result = viewResult(s, activeCommission, store!.settings.view); return [String(i + 1), `${s.match.home} vs ${s.match.away}`, exportRuleLabel(s), selectionLabel(s), money(s.bet.amount), s.match.postponed ? 'P:P' : s.match.homeScore === null ? '' : `${s.match.homeScore}:${s.match.awayScore}`, result.gross > 0 ? String(s.band.rate) : '', result.gross < 0 ? String(s.band.rate) : '', result.gross > 0 ? money(result.gross) : '', result.gross < 0 ? `-${money(result.gross)}` : '', result.adjustment ? `${result.adjustment < 0 ? '-' : '+'}${money(result.adjustment)} (${adjustmentRate(result)}%)` : '', result.final ? `${result.final < 0 ? '-' : ''}${money(result.final)}` : '', s.label === 'Pending' ? 'Pending' : s.band.outcome === 'refund' ? 'Refund' : result.finalLabel]; });
    return [['No.', 'Match', 'Rule', 'ရွေးချယ်မှု', 'လောင်းငွေ', 'Result', '% (+)', '% (-)', 'WIN', 'LOSE', 'Com', 'Final', 'Status'], ...details, ['TOTAL', '', '', '', money(totalBetAmount), '', '', '', money(grossWin), `-${money(grossLoss)}`, `WIN ${winCom < 0 ? '-' : '+'}${money(winCom)} | LOSE ${loseCom < 0 ? '-' : '+'}${money(loseCom)}`, `${columnTotal < 0 ? '-' : ''}${money(columnTotal)}`, 'Final column total']];
  };
  const csvRows = () => [...reportRows(), [], ['Summary', 'Value'], ...reportSummaryRows()];
  const pdfCell = (value: string, column: number) => { const safe = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); const positive = (column === 8 && Boolean(value)) || (column === 10 && value.startsWith('+')) || (column === 11 && Boolean(value) && !value.startsWith('-')); const negative = (column === 9 && Boolean(value)) || (column === 10 && value.startsWith('-')) || (column === 11 && value.startsWith('-')); return `<td class="${positive ? 'positive' : negative ? 'negative' : ''}">${safe}</td>`; };
  const exportPdf = async () => {
    const rows = reportRows();
    const summary = reportSummaryRows();
    const title = `${activeBookmaker === 'viber' ? 'Viber' : 'Messenger'} · ${store!.settings.view === 'dai' ? 'Dai View' : 'Player View'}`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;padding:22px;color:#13261a}h1{font-size:20px}h2{font-size:14px;margin:18px 0 6px}table{width:100%;border-collapse:collapse;font-size:10px}td,th{border:1px solid #8da393;padding:5px;text-align:left}th{background:#d6e7b0}.summary{width:320px}.summary td:last-child{text-align:right}.positive{color:#137645;font-weight:bold}.negative{color:#b23b36;font-weight:bold}.legend{font-size:10px;color:#5e715f}</style></head><body><h1>Football Bet POS — ${title} (${activeDate})</h1><table><thead><tr>${rows[0].map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(r => `<tr>${r.map((x, index) => pdfCell(x, index)).join('')}</tr>`).join('')}</tbody></table><h2>Summary</h2><table class="summary"><thead><tr><th>Summary</th><th>Value</th></tr></thead><tbody>${summary.map(([label, value]) => `<tr><td>${label}</td><td class="${value.startsWith('+') ? 'positive' : value.startsWith('-') ? 'negative' : ''}">${value}</td></tr>`).join('')}</tbody></table><p class="legend">↔ = BD မူရင်းအခြေခံ rule သည် ညာအသင်းဘက်ဖြစ်သည်။</p></body></html>`;
    if (await window.footballPos.data.exportPdf(`football-settlement-${activeBookmaker}-${activeDate}`, html)) flash('PDF export ပြီးပါပြီ။');
  };
  (window as Window & { footballPosReportMode?: boolean }).footballPosReportMode = page === 'report';
  if (fixturePicker) {
    const query = fixtureFilter.trim().toLowerCase();
    const visible = fixturePicker.fixtures.filter(fixture => !query || `${fixture.home} ${fixture.away} ${fixture.league}`.toLowerCase().includes(query)).slice(0, 100);
    return <main><section className="card" style={{ maxWidth: '1000px', margin: '30px auto' }}><p className="eyebrow">LINK API FIXTURE</p><h2>Software: {fixturePicker.match.home} vs {fixturePicker.match.away}</h2><p className="muted">စာရင်းရက်: <b>{fixturePicker.match.date}</b> · Default သည် match ၏ actual kickoff date ဖြစ်သည်။ မနက် 06:00 မတိုင်မီပွဲကို နောက်တစ်ရက်အဖြစ် အလိုအလျောက်ရွေးပြီး လိုအပ်လျှင် manual ပြောင်းနိုင်သည်။</p><div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '12px' }}><label style={{ margin: 0 }}>API fixture ရှာမည့်ရက်<input type="date" value={fixturePicker.searchDate} onChange={e => setFixturePicker({ ...fixturePicker, searchDate: e.target.value })}/></label><button type="button" disabled={fixturePickerLoading} onClick={() => void searchApiFixtureDate()}>{fixturePickerLoading ? 'ရှာနေသည်…' : 'ဤရက်ကို အသစ်ပြန်ယူမည်'}</button><small className="muted">ရက်တစ်ရက်သာ ရှာသဖြင့် ပထမ load သို့မဟုတ် အသစ်ပြန်ယူမှုသည် request 1 ခု။ Cache ရှိသော နောက်ထပ် link သည် request 0 ခု။</small></div><p className="muted">API Match ၏ Home/Away အစဉ်နှင့် Software ၏ ဘယ်/ညာအစဉ်ကို နှိုင်းပြီး ချိတ်နည်းရွေးပါ။ မှားလျှင် result ပြောင်းပြန်ဖြစ်နိုင်သည်။</p><input autoFocus value={fixtureFilter} onChange={e => setFixtureFilter(e.target.value)} placeholder="Loaded list ထဲမှ English team or league name ရှာပါ"/><button type="button" className="secondary" onClick={() => setFixturePicker(null)}>မချိတ်တော့ပါ</button><div className="table-wrap"><table><thead><tr><th>Myanmar Time</th><th>League</th><th>API Match</th><th>Status</th><th>Mapping ရွေးရန်</th></tr></thead><tbody>{visible.map(fixture => <tr key={fixture.id}><td>{new Date(fixture.kickoffAt).toLocaleString('en-GB', { timeZone: 'Asia/Yangon', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td><td>{fixture.league}</td><td><b>{fixture.home}</b> vs <b>{fixture.away}</b></td><td>{fixture.status}</td><td><button type="button" onClick={() => void chooseApiFixture(fixture, false)}>API အစဉ်အတိုင်း</button><button type="button" className="secondary" onClick={() => void chooseApiFixture(fixture, true)}>ဘယ်/ညာ ပြောင်းချိတ်</button></td></tr>)}{visible.length === 0 && <tr><td colSpan={5} className="empty">ကိုက်ညီသော fixture မတွေ့ပါ။ English အသင်းနာမည် တစ်စိတ်တစ်ပိုင်းဖြင့် ရှာပါ။</td></tr>}</tbody></table></div></section></main>;
  }
  if (!store) return <main className="loading">Football Bet POS ဖွင့်နေသည်…</main>;
  return <main><header><div><p className="eyebrow">OFFLINE DESKTOP POS</p><h1>Football Bet POS</h1></div><div className="workspace-picker" style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' }}><div className="day-picker"><label>ဒိုင် / Channel<select value={activeBookmaker} onChange={e => { setActiveBookmaker(e.target.value as Bookmaker); resetBetForm(); resetMatchForm(); }}><option value="viber">Viber ဒိုင်</option><option value="messenger">Messenger ဒိုင်</option></select></label><small>Match နှင့် လောင်းကြေး သီးခြားထားသည်</small></div><div className="day-picker"><label>အလုပ်လုပ်မည့်ရက်<input type="date" value={activeDate} onChange={e => { setActiveDate(e.target.value); resetBetForm(); resetMatchForm(); }}/></label><small>ရက်ပြောင်းလျှင် စာရင်းများ မပေါင်းပါ</small></div></div><nav>{([['matches','Matches & Rules'],['ledger','လောင်းမှတ်တမ်း'],['report','Daily Report'],['settings','Settings']] as const).map(([id, text]) => <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}>{text}</button>)}</nav></header>{notice && <div className="notice">{notice}</div>}
  {page === 'matches' && <section className="grid"><article className="card form-card"><h2>Match အသစ်နှင့် Rule သတ်မှတ်ရန်</h2><p className="muted">{activeDate} အတွက် match ထည့်နေသည်။ အသင်းများကို Settings → Team list မှာ အရင်သတ်မှတ်ပြီး short code ဖြင့် Quick Entry သုံးနိုင်သည်။</p>{teams.length === 0 && <div className="team-warning">Team list မရှိသေးပါ။ Settings မှာ အသင်းနှင့် short code အရင်ထည့်ပါ။</div>}<form onSubmit={addMatch}><div className="form-grid"><label>Time<input type="time" value={matchForm.time} onChange={e => setMatchForm({ ...matchForm, time: e.target.value })}/></label><TeamSelect label="ဘယ်အသင်း" value={matchForm.home} teams={teams} onChange={home => setMatchForm({ ...matchForm, home })}/><TeamSelect label="ညာအသင်း" value={matchForm.away} teams={teams} onChange={away => setMatchForm({ ...matchForm, away })}/></div>{matchForm.rules.map((rule, index) => <div className="rule-box" key={rule.id}><div className="rule-head"><b>{index + 1}. Flexible rule</b>{matchForm.rules.length > 1 && <button type="button" className="link danger" onClick={() => setMatchForm({ ...matchForm, rules: matchForm.rules.filter(x => x.id !== rule.id) })}>ဖျက်</button>}</div><RuleEditor rule={rule} home={matchForm.home} away={matchForm.away} onChange={next => setMatchForm({ ...matchForm, rules: matchForm.rules.map(x => x.id === rule.id ? next : x) })}/></div>)}<button type="button" className="secondary" onClick={() => setMatchForm({ ...matchForm, rules: [...matchForm.rules, defaultRule('body')] })}>+ Rule ထပ်ထည့်</button><button type="submit">Match သိမ်းမည်</button></form></article><article className="card"><h2>{activeDate} Match များ</h2>{dayMatches.length === 0 ? <p className="muted">ဤရက်အတွက် Match မရှိသေးပါ။ ရက်ဟောင်း data မပေါင်းပါ။</p> : dayMatches.map(m => <MatchCard key={m.id} match={m} onSave={saveResult}/>)}</article></section>}
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

      <article className="card">
        <h2>{activeDate} မှတ်တမ်းများ ({dayBets.length})</h2>
        <LedgerTable rows={daySettlements} settings={activeCommission} view={store.settings.view} onInsertAfter={insertBetAfter} sortable />
      </article>
    </section>
  )}
  {page === 'settings' && <section className="card" style={{ marginBottom: '20px' }}><p className="eyebrow">OVERNIGHT AUTOMATION</p><h2>API-Football Result Automation</h2><p className="muted">API key ကို encrypted storage တွင်သိမ်းသည်။ Project file နှင့် report များထဲ မထည့်ပါ။ App နှင့် Mac ကို ညအချိန်ဖွင့်ထားရမည်။</p><label>API Key<input type="password" autoComplete="off" value={apiKeyInput} onChange={e => setApiKeyInput(e.target.value)} placeholder={apiKeyConfigured ? 'Key သိမ်းပြီးသား — အသစ်ပြောင်းရန်သာ ထည့်ပါ' : 'API-Football key ထည့်ပါ'}/></label><button type="button" onClick={() => void saveApiKey()}>Key လုံခြုံစွာသိမ်းမည်</button><button type="button" className="secondary" onClick={() => void testApi()}>Connection စမ်းမည်</button>{apiMessage && <p className="muted">{apiMessage}</p>}<label className="check" style={{ margin: '14px 0 8px' }}><input type="checkbox" checked={store.settings.automation.enabled} onChange={e => void save({ ...store, settings: { ...store.settings, automation: { ...store.settings.automation, enabled: e.target.checked } } })}/> ညပိုင်း result အလိုအလျောက်စစ်မည်</label><div className="form-grid"><label>စစ်ဆေးချိန်မှ<input type="time" value={store.settings.automation.windowStart} onChange={e => void save({ ...store, settings: { ...store.settings, automation: { ...store.settings.automation, windowStart: e.target.value } } })}/></label><label>စစ်ဆေးချိန်အထိ<input type="time" value={store.settings.automation.windowEnd} onChange={e => void save({ ...store, settings: { ...store.settings, automation: { ...store.settings.automation, windowEnd: e.target.value } } })}/></label><label>မိနစ်ခြား<input type="number" min="5" max="60" value={store.settings.automation.pollMinutes} onChange={e => void save({ ...store, settings: { ...store.settings, automation: { ...store.settings.automation, pollMinutes: Math.max(5, Number(e.target.value) || 10) } } })}/></label></div><button type="button" disabled={automationBusy} onClick={() => void checkApiResults(true)}>{automationBusy ? 'စစ်ဆေးနေသည်…' : 'Result ယခုစစ်မည်'}</button></section>}
  {page === 'settings' && <section className="card" style={{ marginBottom: '20px' }}><p className="eyebrow">CURRENT DATE DATA</p><h2>{activeDate} · {activeBookmaker === 'viber' ? 'Viber' : 'Messenger'}</h2><p className="muted">Match {dayMatches.length} ပွဲနှင့် လောင်းမှတ်တမ်း {dayBets.length} ခုကို အခြား channel သို့ ရွှေ့နိုင်သည်၊ သို့မဟုတ် မူရင်းကိုထားပြီး copy ကူးနိုင်သည်။</p><button type="button" onClick={() => void transferDayData('move')}>အခြား Channel သို့ ရွှေ့မည်</button><button type="button" className="secondary" onClick={() => void transferDayData('copy')}>မူရင်းထားပြီး Copy ကူးမည်</button></section>}
  {page === 'report' && <section className="card report"><div className="report-head"><div><p className="eyebrow">{activeBookmaker.toUpperCase()} DAILY SETTLEMENT · {store.settings.view === 'dai' ? 'ဒိုင် View' : 'Player View'}</p><h2>{activeDate} စာရင်း</h2></div><div><button className="secondary" onClick={async () => { if (await window.footballPos.data.exportCsv(csvRows())) flash('Excel CSV export ပြီးပါပြီ။'); }}>Excel CSV ထုတ်</button><button onClick={() => void exportPdf()}>PDF ထုတ်</button></div></div><LedgerTable rows={reportSettlements} settings={activeCommission} view={store.settings.view} totals={reportTotals} sortable sortMode={reportSortMode} onSortModeChange={setReportSortMode}/><SummaryPanel totals={reportTotals}/></section>}
  {page === 'settings' && <section className="settings-page"><article className="card settings"><h2>{activeBookmaker === 'viber' ? 'Viber' : 'Messenger'} Report Settings</h2><p className="muted">ဒိုင်တစ်ခုချင်းစီ၏ commission rule ကို သီးခြားသိမ်းသည်။ View ပြောင်းခြင်းသည် record data ကို မပြောင်းပါ။</p><label>View<select value={store.settings.view} onChange={e => void save({ ...store, settings: { ...store.settings, view: e.target.value as ViewMode } })}><option value="dai">ဒိုင် View</option><option value="player">Player View</option></select></label>{activeCommission.mode === 'direct' ? <><label>Player နိုင်လျှင် ဖြတ်မည့်နှုန်း (%)<input type="number" min="0" max="100" value={activeCommission.playerWinDeduction} onChange={e => updateBookmakerSettings({ playerWinDeduction: percent(Number(e.target.value)) })}/></label><label>Player ရှုံးလျှင် ပြန်ပေးမည့်နှုန်း (%)<input type="number" min="0" max="100" value={activeCommission.playerLossRebate} onChange={e => updateBookmakerSettings({ playerLossRebate: percent(Number(e.target.value)) })}/></label><p className="muted">လက်ရှိ Viber rule: Player Win {activeCommission.playerWinDeduction}% · Player Lose {activeCommission.playerLossRebate}%</p></> : <><label>Gross WIN မှ ဖြတ်မည့်နှုန်း (%)<input type="number" min="0" max="100" value={activeCommission.winTaxRate} onChange={e => updateBookmakerSettings({ winTaxRate: percent(Number(e.target.value)) })}/></label><label>Gross WIN + LOSE ပေါ် Player ကိုပေးမည့် Commission (%)<input type="number" min="0" max="100" value={activeCommission.turnoverCommissionRate} onChange={e => updateBookmakerSettings({ turnoverCommissionRate: percent(Number(e.target.value)) })}/></label><p className="muted">Messenger rule: WIN ကို {activeCommission.winTaxRate}% ဖြတ်ပြီး စုစုပေါင်း settled turnover ပေါ် {activeCommission.turnoverCommissionRate}% ကို Player အား ပြန်ပေးသည်။</p></>}</article><article className="card team-card"><h2>Team list · Quick Code</h2><p className="muted">Quick Entry အတွက် အသင်းအမည်နှင့် မထပ်သော short code သတ်မှတ်ပါ။ ဥပမာ Chelsea → ch</p><form className="team-form" onSubmit={addTeam}><label>Team name<input value={teamForm.name} onChange={e => setTeamForm({ ...teamForm, name: e.target.value })} placeholder="Chelsea"/></label><label>Short code<input value={teamForm.code} onChange={e => setTeamForm({ ...teamForm, code: e.target.value })} placeholder="ch" maxLength={12}/></label><button type="submit">+ Team ထည့်မည်</button></form>{teams.length === 0 ? <p className="muted">Team မရှိသေးပါ။</p> : <div className="team-list">{teams.map(team => <div key={team.id}><b>{team.name}</b><code>{team.code}</code><button type="button" className="link danger" onClick={() => void deleteTeam(team)}>ဖျက်</button></div>)}</div>}</article></section>}{confirmation && <div className="confirm-overlay" role="dialog" aria-modal="true"><div className="confirm-modal"><h3>အတည်ပြုပါ</h3><p>{confirmation.message}</p><div><button type="button" className="secondary" onClick={() => closeConfirm(false)}>မလုပ်တော့ပါ</button><button type="button" autoFocus onClick={() => closeConfirm(true)}>အတည်ပြုမည်</button></div></div></div>}</main>;
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
