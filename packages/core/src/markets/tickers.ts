/**
 * Ticker directory (SEC `company_tickers_exchange.json`, refreshed daily) + cheap ticker/company
 * recognition in headlines: cashtags (`$AAPL`), exchange patterns (`(NASDAQ: AAPL)`, `NYSE:F`),
 * and company-name aliases ("Apple Inc." → "apple") used to filter feeds down to the symbols an
 * agent cares about. Bare tickers are matched case-sensitively so word-tickers (NOW, ALL, CAT,
 * LOW…) do not light up on ordinary prose.
 */
import type { MarketsClient } from './client.js';
import { marketSource, sourceUrl } from './sources.js';
import type { TickerRecord } from './types.js';
import { escapeRegExp, padCik } from './util.js';

interface SecTickersFile {
  fields: string[];
  data: (string | number | null)[][];
}

const SUFFIX_RE =
  /\b(incorporated|inc|corporation|corp|company|co|ltd|limited|plc|llc|lp|l\.p|holdings?|group|trust|fund|n\.v|s\.a|ag|se|nv|sa|the)\b\.?/gi;

/** "Apple Inc." → "apple"; "Alphabet Inc. Class A" → "alphabet". */
export function companyAlias(name: string): string {
  return name
    .toLowerCase()
    .replace(/[,.()'’]/g, ' ')
    .replace(/\b(class|series)\s+[a-z]\b/g, ' ')
    .replace(/\bcommon stock\b|\bordinary shares?\b|\bdepositary\b|\bads\b|\badr\b/g, ' ')
    .replace(SUFFIX_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class TickerDirectory {
  private byTicker = new Map<string, TickerRecord>();
  private loading?: Promise<void>;

  constructor(private readonly client: MarketsClient) {}

  /**
   * Load (or reuse) the SEC map. A failed or aborted load is not latched: the next call retries,
   * so a one-off 403 (contact not configured yet) or a cancelled first call cannot empty the
   * directory for the rest of the process.
   */
  load(signal?: AbortSignal): Promise<void> {
    if (!this.loading) {
      const src = marketSource('sec-tickers');
      this.loading = this.client
        .fetchJson<SecTickersFile>(src, sourceUrl(src), { signal })
        .then(({ data }) => this.ingest(data))
        .catch((err) => {
          this.loading = undefined;
          this.client.opts.logger?.debug(
            `markets: ticker directory unavailable (${(err as Error).message})`,
          );
        });
    }
    return this.loading;
  }

  /** Load from a pre-parsed file (tests / custom directories). */
  ingest(file: SecTickersFile): void {
    const f = file.fields.map(String);
    const iCik = f.indexOf('cik');
    const iName = f.indexOf('name');
    const iTicker = f.indexOf('ticker');
    const iEx = f.indexOf('exchange');
    for (const row of file.data ?? []) {
      const ticker = String(row[iTicker] ?? '').toUpperCase();
      if (!ticker) continue;
      this.byTicker.set(ticker, {
        ticker,
        cik: padCik(String(row[iCik] ?? '')),
        name: String(row[iName] ?? ''),
        exchange: row[iEx] ? String(row[iEx]) : undefined,
      });
    }
    this.loading ??= Promise.resolve();
  }

  lookup(symbol: string): TickerRecord | undefined {
    const s = normalizeSymbol(symbol);
    return this.byTicker.get(s) ?? this.byTicker.get(s.replace('.', '-'));
  }

  /** Short company alias for a symbol ("apple"), undefined when unknown or identical to the ticker. */
  alias(symbol: string): string | undefined {
    const rec = this.lookup(symbol);
    if (!rec) return undefined;
    const a = companyAlias(rec.name);
    return a && a !== normalizeSymbol(symbol).toLowerCase() ? a : undefined;
  }
}

/** `brk.b` → `BRK.B`, `$aapl` → `AAPL`. */
export function normalizeSymbol(symbol: string): string {
  return symbol.trim().replace(/^\$/, '').toUpperCase();
}

const CASHTAG_RE = /\$([A-Z]{1,5}(?:\.[A-Z])?)\b/g;
const EXCHANGE_RE =
  /\b(?:NASDAQ|NYSE(?: American| Arca)?|AMEX|OTC(?:QB|QX)?|TSXV?|LSE|CBOE)\s*:\s*([A-Z]{1,5}(?:\.[A-Z])?)\b/g;

/** Tickers explicitly mentioned in text (cashtags and exchange-prefixed symbols), unique. */
export function extractTickers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(CASHTAG_RE)) out.add(m[1] as string);
  for (const m of text.matchAll(EXCHANGE_RE)) out.add(m[1] as string);
  return [...out];
}

/**
 * Compiled mention test for one symbol: cashtag / exchange form, the bare upper-case ticker
 * (≥ 3 letters, whole word, case-sensitive), or the company alias as a whole phrase
 * (case-insensitive, ≥ 4 chars).
 */
export function mentionMatcher(symbol: string, alias?: string): (text: string) => boolean {
  const s = normalizeSymbol(symbol);
  const sym = escapeRegExp(s);
  const tagged = new RegExp(`\\$${sym}\\b|(?:NASDAQ|NYSE|AMEX|OTC)[A-Za-z ]*:\\s*${sym}\\b`);
  const bare = s.length >= 3 ? new RegExp(`(^|[^A-Za-z0-9$.])${sym}(?![A-Za-z0-9])`) : undefined;
  const name =
    alias && alias.length >= 4
      ? new RegExp(`(^|[^a-z0-9])${escapeRegExp(alias)}(?![a-z0-9])`, 'i')
      : undefined;
  return (text) => tagged.test(text) || !!bare?.test(text) || !!name?.test(text);
}

/** One-off mention test (see `mentionMatcher`). */
export function mentions(text: string, symbol: string, alias?: string): boolean {
  return mentionMatcher(symbol, alias)(text);
}
