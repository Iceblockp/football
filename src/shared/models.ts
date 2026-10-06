export type Market = 'body' | 'total';
export type Selection = 'home' | 'away' | 'up' | 'down';
export type BodyBaseSide = 'home' | 'away';
export type Outcome = 'win' | 'loss' | 'refund';
export type ViewMode = 'dai' | 'player';
export type Bookmaker = 'viber' | 'messenger';
export type AppearanceTheme = 'light' | 'dark';

export interface BookmakerSettings {
  mode: 'direct' | 'summary';
  /** Direct mode: percentage removed from a player's winning amount. */
  playerWinDeduction: number;
  /** Direct mode: percentage returned against a player's losing amount. */
  playerLossRebate: number;
  /** Summary mode: percentage removed from gross player wins. */
  winTaxRate: number;
  /** Summary mode: percentage of gross win + absolute gross loss credited to the player. */
  turnoverCommissionRate: number;
}

export interface Team { id: string; name: string; code: string }

export interface Band { outcome: Outcome; rate: number }
export interface Rule {
  id: string; code: string; market: Market; line: number;
  below: Band; equal: Band; above: Band;
  /** Team whose goal difference the Body rule code is quoted from. Old rules default to home. */
  bodyBaseSide?: BodyBaseSide;
  status?: 'active' | 'closed'; effectiveAt?: string; closedAt?: string;
  /** Default placeholder rule while the bookmaker's actual odds are unavailable. */
  provisional?: boolean;
}
export interface Match {
  id: string; date: string; bookmaker: Bookmaker; time: string; home: string; away: string;
  homeScore: number | null; awayScore: number | null; postponed: boolean; rules: Rule[];
  /** Real kickoff instant. `date` remains the business/report date. */
  kickoffAt?: string;
  apiFixtureId?: number;
  apiHome?: string;
  apiAway?: string;
  /** True when API away maps to the local left/home team. */
  apiSidesReversed?: boolean;
  apiStatus?: string;
  apiLeague?: string;
  resultSource?: 'manual' | 'api-football';
  resultCheckedAt?: string;
}
export interface Bet {
  id: string; date: string; bookmaker: Bookmaker; matchId: string; ruleId: string; selection: Selection;
  note: string; amount: number;
  /** Display order inside one day's ledger. This is independent of the immutable bet ID. */
  sortOrder?: number;
  /** Immutable rule used at acceptance time, so later odds changes cannot rewrite history. */
  ruleSnapshot?: Rule; placedAt?: string; lateEntry?: boolean; lateReason?: string;
}
export interface Store {
  teams: Team[];
  matches: Match[];
  bets: Bet[];
  settings: {
    view: ViewMode;
    theme: AppearanceTheme;
    bookmakerSettings: Record<Bookmaker, BookmakerSettings>;
    automation: {
      enabled: boolean;
      pollMinutes: number;
      windowStart: string;
      windowEnd: string;
      autoExportPdf: boolean;
      exportedReports: string[];
    };
    viberDelivery: {
      groupName: string;
      autoSend: boolean;
      sentReports: string[];
      pendingReports: string[];
      lastStatus: 'idle' | 'sent' | 'failed';
      lastMessage: string;
      lastSentAt?: string;
    };
  };
}
export interface Settlement {
  bet: Bet; match: Match; rule: Rule; band: Band; signed: number; label: string;
}
export interface ApiFixture {
  id: number;
  kickoffAt: string;
  home: string;
  away: string;
  league: string;
  status: string;
  elapsed: number | null;
  homeScore: number | null;
  awayScore: number | null;
  fullTimeHome: number | null;
  fullTimeAway: number | null;
}
export interface DesktopApi {
  data: { load: () => Promise<Store>; save: (store: Store) => Promise<void>; exportCsv: (rows: string[][]) => Promise<boolean>; exportPdf: (title: string, html: string) => Promise<boolean>; exportPdfAuto: (title: string, html: string) => Promise<string> };
  apiFootball: {
    hasKey: () => Promise<boolean>;
    saveKey: (key: string) => Promise<boolean>;
    test: () => Promise<{ ok: boolean; message: string }>;
    fixturesByDate: (date: string) => Promise<ApiFixture[]>;
  };
  viber: {
    selectGroup: (groupName: string) => Promise<{ ok: boolean; message: string }>;
    sendFile: (groupName: string, filePath: string) => Promise<{ ok: boolean; message: string }>;
  };
}
