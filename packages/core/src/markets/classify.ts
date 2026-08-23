/**
 * Cheap, deterministic event tagging for headlines and filings — no LLM. A trading agent mostly
 * needs to know *what kind* of catalyst a headline is (earnings, guidance, M&A, FDA, analyst
 * action, insider, dilution, legal, macro…) so it can decide whether to read further. Precision
 * over recall: unknown → `other`.
 */
import type { EventTag } from './types.js';

const RULES: [EventTag, RegExp][] = [
  [
    'earnings',
    /\b(q[1-4]|quarter(ly)?|fiscal|full[- ]year|fy\d{2,4}|first|second|third|fourth)[- ](quarter|year)?\s*(results|earnings|revenue|eps)|\b(reports|posts|announces|releases|delivers)\b.{0,40}\b(results|earnings|revenue|profit|loss|eps|quarter)\b|\brecord (quarter|revenue|earnings|year)\b|\bearnings\s+(call|beat|miss|preview|report|release)\b|\b(beats|misses|tops)\b.{0,30}\b(estimates|expectations|consensus)\b/i,
  ],
  [
    'guidance',
    /\b(guidance|outlook|forecast|raises|lowers|cuts|reaffirms|withdraws)\b.{0,40}\b(guidance|outlook|forecast|fy\d*|full[- ]year)\b|\bpre-?announce/i,
  ],
  [
    // Before M&A: "upgrades X to Buy" must not trip the "to buy" acquisition pattern.
    'analyst',
    /\b(upgrade[sd]?|downgrade[sd]?|price target|pt\b|initiat(es|ed|ion)|overweight|underweight|outperform|underperform|neutral rating|buy rating|sell rating|hold rating|top pick|analysts?)\b/i,
  ],
  [
    'ma',
    /\b(acqui(re|res|red|sition)|merger|merge[sd]?|(agrees?|agreed|deal|bid|offer|offers) to buy|buyout|takeover|take-private|tender offer|definitive agreement|all-cash deal|combination with|spin-?off|divest)/i,
  ],
  [
    'fda',
    /\b(fda|phase\s*(1|2|3|i{1,3}|iib)|pdufa|clinical trial|topline|approval|approves|complete response letter|crl|breakthrough therapy|ema\b|nda|bla)\b/i,
  ],
  [
    'insider',
    /\b(insider|form 4|ceo|cfo|director|officer|10b5-1)\b.{0,40}\b(buys?|bought|sells?|sold|purchase[sd]?|disposed|exercise[sd]?)\b|\b(insider (buying|selling|trade))/i,
  ],
  [
    'offering',
    /\b(offering|secondary|at-the-market|atm program|dilut|convertible notes?|senior notes|shelf registration|s-3|424b|private placement|direct offering|priced|prices? its)\b/i,
  ],
  ['buyback', /\b(buyback|repurchase|share repurchase|authoriz(es|ed) .{0,20}repurchase)/i],
  ['dividend', /\b(dividend|distribution|ex-dividend|special dividend|payout)\b/i],
  [
    'legal',
    /\b(lawsuit|sues?|sued|class action|settlement|settles|investigation|probe|subpoena|doj|sec charges|ftc|antitrust|fine[sd]?|penalty|indict|recall)\b/i,
  ],
  [
    'exec',
    /\b(appoints?|names?|hires?|steps down|resigns?|departure|retires?|new ceo|new cfo|chief executive|chief financial|board of directors|chairman)\b/i,
  ],
  [
    'contract',
    /\b(contract|award(ed)?|order(s)? (from|for)|partnership|partners with|collaboration|agreement with|selected by|wins?)\b/i,
  ],
  [
    'product',
    /\b(launch(es|ed)?|unveils?|introduces?|announces? new|release[sd]?|rollout|expands?|opens?)\b/i,
  ],
  [
    'macro',
    /\b(fed|fomc|federal reserve|powell|rate (cut|hike|decision)|interest rates?|cpi|inflation|ppi|payrolls|jobs report|nonfarm|unemployment|gdp|treasury yields?|tariffs?|ecb|boj|pmi|ism|retail sales|consumer (confidence|sentiment)|housing starts)\b/i,
  ],
];

export function classifyEvent(title: string, summary?: string): EventTag {
  const t = title ?? '';
  for (const [tag, re] of RULES) if (re.test(t)) return tag;
  if (summary) {
    const s = summary.slice(0, 400);
    for (const [tag, re] of RULES.slice(0, 8)) if (re.test(s)) return tag;
  }
  return 'other';
}

/** 8-K item codes → short labels (Regulation S-K / Form 8-K instructions). */
export const FORM_8K_ITEMS: Record<string, string> = {
  '1.01': 'Entry into a Material Agreement',
  '1.02': 'Termination of a Material Agreement',
  '1.03': 'Bankruptcy or Receivership',
  '1.04': 'Mine Safety',
  '1.05': 'Material Cybersecurity Incident',
  '2.01': 'Completion of Acquisition or Disposition',
  '2.02': 'Results of Operations and Financial Condition',
  '2.03': 'Creation of a Direct Financial Obligation',
  '2.04': 'Triggering Events (Acceleration of Obligation)',
  '2.05': 'Costs Associated with Exit or Disposal Activities',
  '2.06': 'Material Impairments',
  '3.01': 'Notice of Delisting / Listing Standard Failure',
  '3.02': 'Unregistered Sales of Equity Securities',
  '3.03': 'Material Modification to Rights of Security Holders',
  '4.01': 'Changes in Registrant’s Certifying Accountant',
  '4.02': 'Non-Reliance on Previously Issued Financials (restatement)',
  '5.01': 'Changes in Control of Registrant',
  '5.02': 'Departure/Election of Directors or Officers; Compensation',
  '5.03': 'Amendments to Articles/Bylaws; Fiscal Year Change',
  '5.04': 'Temporary Suspension of Trading Under Benefit Plans',
  '5.05': 'Amendments to Code of Ethics',
  '5.06': 'Change in Shell Company Status',
  '5.07': 'Submission of Matters to a Vote of Security Holders',
  '5.08': 'Shareholder Director Nominations',
  '6.01': 'ABS Informational and Computational Material',
  '6.02': 'Change of Servicer or Trustee',
  '6.03': 'Change in Credit Enhancement',
  '6.04': 'Failure to Make a Required Distribution',
  '6.05': 'Securities Act Updating Disclosure',
  '7.01': 'Regulation FD Disclosure',
  '8.01': 'Other Events',
  '9.01': 'Financial Statements and Exhibits',
};

export function labelItems(items: string[] | undefined): string[] {
  return (items ?? []).map((i) => `${i} ${FORM_8K_ITEMS[i] ?? ''}`.trim());
}

/** Event tag for a filing from its form type and (for 8-K) item codes. */
export function classifyFiling(form: string, items: string[] = []): EventTag {
  const f = form.toUpperCase().replace(/\/A$/, '');
  if (f === '8-K' || f === '6-K') {
    if (items.includes('2.02')) return 'earnings';
    if (items.includes('1.01') || items.includes('2.01')) return 'ma';
    if (items.includes('5.02')) return 'exec';
    if (items.includes('3.02') || items.includes('2.03')) return 'offering';
    if (['4.02', '1.03', '3.01', '1.05'].some((i) => items.includes(i))) return 'legal';
    return 'other';
  }
  if (f === '4' || f === '3' || f === '5' || f === '144') return 'insider';
  if (f === '10-Q' || f === '10-K' || f === '20-F' || f === '40-F') return 'earnings';
  if (/^(S-1|S-3|S-4|S-8|F-1|F-3|424B\d?|D|D\/A)$/.test(f)) return 'offering';
  if (/^(SC 13D|SC 13G|13F-HR|SC TO|SC 14D9)/.test(f)) return 'ma';
  if (f === 'DEF 14A' || f === 'DEFA14A' || f === 'PRE 14A') return 'exec';
  if (f === 'NT 10-K' || f === 'NT 10-Q') return 'legal';
  return 'other';
}
