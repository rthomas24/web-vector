/**
 * SEC EDGAR: filing history per company (`data.sec.gov/submissions`) and full-text search
 * across filings (`efts.sec.gov`). Both are open, keyless APIs under the SEC fair-access policy
 * (declared User-Agent, ≤10 req/s — the client declares and the fetcher paces). Every filing comes
 * back with its primary-document URL on www.sec.gov/Archives (robots-allowed), so the agent can
 * read the 8-K or exhibit with the normal fetch tool.
 */
import { WebVectorError } from '../errors.js';
import { cleanField } from '../ingest/parsers.js';
import { qs } from '../util/http.js';
import { classifyFiling, labelItems } from './classify.js';
import type { MarketsClient } from './client.js';
import { marketSource } from './sources.js';
import { normalizeSymbol, type TickerDirectory } from './tickers.js';
import type { Filing, FilingHit, FilingsResult } from './types.js';
import { clampLimit, isoDay, padCik } from './util.js';

export interface FilingsOptions {
  symbol?: string;
  cik?: string | number;
  /** Form types to keep (case-insensitive; `8-K` also matches `8-K/A`). Default: all. */
  forms?: string[];
  /** Look-back in days (default 90). */
  days?: number;
  limit?: number;
  signal?: AbortSignal;
  now?: number;
}

export interface FilingSearchOptions {
  query: string;
  forms?: string[];
  /** Restrict to one company (symbol → CIK). */
  symbol?: string;
  days?: number;
  limit?: number;
  signal?: AbortSignal;
  now?: number;
}

interface Submissions {
  cik: string;
  name: string;
  tickers?: string[];
  exchanges?: string[];
  sic?: string;
  sicDescription?: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      reportDate: string[];
      acceptanceDateTime: string[];
      form: string[];
      items: string[];
      primaryDocument: string[];
      primaryDocDescription: string[];
      size: number[];
    };
  };
}

interface EftsResponse {
  hits: {
    total: { value: number };
    hits: {
      _id: string;
      _score?: number;
      _source: {
        ciks?: string[];
        display_names?: string[];
        form?: string;
        root_forms?: string[];
        file_date?: string;
        adsh?: string;
        items?: string[];
        file_type?: string;
        file_description?: string;
        period_ending?: string;
      };
    }[];
  };
}

const ARCHIVE = 'https://www.sec.gov/Archives/edgar/data';

export function filingUrls(cik: string | number, accession: string, primaryDocument?: string) {
  const folder = `${ARCHIVE}/${Number(padCik(cik))}/${accession.replace(/-/g, '')}`;
  return {
    url: primaryDocument ? `${folder}/${primaryDocument}` : `${folder}/${accession}-index.htm`,
    indexUrl: `${folder}/${accession}-index.htm`,
  };
}

/** `8-K` matches `8-K` and `8-K/A`; comparison is case-insensitive. */
function formFilter(forms?: string[]): (form: string) => boolean {
  if (!forms?.length) return () => true;
  const wanted = new Set(forms.map((f) => f.toUpperCase().trim()));
  return (form) => {
    const f = form.toUpperCase();
    return wanted.has(f) || wanted.has(f.replace(/\/A$/, ''));
  };
}

async function cikFor(dir: TickerDirectory, symbol: string, signal?: AbortSignal): Promise<string> {
  const ticker = normalizeSymbol(symbol);
  await dir.load(signal);
  const rec = dir.lookup(ticker);
  if (!rec)
    throw new WebVectorError(`Unknown ticker ${ticker} (not in the SEC ticker map).`, {
      code: 'PROVIDER_ERROR',
      provider: 'sec-submissions',
      stage: 'search',
      retryable: false,
      remediation:
        'Check the symbol (US-listed equities only; class shares use a dot, e.g. BRK.B) or pass the CIK.',
    });
  return rec.cik;
}

export async function getFilings(
  client: MarketsClient,
  dir: TickerDirectory,
  opts: FilingsOptions,
): Promise<FilingsResult> {
  const now = opts.now ?? Date.now();
  const cik =
    opts.cik !== undefined
      ? padCik(opts.cik)
      : opts.symbol
        ? await cikFor(dir, opts.symbol, opts.signal)
        : undefined;
  if (!cik)
    throw new WebVectorError('getFilings needs a symbol or a CIK', {
      code: 'INVALID_CONFIG',
      stage: 'search',
      retryable: false,
    });
  const src = marketSource('sec-submissions');
  const { data, fromCache } = await client.fetchJson<Submissions>(
    src,
    `https://data.sec.gov/submissions/CIK${cik}.json`,
    { signal: opts.signal },
  );
  const r = data.filings?.recent;
  const since = isoDay(now - (opts.days ?? 90) * 86_400_000);
  const limit = clampLimit(opts.limit, 10);
  const keep = formFilter(opts.forms);
  const ticker = opts.symbol ? normalizeSymbol(opts.symbol) : data.tickers?.[0];
  const filings: Filing[] = [];
  for (let i = 0; i < (r?.form?.length ?? 0) && filings.length < limit; i++) {
    const form = r.form[i] as string;
    const filedAt = r.filingDate[i] as string;
    if (filedAt < since) break; // recent[] is newest-first
    if (!keep(form)) continue;
    const accession = r.accessionNumber[i] as string;
    const items = (r.items[i] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    filings.push({
      form,
      filedAt,
      reportDate: r.reportDate[i] || undefined,
      acceptedAt: r.acceptanceDateTime[i] || undefined,
      accession,
      ...filingUrls(cik, accession, r.primaryDocument[i]),
      description: cleanField(r.primaryDocDescription[i], 200),
      items: items.length ? items : undefined,
      itemLabels: items.length ? labelItems(items) : undefined,
      size: r.size[i],
      company: cleanField(data.name, 200) ?? '',
      cik,
      ticker,
      event: classifyFiling(form, items),
    });
  }
  return {
    company: {
      name: cleanField(data.name, 200) ?? '',
      cik,
      tickers: data.tickers ?? [],
      exchanges: data.exchanges ?? [],
      sic: data.sicDescription ? `${data.sic} ${data.sicDescription}` : data.sic,
    },
    filings,
    source: src.id,
    fetchedAt: new Date(now).toISOString(),
    fromCache,
  };
}

export async function searchFilings(
  client: MarketsClient,
  dir: TickerDirectory,
  opts: FilingSearchOptions,
): Promise<FilingsResult> {
  const now = opts.now ?? Date.now();
  const limit = clampLimit(opts.limit, 10);
  let ciks: string | undefined;
  if (opts.symbol) {
    await dir.load(opts.signal);
    ciks = dir.lookup(normalizeSymbol(opts.symbol))?.cik;
  }
  const src = marketSource('sec-fulltext');
  const url = `https://efts.sec.gov/LATEST/search-index${qs({
    q: opts.query.trim(),
    forms: opts.forms?.map((f) => f.toUpperCase()).join(','),
    dateRange: 'custom',
    startdt: isoDay(now - (opts.days ?? 30) * 86_400_000),
    enddt: isoDay(now),
    ciks,
  })}`;
  const { data, fromCache } = await client.fetchJson<EftsResponse>(src, url, {
    signal: opts.signal,
  });
  const filings: FilingHit[] = [];
  for (const h of data.hits?.hits ?? []) {
    if (filings.length >= limit) break;
    const s = h._source ?? {};
    const colon = h._id.indexOf(':');
    const adsh = s.adsh ?? (colon >= 0 ? h._id.slice(0, colon) : h._id);
    const docId = colon >= 0 ? h._id.slice(colon + 1) : undefined;
    const cik = padCik(s.ciks?.[0] ?? ciks ?? '0');
    // "Apple Inc.  (AAPL)  (CIK 0000320193)"
    const display = (cleanField(s.display_names?.[0], 200) ?? '')
      .replace(/\s+\(CIK \d+\)\s*$/, '')
      .trim();
    const tickerMatch = /\(([A-Z.-]{1,6})\)\s*$/.exec(display);
    const form = s.root_forms?.[0] ?? s.form ?? '';
    const items = s.items ?? [];
    filings.push({
      form,
      filedAt: s.file_date ?? '',
      reportDate: s.period_ending || undefined,
      accession: adsh,
      ...filingUrls(cik, adsh, docId),
      description: cleanField(s.file_description || s.file_type, 200),
      items: items.length ? items : undefined,
      itemLabels: items.length ? labelItems(items) : undefined,
      company: display.replace(/\s+\([A-Z.-]{1,6}\)\s*$/, ''),
      cik,
      ticker: tickerMatch?.[1],
      event: classifyFiling(form, items),
      docId,
      score: h._score,
    });
  }
  return {
    query: opts.query,
    filings,
    total: data.hits?.total?.value,
    source: src.id,
    fetchedAt: new Date(now).toISOString(),
    fromCache,
  };
}
