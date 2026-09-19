import type { Band, Market, Outcome, Rule } from './models';

export interface OddsPreset {
  code: string;
  label: string;
  market: Market;
  description?: string;
}

export const BODY_ODDS_PRESETS: OddsPreset[] = [
  { code: '0', label: '0 (ဘောမ / သရေ)', market: 'body', description: 'သရေ ပြန်အမ်း · နိုင် 100% · ရှုံး 100%' },
  { code: '0-50', label: '0-50 (၁၀/၅၀ စား)', market: 'body', description: 'သရေ 50% ရှုံး · နိုင် 100% · ရှုံး 100%' },
  { code: '0+50', label: '0+50', market: 'body', description: 'သရေ 50% မြတ် · နိုင် 100% · ရှုံး 100%' },
  { code: '0.5', label: '0.5 (ခွဲရှုံး / ဒဲ့ခွဲ)', market: 'body', description: 'သရေ ရှုံး 100% · နိုင် 100%' },
  { code: '1-20', label: '1-20', market: 'body', description: '၁ ဂိုးပြတ် 20% ရှုံး · ၂ ဂိုးပြတ် 100% မြတ်' },
  { code: '1-50', label: '1-50', market: 'body', description: '၁ ဂိုးပြတ် 50% ရှုံး · ၂ ဂိုးပြတ် 100% မြတ်' },
  { code: '1-60', label: '1-60', market: 'body', description: '၁ ဂိုးပြတ် 60% ရှုံး · ၂ ဂိုးပြတ် 100% မြတ်' },
  { code: '1-80', label: '1-80', market: 'body', description: '၁ ဂိုးပြတ် 80% ရှုံး · ၂ ဂိုးပြတ် 100% မြတ်' },
  { code: '1+20', label: '1+20', market: 'body', description: '၁ ဂိုးပြတ် 20% မြတ် · ၂ ဂိုးပြတ် 100% မြတ်' },
  { code: '1+50', label: '1+50', market: 'body', description: '၁ ဂိုးပြတ် 50% မြတ် · ၂ ဂိုးပြတ် 100% မြတ်' },
  { code: '1+80', label: '1+80', market: 'body', description: '၁ ဂိုးပြတ် 80% မြတ် · ၂ ဂိုးပြတ် 100% မြတ်' },
  { code: '1.5', label: '1.5 (၁ ပြား ၅၀ / ၁ ခွဲ)', market: 'body', description: '၁ ဂိုးပြတ် ရှုံး 100% · ၂ ဂိုးပြတ် 100% မြတ်' },
  { code: '2-50', label: '2-50', market: 'body', description: '၂ ဂိုးပြတ် 50% ရှုံး · ၃ ဂိုးပြတ် 100% မြတ်' },
  { code: '2+80', label: '2+80', market: 'body', description: '၂ ဂိုးပြတ် 80% မြတ် · ၃ ဂိုးပြတ် 100% မြတ်' },
  { code: '2.5', label: '2.5 (၂ ခွဲ)', market: 'body', description: '၂ ဂိုးပြတ် ရှုံး 100% · ၃ ဂိုးပြတ် 100% မြတ်' },
];

export const TOTAL_ODDS_PRESETS: OddsPreset[] = [
  { code: '1.5', label: '1.5 (၁ ဂိုး ခွဲ)', market: 'total', description: '၁ ဂိုး အောက် · ၂ ဂိုး အထက်' },
  { code: '2-20', label: '2-20', market: 'total', description: '၂ ဂိုး တိတိ 20% ရှုံး' },
  { code: '2-50', label: '2-50', market: 'total', description: '၂ ဂိုး တိတိ 50% ရှုံး' },
  { code: '2-60', label: '2-60', market: 'total', description: '၂ ဂိုး တိတိ 60% ရှုံး' },
  { code: '2-80', label: '2-80', market: 'total', description: '၂ ဂိုး တိတိ 80% ရှုံး' },
  { code: '2+20', label: '2+20', market: 'total', description: '၂ ဂိုး တိတိ 20% မြတ်' },
  { code: '2+50', label: '2+50', market: 'total', description: '၂ ဂိုး တိတိ 50% မြတ်' },
  { code: '2+80', label: '2+80', market: 'total', description: '၂ ဂိုး တိတိ 80% မြတ်' },
  { code: '2.5', label: '2.5 (၂ ဂိုး ခွဲ)', market: 'total', description: '၂ ဂိုး အောက် · ၃ ဂိုး အထက်' },
  { code: '3-20', label: '3-20', market: 'total', description: '၃ ဂိုး တိတိ 20% ရှုံး' },
  { code: '3-50', label: '3-50', market: 'total', description: '၃ ဂိုး တိတိ 50% ရှုံး' },
  { code: '3-60', label: '3-60', market: 'total', description: '၃ ဂိုး တိတိ 60% ရှုံး' },
  { code: '3+20', label: '3+20', market: 'total', description: '၃ ဂိုး တိတိ 20% မြတ်' },
  { code: '3+50', label: '3+50', market: 'total', description: '၃ ဂိုး တိတိ 50% မြတ်' },
  { code: '3.5', label: '3.5 (၃ ဂိုး ခွဲ)', market: 'total', description: '၃ ဂိုး အောက် · ၄ ဂိုး အထက်' },
];

const band = (outcome: Outcome, rate: number): Band => ({
  outcome,
  rate: outcome === 'refund' ? 0 : Math.max(0, Math.min(100, Number(rate) || 0)),
});

/**
 * Parses a Myanmar football odds code (e.g. "1+80", "2-60", "0.5", "0-50", "0")
 * and returns the corresponding line and below/equal/above bands.
 */
export function parseMyanmarOdds(code: string): { line: number; below: Band; equal: Band; above: Band } | null {
  const clean = code.trim();
  if (!clean) return null;

  // 1. Plus odds: e.g. "1+80", "2+50", "0+10"
  const plusMatch = clean.match(/^(\d+(?:\.\d+)?)\s*\+\s*(\d+)$/);
  if (plusMatch) {
    const line = parseFloat(plusMatch[1]);
    const rate = parseInt(plusMatch[2], 10);
    return {
      line,
      below: band('loss', 100),
      equal: band('win', rate),
      above: band('win', 100),
    };
  }

  // 2. Minus odds: e.g. "2-60", "1-20", "0-50"
  const minusMatch = clean.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+)$/);
  if (minusMatch) {
    const line = parseFloat(minusMatch[1]);
    const rate = parseInt(minusMatch[2], 10);
    return {
      line,
      below: band('loss', 100),
      equal: band('loss', rate),
      above: band('win', 100),
    };
  }

  // 3. Level / 0 / ဘောမ / သရေ
  if (/^(?:0|level|ဘောမ|သရေ)$/i.test(clean)) {
    return {
      line: 0,
      below: band('loss', 100),
      equal: band('refund', 0),
      above: band('win', 100),
    };
  }

  // 4. Pure decimal lines: e.g. "0.5", "1.5", "2.5", "3.5" (ခွဲ)
  const decimalMatch = clean.match(/^(\d+\.\d+)$/);
  if (decimalMatch) {
    const line = parseFloat(decimalMatch[1]);
    return {
      line,
      below: band('loss', 100),
      equal: band('refund', 0),
      above: band('win', 100),
    };
  }

  // 5. Pure integer lines: e.g. "1", "2", "3" (သရေပြန်အမ်း)
  const intMatch = clean.match(/^(\d+)$/);
  if (intMatch) {
    const line = parseInt(intMatch[1], 10);
    return {
      line,
      below: band('loss', 100),
      equal: band('refund', 0),
      above: band('win', 100),
    };
  }

  return null;
}

export function formatBandSummary(b: Band): string {
  if (b.outcome === 'refund') return 'ပြန်အမ်း';
  return `${b.outcome === 'win' ? 'မြတ်' : 'ရှုံး'} ${b.rate}%`;
}
