import { useEffect, useMemo, useState } from 'react';
import type { Band, Bet, Market, Match, Outcome, Rule, Selection, Settlement, Store, Team } from '../shared/models';
import { BODY_ODDS_PRESETS, TOTAL_ODDS_PRESETS, formatBandSummary, parseMyanmarOdds } from '../shared/odds';

const uid = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);
const money = (n: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(n));
const sortBets = (items: Bet[]) => [...items].sort((a, b) =>
  (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
  || (a.placedAt ?? '').localeCompare(b.placedAt ?? '')
  || a.id.localeCompare(b.id)
);
const sortSettlements = (items: Settlement[], mode: 'latest' | 'ledger') => mode === 'latest'
  ? [...items].sort((a, b) => (b.bet.placedAt ?? '').localeCompare(a.bet.placedAt ?? '') || b.bet.id.localeCompare(a.bet.id))
  : items;
type QuickAction = 'b' | 'u' | 'd';
type QuickRequest = { team: Team; action: QuickAction; amount: number };
const parseQuickEntry = (input: string, teams: Team[]): QuickRequest | string => {
  const compact = input.trim().toLowerCase().replace(/[\s,]/g, '');
  if (!compact) return 'Quick code ထည့်ပါ။ ဥပမာ chb50000';
  const team = [...teams].sort((a, b) => b.code.length - a.code.length).find(item => compact.startsWith(item.code.toLowerCase()));
  if (!team) return 'Team code မတွေ့ပါ။ Teams မှာ short code အရင်ထည့်ပါ။';
  const rest = compact.slice(team.code.length);
  const match = rest.match(/^([bud])(\d+(?:[kmw])?)$/);
  if (!match) return 'Format မမှန်ပါ။ ဥပမာ chb50000, chu50k, mud5w';
  const unit = match[2].slice(-1);
  const numeric = Number(unit === 'k' || unit === 'm' || unit === 'w' ? match[2].slice(0, -1) : match[2]);
  const multiplier = unit === 'k' ? 1_000 : unit === 'w' ? 10_000 : unit === 'm' ? 1_000_000 : 1;
  return numeric > 0 ? { team, action: match[1] as QuickAction, amount: numeric * multiplier } : 'လောင်းငွေသည် 0 ထက်ကြီးရမည်။';
};
const action = (outcome: Outcome, rate: number): Band => ({ outcome, rate: outcome === 'refund' ? 0 : Number(rate) || 0 });
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
    status: 'active',
    effectiveAt: new Date().toISOString(),
    provisional: provisional === true,
  };
};
const labels: Record<Outcome, string> = { win: 'အမြတ်', loss: 'အရှုံး', refund: 'ပြန်အမ်း' };
function settle(bet: Bet, match: Match, rule: Rule): Settlement {
  if (match.postponed) return { bet, match, rule, band: action('refund', 0), signed: 0, label: 'P:P / ပြန်အမ်း' };
  if (match.homeScore === null || match.awayScore === null) return { bet, match, rule, band: action('refund', 0), signed: 0, label: 'Pending' };
  // Every market is quoted from one base perspective: Home for Body and Up
  // for O/U. Away and Down are the same condition's exact inverse; their
  // score/total must not be compared to a reversed line.
  const value = rule.market === 'body'
    ? match.homeScore - match.awayScore
    : match.homeScore + match.awayScore;
  const baseBand = value < rule.line ? rule.below : value === rule.line ? rule.equal : rule.above;
  const oppositeSide = (rule.market === 'body' && bet.selection === 'away') || (rule.market === 'total' && bet.selection === 'down');
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
function BandFields({ label, value, onChange }: { label: string; value: Band; onChange: (v: Band) => void }) {
  return <div className="band"><span>{label}</span><select value={value.outcome} onChange={e => onChange(action(e.target.value as Outcome, value.rate))}>{(['win', 'loss', 'refund'] as Outcome[]).map(x => <option value={x} key={x}>{labels[x]}</option>)}</select>{value.outcome !== 'refund' && <input aria-label={`${label} rate`} type="number" min="0" max="100" value={value.rate} onChange={e => onChange(action(value.outcome, Number(e.target.value)))} />}</div>;
}
function RuleEditor({ rule, onChange }: { rule: Rule; onChange: (r: Rule) => void }) {
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
      </div>

      <div className="rule-summary-badge">
        <label className="badge-pill">Status: <select value={rule.provisional ? 'temporary' : 'confirmed'} onChange={e => onChange({ ...rule, provisional: e.target.value === 'temporary' })}><option value="confirmed">အတည် rule</option><option value="temporary">ယာယီ default</option></select></label>
        <span className="badge-pill">Line: <b>{rule.line}</b></span>
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
  const known = teams.some(team => team.name === value);
  return <label>{label}<select value={value} onChange={e => onChange(e.target.value)}><option value="">-- Team ရွေးပါ --</option>{value && !known && <option value={value}>{value} (old record)</option>}{teams.map(team => <option key={team.id} value={team.name}>{team.name} ({team.code})</option>)}</select></label>;
}
export function App() {
  const [store, setStore] = useState<Store | null>(null); const [page, setPage] = useState<'matches' | 'ledger' | 'report' | 'settings'>('matches'); const [notice, setNotice] = useState(''); const [activeDate, setActiveDate] = useState(today());
  const [matchForm, setMatchForm] = useState({ time: '19:00', home: '', away: '', rules: [defaultRule('body', true), defaultRule('total', true)] as Rule[] }); const [editingMatchId, setEditingMatchId] = useState<string | null>(null);
  const [betForm, setBetForm] = useState({ matchId: '', ruleId: '', selection: 'home' as Selection, note: '', amount: '', lateReceivedAt: '', lateReason: '' }); const [editingBetId, setEditingBetId] = useState<string | null>(null); const [insertAfterBetId, setInsertAfterBetId] = useState<string | null>(null); const [matchSearch, setMatchSearch] = useState(''); const [quickEntry, setQuickEntry] = useState(''); const [quickCandidates, setQuickCandidates] = useState<{ request: QuickRequest; matches: Match[] } | null>(null); const [teamForm, setTeamForm] = useState({ name: '', code: '' }); const [reportSortMode, setReportSortMode] = useState<'latest' | 'ledger'>('latest');
  useEffect(() => { void window.footballPos.data.load().then(setStore); }, []);
  useEffect(() => {
    const rules = (store?.matches ?? []).flatMap(match => match.rules);
    document.querySelectorAll('option').forEach(option => {
      const rule = rules.find(item => item.id === (option as HTMLOptionElement).value);
      if (rule) option.textContent = `${rule.market === 'body' ? 'BD' : 'O/U'} — ${rule.code} [${rule.status === 'closed' ? 'ပိတ် · Late entry only' : rule.provisional ? 'ယာယီ · အကြေးမထွက်သေး' : 'ဖွင့်'}]`;
    });
  }, [store, betForm.matchId]);
  const save = async (next: Store) => { setStore(next); await window.footballPos.data.save(next); };
  const teams = store?.teams ?? []; const matches = store?.matches ?? []; const bets = store?.bets ?? []; const dayMatches = matches.filter(x => x.date === activeDate); const dayBets = bets.filter(x => x.date === activeDate);
  const filteredDayMatches = useMemo(() => {
    if (!matchSearch.trim()) return dayMatches;
    const q = matchSearch.toLowerCase();
    return dayMatches.filter(m => m.home.toLowerCase().includes(q) || m.away.toLowerCase().includes(q));
  }, [dayMatches, matchSearch]);
  useEffect(() => { const match = dayMatches.find(item => item.id === betForm.matchId); const active = match?.rules.find(rule => rule.status !== 'closed'); if (match && active) setBetForm(current => ({ ...current, ruleId: active.id, selection: active.market === 'total' ? 'up' : 'home' })); }, [betForm.matchId]);
  const selectedMatch = dayMatches.find(x => x.id === betForm.matchId); const selectedRule = selectedMatch?.rules.find(x => x.id === betForm.ruleId);
  const settlements = useMemo(() => store ? sortBets(bets).map(b => { const m = matches.find(x => x.id === b.matchId); const r = b.ruleSnapshot ?? m?.rules.find(x => x.id === b.ruleId); return m && r ? settle(b, m, r) : null; }).filter(Boolean) as Settlement[] : [], [store, bets, matches]);
  const daySettlements = settlements.filter(x => x.bet.date === activeDate); const reportSettlements = sortSettlements(daySettlements, reportSortMode); const settled = daySettlements.filter(x => x.label !== 'Pending'); const grossWin = settled.filter(x => x.signed > 0).reduce((n, x) => n + x.signed, 0); const grossLoss = settled.filter(x => x.signed < 0).reduce((n, x) => n + x.signed, 0); const adjustedWin = grossWin * (1 - (store?.settings.winDeduction ?? 0) / 100); const turnover = grossWin + Math.abs(grossLoss); const commission = turnover * (store?.settings.commission ?? 0) / 100; const total = adjustedWin + commission + grossLoss;
  const flash = (message: string) => { setNotice(message); setTimeout(() => setNotice(''), 3500); };
  const resetMatchForm = () => { setEditingMatchId(null); setMatchForm({ time: '19:00', home: '', away: '', rules: [defaultRule('body', true), defaultRule('total', true)] }); };
  const addMatch = async (e: React.FormEvent) => { e.preventDefault(); if (!store || !matchForm.home.trim() || !matchForm.away.trim()) return flash('အသင်းနှစ်သင်းလုံး ထည့်ပါ။'); const previous = editingMatchId ? matches.find(x => x.id === editingMatchId) : undefined; const history = previous?.rules.filter(rule => rule.status === 'closed') ?? []; const provisionalIds = new Set(previous?.rules.filter(rule => rule.provisional).map(rule => rule.id) ?? []); const finalizedRules = previous ? matchForm.rules.map(rule => provisionalIds.has(rule.id) ? { ...rule, provisional: false } : rule) : matchForm.rules; const updated: Match = { id: previous?.id || uid(), ...matchForm, rules: previous ? [...history, ...finalizedRules] : finalizedRules, date: activeDate, home: matchForm.home.trim(), away: matchForm.away.trim(), homeScore: previous?.homeScore ?? null, awayScore: previous?.awayScore ?? null, postponed: previous?.postponed ?? false }; const provisionalBets = previous ? bets.filter(bet => bet.matchId === previous.id && provisionalIds.has(bet.ruleId)) : []; if (provisionalBets.length && !window.confirm(`Temporary rule ဖြင့် ထိုးထားသော record ${provisionalBets.length} ခုကို ယခု actual rule ဖြင့် update လုပ်မလား?`)) return; const refreshedBets = previous ? bets.map(bet => { const newRule = updated.rules.find(rule => rule.id === bet.ruleId); return newRule && provisionalIds.has(bet.ruleId) ? { ...bet, ruleSnapshot: structuredClone(newRule) } : bet; }) : bets; await save({ ...store, matches: previous ? matches.map(x => x.id === previous.id ? updated : x) : [...matches, updated], bets: refreshedBets }); resetMatchForm(); flash(previous && provisionalBets.length ? `Actual rule ကိုအတည်ပြုပြီး record ${provisionalBets.length} ခုကို update လုပ်ပြီးပါပြီ။` : previous ? 'Active rule များကို ပြင်ပြီးပါပြီ။ ပိတ်ထားသော rule history မပြောင်းပါ။' : 'Match နှင့် temporary default rule များကို သိမ်းပြီးပါပြီ။'); };
  const saveResult = async (m: Match, homeScore: string, awayScore: string, postponed: boolean) => { if (!store) return; const updated = { ...m, homeScore: postponed ? null : Number(homeScore), awayScore: postponed ? null : Number(awayScore), postponed }; await save({ ...store, matches: matches.map(x => x.id === m.id ? updated : x) }); flash(postponed ? 'P:P / Refund အဖြစ်သိမ်းပြီးပါပြီ။' : 'Result သိမ်းပြီး settlement ကို update လုပ်ပြီးပါပြီ။'); };
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
    const existingDayBets = sortBets(bets.filter(bet => bet.date === selectedMatch.date && bet.id !== editingBetId));
    const insertAt = !isEditing && insertAfterBetId ? Math.max(0, existingDayBets.findIndex(bet => bet.id === insertAfterBetId) + 1) : existingDayBets.length;
    const previousBet = editingBetId ? bets.find(bet => bet.id === editingBetId) : undefined;
    const updated: Bet = {
      id: editingBetId || uid(),
      date: selectedMatch.date,
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
      : [...bets.filter(bet => bet.date !== selectedMatch.date), ...reorderedDayBets, updated];
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
    const prior = sortBets(bets.filter(item => item.date === activeDate)).map((item, index) => ({ ...item, sortOrder: index }));
    const bet: Bet = { id: uid(), date: activeDate, matchId: match.id, ruleId: rule.id, selection, note: '', amount: request.amount, sortOrder: prior.length, ruleSnapshot: structuredClone(rule), placedAt: new Date().toISOString(), lateEntry: false, lateReason: '' };
    await save({ ...store, bets: [...bets.filter(item => item.date !== activeDate), ...prior, bet] });
    setQuickEntry(''); setQuickCandidates(null);
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
  const editMatch = (m: Match) => { setEditingMatchId(m.id); setMatchForm({ time: m.time, home: m.home, away: m.away, rules: m.rules.filter(rule => rule.status !== 'closed') }); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const commitRuleChange = async (m: Match, drafts: Rule[]) => { const markets = drafts.map(rule => rule.market); const closing = m.rules.filter(rule => rule.status !== 'closed' && markets.includes(rule.market)).map(rule => `${rule.market === 'body' ? 'BD' : 'O/U'} ${rule.code}`).join(', '); if (!window.confirm(`${closing || 'လက်ရှိအကြေး'} ကို ပိတ်ပြီး rule အသစ်ဖွင့်မလား?\n\nအရင်လောင်းမှတ်တမ်းများ မပျက်ပါ။`)) return false; const now = new Date().toISOString(); const activeDrafts = drafts.map(rule => ({ ...rule, status: 'active' as const, effectiveAt: now, closedAt: undefined })); const next: Match = { ...m, rules: [...m.rules.map(rule => rule.status === 'closed' || !markets.includes(rule.market) ? rule : { ...rule, status: 'closed' as const, closedAt: now }), ...activeDrafts] }; await save({ ...store!, matches: matches.map(x => x.id === m.id ? next : x) }); flash('Rule အသစ်ကိုဖွင့်ပြီး အဟောင်း rule ကို history အဖြစ်ပိတ်ထားပါပြီ။'); return true; };
  const deleteMatch = async (m: Match) => { const linked = bets.filter(x => x.matchId === m.id).length; if (!window.confirm(`“${m.home} vs ${m.away}” ကိုဖျက်မလား? ချိတ်ထားသော လောင်းမှတ်တမ်း ${linked} ခုလည်း ဖျက်မည်။`)) return; await save({ ...store!, matches: matches.filter(x => x.id !== m.id), bets: bets.filter(x => x.matchId !== m.id) }); if (editingMatchId === m.id) resetMatchForm(); flash('Match နှင့် ချိတ်ထားသော record များ ဖျက်ပြီးပါပြီ။'); };
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
  const deleteBet = async (s: Settlement) => { if (!window.confirm(`ထိုးငွေ ${money(s.bet.amount)} Ks record ကိုဖျက်မလား?`)) return; const remainingDay = sortBets(bets.filter(x => x.date === s.bet.date && x.id !== s.bet.id)).map((bet, index) => ({ ...bet, sortOrder: index })); await save({ ...store!, bets: [...bets.filter(x => x.date !== s.bet.date), ...remainingDay] }); if (editingBetId === s.bet.id) resetBetForm(); if (insertAfterBetId === s.bet.id) setInsertAfterBetId(null); flash('လောင်းမှတ်တမ်း ဖျက်ပြီးပါပြီ။'); };
  (window as any).footballPosActions = { editMatch, deleteMatch, editBet, deleteBet, insertBetAfter, commitRuleChange };
  const reportRows = () => [['No.', 'Match', 'Rule', 'ရွေးချယ်မှု', 'လောင်းငွေ', 'Result', '% (+)', '% (-)', 'WIN', 'LOSE', 'Status'], ...reportSettlements.map((s, i) => [String(i + 1), `${s.match.home} vs ${s.match.away}`, s.rule.code, selectionLabel(s), money(s.bet.amount), s.match.postponed ? 'P:P' : s.match.homeScore === null ? '' : `${s.match.homeScore}:${s.match.awayScore}`, s.band.outcome === 'win' ? String(s.band.rate) : '', s.band.outcome === 'loss' ? String(s.band.rate) : '', s.signed > 0 ? money(s.signed) : '', s.signed < 0 ? `-${money(s.signed)}` : '', s.label]), ['', '', '', '', '', '', '', '', 'WIN', money(grossWin), ''], ['', '', '', '', '', '', '', '', `WIN - ${store?.settings.winDeduction ?? 0}%`, money(adjustedWin), ''], ['', '', '', '', '', '', '', '', `Com (${store?.settings.commission ?? 0}%)`, money(commission), ''], ['', '', '', '', '', '', '', '', 'LOSE', `-${money(grossLoss)}`, ''], ['', '', '', '', '', '', '', '', 'TOTAL', `${total < 0 ? '-' : ''}${money(total)}`, '']];
  const exportPdf = async () => { const rows = reportRows(); const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;padding:22px;color:#13261a}h1{font-size:20px}table{width:100%;border-collapse:collapse;font-size:10px}td,th{border:1px solid #8da393;padding:5px;text-align:left}th{background:#d6e7b0} .n{text-align:right}</style></head><body><h1>Football Bet POS — Daily Settlement (${activeDate})</h1><table><thead><tr>${rows[0].map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(r => `<tr>${r.map(x => `<td>${x}</td>`).join('')}</tr>`).join('')}</tbody></table><p>WIN: ${money(grossWin)} &nbsp; WIN - ${store?.settings.winDeduction ?? 0}%: ${money(adjustedWin)} &nbsp; Com (${store?.settings.commission ?? 0}%): ${money(commission)} &nbsp; LOSE: -${money(grossLoss)} &nbsp; TOTAL: ${total < 0 ? '-' : ''}${money(total)}</p></body></html>`; if (await window.footballPos.data.exportPdf(`football-settlement-${activeDate}`, html)) flash('PDF export ပြီးပါပြီ။'); };
  (window as Window & { footballPosReportMode?: boolean }).footballPosReportMode = page === 'report';
  if (!store) return <main className="loading">Football Bet POS ဖွင့်နေသည်…</main>;
  return <main><header><div><p className="eyebrow">OFFLINE DESKTOP POS</p><h1>Football Bet POS</h1></div><div className="day-picker"><label>အလုပ်လုပ်မည့်ရက်<input type="date" value={activeDate} onChange={e => { setActiveDate(e.target.value); resetBetForm(); }}/></label><small>ရက်ပြောင်းလျှင် စာရင်းများ မပေါင်းပါ</small></div><nav>{([['matches','Matches & Rules'],['ledger','လောင်းမှတ်တမ်း'],['report','Daily Report'],['settings','Settings']] as const).map(([id, text]) => <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}>{text}</button>)}</nav></header>{notice && <div className="notice">{notice}</div>}
  {page === 'matches' && <section className="grid"><article className="card form-card"><h2>Match အသစ်နှင့် Rule သတ်မှတ်ရန်</h2><p className="muted">{activeDate} အတွက် match ထည့်နေသည်။ အသင်းများကို Settings → Team list မှာ အရင်သတ်မှတ်ပြီး short code ဖြင့် Quick Entry သုံးနိုင်သည်။</p>{teams.length === 0 && <div className="team-warning">Team list မရှိသေးပါ။ Settings မှာ အသင်းနှင့် short code အရင်ထည့်ပါ။</div>}<form onSubmit={addMatch}><div className="form-grid"><label>Time<input type="time" value={matchForm.time} onChange={e => setMatchForm({ ...matchForm, time: e.target.value })}/></label><TeamSelect label="ဘယ်အသင်း" value={matchForm.home} teams={teams} onChange={home => setMatchForm({ ...matchForm, home })}/><TeamSelect label="ညာအသင်း" value={matchForm.away} teams={teams} onChange={away => setMatchForm({ ...matchForm, away })}/></div>{matchForm.rules.map((rule, index) => <div className="rule-box" key={rule.id}><div className="rule-head"><b>{index + 1}. Flexible rule</b>{matchForm.rules.length > 1 && <button type="button" className="link danger" onClick={() => setMatchForm({ ...matchForm, rules: matchForm.rules.filter(x => x.id !== rule.id) })}>ဖျက်</button>}</div><RuleEditor rule={rule} onChange={next => setMatchForm({ ...matchForm, rules: matchForm.rules.map(x => x.id === rule.id ? next : x) })}/></div>)}<button type="button" className="secondary" onClick={() => setMatchForm({ ...matchForm, rules: [...matchForm.rules, defaultRule('body')] })}>+ Rule ထပ်ထည့်</button><button type="submit">Match သိမ်းမည်</button></form></article><article className="card"><h2>{activeDate} Match များ</h2>{dayMatches.length === 0 ? <p className="muted">ဤရက်အတွက် Match မရှိသေးပါ။ ရက်ဟောင်း data မပေါင်းပါ။</p> : dayMatches.map(m => <MatchCard key={m.id} match={m} onSave={saveResult}/>)}</article></section>}
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
          <small><b>b</b> = Body · <b>u</b> = Up · <b>d</b> = Down · <b>k</b> = 1,000 · <b>w</b> = 10,000 · <b>m</b> = 1,000,000</small>
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
                        selection: r.market === 'total' ? 'up' : 'home'
                      }))}
                    >
                      <span>{r.market === 'body' ? '⚽ BD' : '🎯 O/U'} <b>{r.code}</b></span>
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
        <LedgerTable rows={daySettlements} onInsertAfter={insertBetAfter} sortable />
      </article>
    </section>
  )}
  {page === 'report' && <section className="card report"><div className="report-head"><div><p className="eyebrow">DAILY SETTLEMENT</p><h2>{activeDate} စာရင်း</h2></div><div><button className="secondary" onClick={async () => { if (await window.footballPos.data.exportCsv(reportRows())) flash('Excel CSV export ပြီးပါပြီ။'); }}>Excel CSV ထုတ်</button><button onClick={() => void exportPdf()}>PDF ထုတ်</button></div></div><LedgerTable rows={reportSettlements} sortable sortMode={reportSortMode} onSortModeChange={setReportSortMode}/><div className="totals"><span>WIN <b>{money(grossWin)}</b></span><span>WIN - {store.settings.winDeduction}% <b>{money(adjustedWin)}</b></span><span>Com ({store.settings.commission}%) <b>{money(commission)}</b></span><span>LOSE <b>-{money(grossLoss)}</b></span><strong>TOTAL {total < 0 ? '-' : ''}{money(total)}</strong></div></section>}
  {page === 'settings' && <section className="settings-page"><article className="card settings"><h2>Report Settings</h2><p className="muted">ပုံထဲက စာရင်းအတိုင်း WIN deduction နှင့် commission ကို ပြောင်းနိုင်သည်။</p><label>WIN deduction (%)<input type="number" min="0" max="100" value={store.settings.winDeduction} onChange={e => void save({ ...store, settings: { ...store.settings, winDeduction: Number(e.target.value) } })}/></label><label>Commission (%)<input type="number" min="0" max="100" value={store.settings.commission} onChange={e => void save({ ...store, settings: { ...store.settings, commission: Number(e.target.value) } })}/></label></article><article className="card team-card"><h2>Team list · Quick Code</h2><p className="muted">Quick Entry အတွက် အသင်းအမည်နှင့် မထပ်သော short code သတ်မှတ်ပါ။ ဥပမာ Chelsea → ch</p><form className="team-form" onSubmit={addTeam}><label>Team name<input value={teamForm.name} onChange={e => setTeamForm({ ...teamForm, name: e.target.value })} placeholder="Chelsea"/></label><label>Short code<input value={teamForm.code} onChange={e => setTeamForm({ ...teamForm, code: e.target.value })} placeholder="ch" maxLength={12}/></label><button type="submit">+ Team ထည့်မည်</button></form>{teams.length === 0 ? <p className="muted">Team မရှိသေးပါ။</p> : <div className="team-list">{teams.map(team => <div key={team.id}><b>{team.name}</b><code>{team.code}</code><button type="button" className="link danger" onClick={() => { if (window.confirm(`${team.name} ကို Team list မှဖျက်မလား?`)) void save({ ...store, teams: teams.filter(item => item.id !== team.id) }); }}>ဖျက်</button></div>)}</div>}</article></section>}</main>;
}
function MatchCard({ match, onSave }: { match: Match; onSave: (m: Match, h: string, a: string, p: boolean) => void }) { const [h, setH] = useState(match.homeScore?.toString() ?? ''); const [a, setA] = useState(match.awayScore?.toString() ?? ''); const [p, setP] = useState(match.postponed); const [drafts, setDrafts] = useState<Rule[] | null>(null); const actions = (window as any).footballPosActions; const compact = { padding: '5px 8px', margin: '0 3px 0 0', fontSize: '11px' }; const group = { display: 'flex', alignItems: 'center', gap: '3px' }; const startChange = (markets: Market[]) => setDrafts(markets.map(defaultRule)); const describe = (band: Band) => band.outcome === 'refund' ? 'Refund' : `${band.rate}% ${band.outcome === 'win' ? 'Win' : 'Loss'}`; return <div className="match" style={{ alignItems: 'flex-start' }}><div style={{ flex: 1 }}><b>{match.time} · {match.home} <em>vs</em> {match.away}</b><div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '7px' }}>{match.rules.map(r => <div key={r.id} style={{ border: `1px solid ${r.status === 'closed' ? '#d7c7c5' : r.provisional ? '#e8ab3e' : '#9bc28a'}`, background: r.status === 'closed' ? '#fbf5f4' : r.provisional ? '#fff7e7' : '#f2f8ed', borderRadius: '6px', padding: '5px 7px', fontSize: '11px' }}><b>{r.market === 'body' ? 'BD' : 'O/U'} {r.code}</b> · {r.status === 'closed' ? 'ပိတ်' : r.provisional ? 'ယာယီ · အကြေးမထွက်သေး' : 'အတည် · ဖွင့်'}<small style={{ display: 'block', marginTop: '2px', color: '#627563' }}>အောက် {describe(r.below)} · တိတိ {describe(r.equal)} · အထက် {describe(r.above)}</small></div>)}</div></div><div className="result" style={{ flexWrap: 'wrap', justifyContent: 'flex-end', rowGap: '7px', maxWidth: '470px' }}><div style={group}><span style={{ fontSize: '11px', color: '#607565', fontWeight: 700 }}>RESULT</span><input type="number" min="0" disabled={p} value={h} onChange={e => setH(e.target.value)}/><span>:</span><input type="number" min="0" disabled={p} value={a} onChange={e => setA(e.target.value)}/><label className="check"><input type="checkbox" checked={p} onChange={e => setP(e.target.checked)}/>P:P</label><button style={compact} onClick={() => onSave(match, h, a, p)}>သိမ်း</button></div><div style={group}><span style={{ fontSize: '11px', color: '#607565', fontWeight: 700 }}>ကြေးပြောင်း</span><button style={compact} className="secondary" onClick={() => startChange(['body'])}>BD</button><button style={compact} className="secondary" onClick={() => startChange(['total'])}>O/U</button><button style={compact} className="secondary" onClick={() => startChange(['body', 'total'])}>Both</button><button style={compact} className="secondary" onClick={() => actions.editMatch(match)}>ပြင်</button><button style={{ ...compact, background: '#a13c35' }} onClick={() => void actions.deleteMatch(match)}>ဖျက်</button></div>{drafts && <div style={{ width: '100%', background: '#f5f8f0', border: '1px solid #bdd6ad', borderRadius: '8px', padding: '10px' }}><b style={{ fontSize: '12px' }}>Rule အသစ် — ပိတ်မည့်အကြေးကို confirm မလုပ်မီ ပြင်ပါ</b>{drafts.map(rule => <RuleEditor key={rule.id} rule={rule} onChange={next => setDrafts(current => current?.map(x => x.id === rule.id ? next : x) ?? null)}/>)}<button style={compact} className="secondary" onClick={() => setDrafts(null)}>Cancel</button><button style={compact} onClick={async () => { if (await actions.commitRuleChange(match, drafts)) setDrafts(null); }}>Confirm & ဖွင့်</button></div>}</div></div>; }
function LedgerTable({ rows, onInsertAfter, sortable = false, sortMode: controlledSortMode, onSortModeChange }: { rows: Settlement[]; onInsertAfter?: (settlement: Settlement) => void; sortable?: boolean; sortMode?: 'latest' | 'ledger'; onSortModeChange?: (mode: 'latest' | 'ledger') => void }) {
  const [filterText, setFilterText] = useState('');
  const [localSortMode, setLocalSortMode] = useState<'latest' | 'ledger'>('latest');
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
            <th>Status</th>
            {editable && <th>Action</th>}
          </tr>
        </thead>
        <tbody>
          {displayRows.length === 0 ? (
            <tr>
              <td colSpan={editable ? 11 : 10} className="empty">
                {filterText ? 'ရှာဖွေမှုနှင့် ကိုက်ညီသော မှတ်တမ်းမရှိပါ' : 'မှတ်တမ်းမရှိသေးပါ'}
              </td>
            </tr>
          ) : (
            displayRows.map(s => (
              <tr key={s.bet.id}>
                <td>{rows.findIndex(row => row.bet.id === s.bet.id) + 1}</td>
                <td>{s.bet.note || '—'}</td>
                <td>
                  <b>{s.match.home}</b> vs <b>{s.match.away}</b>
                  <small>{s.rule.market === 'body' ? 'BD' : 'O/U'} {s.rule.code} · <span style={{ color: '#164e2d', fontWeight: 600 }}>{selectionLabel(s)}</span></small>
                </td>
                <td>{money(s.bet.amount)}</td>
                <td>{s.match.postponed ? 'P:P' : s.match.homeScore === null ? '—' : `${s.match.homeScore}:${s.match.awayScore}`}</td>
                <td>{s.band.outcome === 'win' ? s.band.rate : ''}</td>
                <td>{s.band.outcome === 'loss' ? s.band.rate : ''}</td>
                <td className="win">{s.signed > 0 ? money(s.signed) : ''}</td>
                <td className="loss">{s.signed < 0 ? `-${money(s.signed)}` : ''}</td>
                <td>{s.label}</td>
                {editable && (
                  <td>
                    {onInsertAfter && <button className="table-action" title="ဤ record ၏နောက်တွင် အသစ်ထည့်ရန်" onClick={() => onInsertAfter(s)}>အောက်ထည့်</button>}
                    <button className="table-action" onClick={() => actions.editBet(s)}>ပြင်</button>
                    <button className="table-action delete" onClick={() => void actions.deleteBet(s)}>ဖျက်</button>
                  </td>
                )}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
