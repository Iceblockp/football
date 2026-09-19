export type Market = 'body' | 'total';
export type Selection = 'home' | 'away' | 'up' | 'down';
export type Outcome = 'win' | 'loss' | 'refund';

export interface Band { outcome: Outcome; rate: number }
export interface Rule {
  id: string; code: string; market: Market; line: number;
  below: Band; equal: Band; above: Band;
  status?: 'active' | 'closed'; effectiveAt?: string; closedAt?: string;
  /** Default placeholder rule while the bookmaker's actual odds are unavailable. */
  provisional?: boolean;
}
export interface Match {
  id: string; date: string; time: string; home: string; away: string;
  homeScore: number | null; awayScore: number | null; postponed: boolean; rules: Rule[];
}
export interface Bet {
  id: string; date: string; matchId: string; ruleId: string; selection: Selection;
  note: string; amount: number;
  /** Immutable rule used at acceptance time, so later odds changes cannot rewrite history. */
  ruleSnapshot?: Rule; placedAt?: string; lateEntry?: boolean; lateReason?: string;
}
export interface Store { matches: Match[]; bets: Bet[]; settings: { winDeduction: number; commission: number } }
export interface Settlement {
  bet: Bet; match: Match; rule: Rule; band: Band; signed: number; label: string;
}
export interface DesktopApi {
  data: { load: () => Promise<Store>; save: (store: Store) => Promise<void>; exportCsv: (rows: string[][]) => Promise<boolean>; exportPdf: (title: string, html: string) => Promise<boolean> };
}
