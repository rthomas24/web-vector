/**
 * Markets module — fully offline: a fake `fetch` serves feed/JSON/CSV fixtures by URL; the
 * WebVector instance runs with robots off (fixtures, not the live policy) and no DNS guard.
 */
import { describe, expect, it } from 'vitest';
import { ToolGuard, WebVector, type WebVectorConfig } from '../src/index.js';
import {
  capMarkdown,
  classifyEvent,
  classifyFiling,
  dedupeNews,
  extractTickers,
  finraShortRow,
  hamming,
  mentions,
  parseFeed,
  parseFfCalendar,
  parseFredCsv,
  parseVixCsv,
  parseYahooChart,
  renderCalendar,
  renderFilings,
  renderNews,
  renderPulse,
  renderSentiment,
  simhash64,
  storyKey,
  summarizeStocktwits,
  titleTokens,
  UNTRUSTED_NOTE,
} from '../src/markets/index.js';
import type { NewsItem } from '../src/markets/types.js';

const NOW = Date.parse('2026-08-22T18:00:00Z');
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toUTCString();

const rss = (
  items: {
    title: string;
    link: string;
    date?: string;
    desc?: string;
    cats?: string[];
    src?: string;
  }[],
  title = 'Feed',
) =>
  `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:News="https://www.bing.com/news/search?q=x&amp;format=rss"><channel><title>${title}</title><link>https://feed.example/</link>${items
    .map(
      (i) =>
        `<item><title><![CDATA[${i.title}]]></title><link>${i.link}</link>${i.date ? `<pubDate>${i.date}</pubDate>` : ''}${
          i.desc ? `<description><![CDATA[${i.desc}]]></description>` : ''
        }${(i.cats ?? []).map((c) => `<category>${c}</category>`).join('')}${i.src ? `<News:Source>${i.src}</News:Source>` : ''}</item>`,
    )
    .join('')}</channel></rss>`;

const YAHOO = rss(
  [
    {
      title: 'Apple Reports Third Quarter Results',
      link: 'https://finance.yahoo.com/news/apple-q3.html',
      date: iso(2),
      desc: 'Apple Inc. (NASDAQ:AAPL) posted revenue of $94B.',
    },
    {
      title: 'Analyst upgrades Apple to Buy, raises price target',
      link: 'https://finance.yahoo.com/news/aapl-upgrade.html',
      date: iso(5),
    },
    {
      title: 'Why I Think the Best Dividend Stock Is Realty Income',
      link: 'https://www.fool.com/realty.html',
      date: iso(1),
      desc: 'Realty Income checks all the boxes.',
    },
    { title: 'Old Apple story', link: 'https://finance.yahoo.com/news/old.html', date: iso(80) },
  ],
  'Yahoo! Finance: AAPL News',
);
const SA = rss(
  [
    {
      title: 'Apple reports third quarter results',
      link: 'https://seekingalpha.com/news/apple-q3',
      date: iso(2.5),
    },
  ],
  'Apple Inc. - Seeking Alpha',
);
// Bing links are apiclick redirectors; two different stories must stay distinct.
const BING = rss(
  [
    {
      title: 'Apple unveils new iPhone lineup',
      link: 'http://www.bing.com/news/apiclick.aspx?ref=FexRss&aid=&tid=1&url=https%3a%2f%2ftechsite.example%2fiphone&c=1&mkt=en-us',
      date: iso(1),
      src: 'TechSite',
    },
    {
      title: 'Apple hit with new EU fine - live updates',
      link: 'http://www.bing.com/news/apiclick.aspx?ref=FexRss&aid=&tid=2&url=https%3a%2f%2fnews.example%2fapple-fine&c=2&mkt=en-us',
      date: iso(1.5),
      src: 'NewsSite',
    },
  ],
  'Apple AAPL - BingNews',
);
const GNW = rss(
  [
    {
      title: 'Apple Inc. Announces Quarterly Dividend',
      link: 'https://www.globenewswire.com/news-release/aapl-div',
      date: iso(3),
      desc: '(NASDAQ: AAPL) declared a dividend.',
    },
    {
      title: 'Acme Widgets Completes Acquisition of Foo',
      link: 'https://www.globenewswire.com/news-release/acme',
      date: iso(1),
      desc: '(NYSE: ACME)',
    },
  ],
  'GlobeNewswire',
);
const CNBC = rss(
  [
    {
      title: 'Fed officials signal caution on rate cuts',
      link: 'https://www.cnbc.com/fed.html',
      date: iso(0.5),
    },
    {
      title: 'Apple supplier warns of memory shortage',
      link: 'https://www.cnbc.com/apple-supplier.html',
      date: iso(4),
      desc: 'Shares of Apple fell.',
    },
    {
      title: 'Everything is on sale now, all of it',
      link: 'https://www.cnbc.com/sale.html',
      date: iso(0.2),
    },
  ],
  'CNBC',
);
const GOOGLE = rss(
  [
    {
      title: 'Apple faces antitrust probe in EU - Reuters',
      link: 'https://news.google.com/rss/articles/CBMiabc',
      date: iso(6),
      desc: '<a href="x">Apple faces antitrust probe in EU</a>&nbsp;&nbsp;<font color="#6f6f6f">Reuters</font>',
    },
  ],
  'Google News',
);
const EMPTY = rss([], 'Empty');

const TICKERS = JSON.stringify({
  fields: ['cik', 'name', 'ticker', 'exchange'],
  data: [
    [320193, 'Apple Inc.', 'AAPL', 'Nasdaq'],
    [1318605, 'Tesla, Inc.', 'TSLA', 'Nasdaq'],
    [1, 'ServiceNow, Inc.', 'NOW', 'NYSE'],
    [2, 'Allstate Corp', 'ALL', 'NYSE'],
  ],
});
const SUBMISSIONS = JSON.stringify({
  cik: '320193',
  name: 'Apple Inc.',
  tickers: ['AAPL'],
  exchanges: ['Nasdaq'],
  sic: '3571',
  sicDescription: 'Electronic Computers',
  filings: {
    recent: {
      accessionNumber: ['0001140361-26-033928', '0000320193-26-000018', '0000320193-25-000001'],
      filingDate: ['2026-08-20', '2026-07-30', '2025-01-05'],
      reportDate: ['2026-08-18', '2026-06-27', '2024-12-28'],
      acceptanceDateTime: [
        '2026-08-20T18:30:00.000Z',
        '2026-07-30T20:31:00.000Z',
        '2025-01-05T10:00:00.000Z',
      ],
      form: ['4', '8-K', '10-Q'],
      items: ['', '2.02,9.01', ''],
      primaryDocument: ['xslF345X06/form4.xml', 'a8-k20260730.htm', 'aapl-20241228.htm'],
      primaryDocDescription: ['FORM 4', '8-K', '10-Q'],
      size: [10000, 20000, 30000],
    },
  },
});
const EFTS = JSON.stringify({
  hits: {
    total: { value: 1 },
    hits: [
      {
        _id: '0000320193-26-000018:a8-kex991q3202606272026.htm',
        _score: 8.2,
        _source: {
          ciks: ['0000320193'],
          display_names: ['Apple Inc.  (AAPL)  (CIK 0000320193)'],
          form: '8-K',
          root_forms: ['8-K'],
          file_date: '2026-07-30',
          adsh: '0000320193-26-000018',
          items: ['2.02', '9.01'],
          file_type: 'EX-99.1',
          file_description: 'EX-99.1',
          period_ending: '2026-07-30',
        },
      },
    ],
  },
});
const FF = JSON.stringify([
  {
    title: 'CPI m/m',
    country: 'USD',
    date: new Date(NOW + 40 * 3_600_000).toISOString(),
    impact: 'High',
    forecast: '0.2%',
    previous: '0.3%',
  },
  {
    title: 'Unemployment Claims',
    country: 'USD',
    date: new Date(NOW + 60 * 3_600_000).toISOString(),
    impact: 'Medium',
    forecast: '230K',
    previous: '228K',
  },
  {
    title: 'Some Low Thing',
    country: 'USD',
    date: new Date(NOW + 10 * 3_600_000).toISOString(),
    impact: 'Low',
  },
  {
    title: 'ECB Rate',
    country: 'EUR',
    date: new Date(NOW + 20 * 3_600_000).toISOString(),
    impact: 'High',
  },
  {
    title: 'Retail Sales m/m',
    country: 'USD',
    date: new Date(NOW - 5 * 3_600_000).toISOString(),
    impact: 'High',
    actual: '0.5%',
    forecast: '0.3%',
  },
  {
    title: 'Far away',
    country: 'USD',
    date: new Date(NOW + 20 * 86_400_000).toISOString(),
    impact: 'High',
  },
]);
const FF_NEXT = JSON.stringify([
  {
    title: 'NFP',
    country: 'USD',
    date: new Date(NOW + 6 * 86_400_000).toISOString(),
    impact: 'High',
    forecast: '150K',
  },
]);
const STOCKTWITS = JSON.stringify({
  symbol: { symbol: 'AAPL', title: 'Apple Inc', watchlist_count: 989908 },
  messages: [
    {
      id: 1,
      body: '$AAPL to the moon',
      created_at: new Date(NOW - 60_000).toISOString(),
      user: { username: 'a' },
      entities: { sentiment: { basic: 'Bullish' } },
      likes: { total: 5 },
    },
    {
      id: 2,
      body: '$AAPL overbought, fading',
      created_at: new Date(NOW - 30 * 60_000).toISOString(),
      user: { username: 'b' },
      entities: { sentiment: { basic: 'Bearish' } },
      likes: { total: 9 },
    },
    {
      id: 3,
      body: '$AAPL hmm',
      created_at: new Date(NOW - 50 * 60_000).toISOString(),
      entities: { sentiment: null },
    },
    {
      id: 4,
      body: '$AAPL bullish here',
      created_at: new Date(NOW - 55 * 60_000).toISOString(),
      entities: { sentiment: { basic: 'Bullish' } },
    },
  ],
});
const FINRA =
  'Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n20260821|A|509558|0|997736|B,Q,N\n20260821|AAPL|25000000|1000|60000000|B,Q,N\n20260821|AAPLX|1|0|2|Q\n';
const VIX =
  'DATE,OPEN,HIGH,LOW,CLOSE\n08/19/2026,14,15,14,14.5\n08/20/2026,15.1,16.2,15.0,15.9\n08/21/2026,16.0,17.5,15.8,17.2\n';
const FRED = (id: string, a: string, b: string) =>
  `observation_date,${id}\n2026-08-19,${a}\n2026-08-20,.\n2026-08-21,${b}\n`;
const YCHART = (symbol: string, price: number, prev: number) =>
  JSON.stringify({
    chart: {
      result: [
        {
          meta: {
            symbol,
            shortName: symbol,
            regularMarketPrice: price,
            chartPreviousClose: prev,
            regularMarketDayHigh: 0,
            regularMarketDayLow: 0,
            regularMarketTime: Math.floor(NOW / 1000),
            currency: 'USD',
          },
        },
      ],
    },
  });

const ROUTES: [RegExp, string, string][] = [
  [/feeds\.finance\.yahoo\.com\/rss\/2\.0\/headline\?s=AAPL/, 'application/xml', YAHOO],
  [/seekingalpha\.com\/api\/sa\/combined\/AAPL\.xml/, 'application/xml', SA],
  [/bing\.com\/news\/search\?q=.*format=rss/, 'application/xml', BING],
  [/news\.google\.com\/rss\/search/, 'application/xml', GOOGLE],
  [/globenewswire\.com\/RssFeed/, 'application/rss+xml', GNW],
  [/cnbc\.com\/id\/100003114/, 'application/xml', CNBC],
  [
    /feeds\.content\.dowjones\.io|benzinga\.com\/feed|prnewswire\.com\/rss|federalreserve\.gov\/feeds/,
    'application/xml',
    EMPTY,
  ],
  [/sec\.gov\/files\/company_tickers_exchange\.json/, 'application/json', TICKERS],
  [/data\.sec\.gov\/submissions\/CIK0000320193\.json/, 'application/json', SUBMISSIONS],
  [/efts\.sec\.gov\/LATEST\/search-index/, 'application/json', EFTS],
  [/nfs\.faireconomy\.media\/ff_calendar_thisweek\.json/, 'application/json', FF],
  [/nfs\.faireconomy\.media\/ff_calendar_nextweek\.json/, 'application/json', FF_NEXT],
  [/api\.stocktwits\.com\/api\/2\/streams\/symbol\/AAPL\.json/, 'application/json', STOCKTWITS],
  [/cdn\.finra\.org\/equity\/regsho\/daily\/CNMSshvol20260821\.txt/, 'text/plain', FINRA],
  [/cdn\.cboe\.com\/.*VIX_History\.csv/, 'text/csv', VIX],
  [/fredgraph\.csv\?id=DGS10/, 'application/csv', FRED('DGS10', '4.63', '4.70')],
  [/fredgraph\.csv\?id=DGS2/, 'application/csv', FRED('DGS2', '3.90', '3.95')],
  [/fredgraph\.csv\?id=DFF/, 'application/csv', FRED('DFF', '4.33', '4.33')],
  [
    /query2\.finance\.yahoo\.com\/v8\/finance\/chart\/SPY/,
    'application/json',
    YCHART('SPY', 765.72, 776.34),
  ],
];

const requests: string[] = [];
let secDown = false;
function stubFetch(): typeof fetch {
  return async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : (input.url ?? String(input));
    requests.push(url);
    const headers = new Headers(init?.headers ?? {});
    if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
    if (/data\.sec\.gov|efts\.sec\.gov|www\.sec\.gov/.test(url)) {
      const ua = headers.get('user-agent') ?? '';
      if (secDown || !/^WebVector\/\S+ \(.+@.+\)$/.test(ua))
        return new Response('Undeclared Automated Tool', { status: 403 });
    }
    for (const [re, type, body] of ROUTES)
      if (re.test(url))
        return new Response(body, {
          status: 200,
          headers: { 'content-type': type, etag: `"${body.length}"` },
        });
    if (/CNMSshvol\d{8}\.txt/.test(url)) return new Response('nope', { status: 404 });
    if (/query2\.finance\.yahoo\.com/.test(url))
      return new Response(
        JSON.stringify({ chart: { result: null, error: { code: 'Not Found' } } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    return new Response('not found', { status: 404 });
  };
}

function wvFor(extra: WebVectorConfig = {}): WebVector {
  return new WebVector(
    {
      search: { fallbackProviders: [] },
      embeddings: { provider: 'none' },
      ingestion: {
        respectRobotsTxt: false,
        perHostMinIntervalMs: 0,
        retries: 0,
        timeoutMs: 2000,
        allowPrivateNetworks: true,
        contactEmail: 'tests@example.com',
        cache: { enabled: false },
      },
      markets: { deadlineMs: 5000 },
      logging: { level: 'silent' },
      fetch: stubFetch(),
      ...extra,
    },
    { env: {} },
  );
}

describe('feed parser', () => {
  it('parses RSS 2.0 with CDATA, namespaces, categories and <source>', () => {
    const f = parseFeed(YAHOO);
    expect(f.kind).toBe('rss');
    expect(f.title).toBe('Yahoo! Finance: AAPL News');
    expect(f.items).toHaveLength(4);
    expect(f.items[0]?.title).toBe('Apple Reports Third Quarter Results');
    expect(f.items[0]?.link).toBe('https://finance.yahoo.com/news/apple-q3.html');
    expect(f.items[0]?.publishedAt).toMatch(/^2026-08-22T16:00:00/);
    expect(f.items[0]?.summary).toContain('NASDAQ:AAPL');
    expect(f.items[0]?.sourceName).toBeUndefined(); // feed title is not the publisher
    expect(parseFeed(BING).items[0]?.sourceName).toBe('TechSite');
  });
  it('parses Atom entries (SEC-style) with link href and category term', () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Latest Filings</title><entry><title>8-K - Apple Inc.</title><link rel="alternate" href="https://www.sec.gov/Archives/x-index.htm"/><updated>2026-08-22T10:00:00-04:00</updated><summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-08-22</summary><category term="8-K" label="form type"/></entry></feed>`;
    const f = parseFeed(atom);
    expect(f.kind).toBe('atom');
    expect(f.items[0]?.link).toBe('https://www.sec.gov/Archives/x-index.htm');
    expect(f.items[0]?.categories).toEqual(['8-K']);
    expect(f.items[0]?.summary).toBe('Filed: 2026-08-22');
    expect(f.items[0]?.publishedAt).toBe('2026-08-22T14:00:00.000Z');
  });
  it('never throws on garbage', () => {
    expect(parseFeed('<html>nope</html>').items).toEqual([]);
    expect(parseFeed('').items).toEqual([]);
    expect(
      parseFeed('<rss><channel><item><title>x</title></item>').items.length,
    ).toBeGreaterThanOrEqual(0);
  });
});

describe('dedupe + classify + tickers', () => {
  it('unwraps redirectors for the story key and collapses near-identical titles with spread', () => {
    expect(
      storyKey(
        'http://www.bing.com/news/apiclick.aspx?ref=FexRss&aid=&url=https%3a%2f%2fa.example%2fx%3futm_source%3dz&c=1',
      ),
    ).toBe('https://a.example/x');
    const a = simhash64(titleTokens('Apple Reports Third Quarter Results'));
    const b = simhash64(titleTokens('Apple reports third quarter results - Yahoo Finance'));
    expect(hamming(a, b)).toBeLessThanOrEqual(3);
    const items: NewsItem[] = [
      {
        id: '1',
        title: 'Apple Reports Third Quarter Results',
        url: 'https://a.example/1',
        source: 'yahoo-rss',
        tickers: ['AAPL'],
        event: 'earnings',
        spread: 1,
        publishedAt: '2026-08-22T16:00:00Z',
      },
      {
        id: '2',
        title: 'Apple reports third quarter results',
        url: 'https://b.example/2',
        source: 'globenewswire-public',
        tickers: [],
        event: 'other',
        spread: 1,
        publishedAt: '2026-08-22T15:30:00Z',
      },
      {
        id: '3',
        title: 'Tesla recalls 10,000 vehicles over software bug',
        url: 'https://c.example/3',
        source: 'cnbc-top',
        tickers: ['TSLA'],
        event: 'legal',
        spread: 1,
      },
      {
        id: '4',
        title: 'Bing story one',
        url: 'http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fd.example%2f1',
        source: 'bing-news',
        tickers: [],
        event: 'other',
        spread: 1,
      },
      {
        id: '5',
        title: 'Bing story two, different',
        url: 'http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fd.example%2f2',
        source: 'bing-news',
        tickers: [],
        event: 'other',
        spread: 1,
      },
    ];
    const out = dedupeNews(items, { trust: { 'yahoo-rss': 0.7, 'globenewswire-public': 0.8 } });
    expect(out).toHaveLength(4);
    const apple = out.find((i) => i.tickers.includes('AAPL'))!;
    expect(apple.spread).toBe(2);
    expect(apple.url).toBe('https://b.example/2'); // more trusted source wins the representative slot
    expect(apple.publishedAt).toBe('2026-08-22T15:30:00Z'); // earliest timestamp kept
    expect(apple.event).toBe('earnings');
    expect(apple.alsoIn).toEqual(['yahoo-rss']);
  });
  it('tags events from headlines', () => {
    expect(classifyEvent('Apple Reports Third Quarter Results')).toBe('earnings');
    expect(classifyEvent('Apple Reports Record Quarter')).toBe('earnings');
    expect(classifyEvent('Analyst upgrades Apple to Buy, raises price target')).toBe('analyst');
    expect(classifyEvent('Is It Too Late to Buy Sandisk After Its 568% Run?')).toBe('other');
    expect(classifyEvent('Acme agrees to buy Foo for $2B')).toBe('ma');
    expect(classifyEvent('Acme Completes Acquisition of Foo')).toBe('ma');
    expect(classifyEvent('FDA approves new drug from Biotech')).toBe('fda');
    expect(classifyEvent('Company prices $500M offering of senior notes')).toBe('offering');
    expect(classifyEvent('Fed officials signal caution on rate cuts')).toBe('macro');
    expect(classifyEvent('Just a headline')).toBe('other');
    expect(classifyFiling('8-K', ['2.02', '9.01'])).toBe('earnings');
    expect(classifyFiling('8-K', ['1.05'])).toBe('legal');
    expect(classifyFiling('4')).toBe('insider');
    expect(classifyFiling('424B5')).toBe('offering');
  });
  it('extracts tickers and detects mentions case-sensitively for bare tickers', () => {
    expect(extractTickers('Apple Inc. (NASDAQ:AAPL) and $TSLA rally; NYSE: F flat')).toEqual([
      'TSLA',
      'AAPL',
      'F',
    ]);
    expect(extractTickers('Nasdaq: the index rose')).toEqual([]);
    expect(mentions('Shares of Apple fell', 'AAPL', 'apple')).toBe(true);
    expect(mentions('AAPL slides after hours', 'AAPL')).toBe(true);
    expect(mentions('Pineapple prices rise', 'AAPL', 'apple')).toBe(false);
    expect(mentions('Ford (NYSE: F) rallies', 'F')).toBe(true);
    expect(mentions('Formula for success', 'F')).toBe(false);
    expect(mentions('Apple shares now trading higher', 'NOW')).toBe(false);
    expect(mentions('NOW reports earnings', 'NOW')).toBe(true);
    expect(mentions('all eyes on the fed', 'ALL')).toBe(false);
    expect(mentions('BRK.B edges up', 'BRK.B')).toBe(true);
  });
});

describe('news', () => {
  it('fans out per-ticker + market feeds, filters to the window and relevance, dedupes and tags', async () => {
    const wv = wvFor();
    const res = await wv.markets.news({ symbols: ['aapl'], now: NOW, windowMs: 24 * 3_600_000 });
    expect(res.symbols).toEqual(['AAPL']);
    const titles = res.items.map((i) => i.title);
    expect(titles).toContain('Apple Reports Third Quarter Results');
    expect(titles).not.toContain('Old Apple story'); // outside the 24 h window
    expect(titles).not.toContain('Why I Think the Best Dividend Stock Is Realty Income'); // Yahoo padding: no mention
    expect(titles).not.toContain('Fed officials signal caution on rate cuts'); // market feed item not about AAPL
    expect(titles).not.toContain('Acme Widgets Completes Acquisition of Foo');
    expect(titles).toContain('Apple supplier warns of memory shortage'); // market feed mention via alias
    expect(titles).toContain('Apple Inc. Announces Quarterly Dividend'); // (NASDAQ: AAPL) in description
    expect(titles).toContain('Apple unveils new iPhone lineup');
    expect(titles).toContain('Apple hit with new EU fine - live updates'); // Bing items stay distinct; title intact
    const q3 = res.items.find((i) => i.title === 'Apple Reports Third Quarter Results')!;
    expect(q3.spread).toBe(2); // yahoo + seeking alpha
    expect(q3.event).toBe('earnings');
    expect(q3.tickers).toContain('AAPL');
    const bing = res.items.find((i) => i.title.startsWith('Apple unveils'))!;
    expect(bing.publisher).toBe('TechSite');
    expect(bing.url).toBe(
      'http://www.bing.com/news/apiclick.aspx?ref=FexRss&aid=&tid=1&url=https%3a%2f%2ftechsite.example%2fiphone&c=1&mkt=en-us',
    );
    const times = res.items.map((i) => i.publishedAt ?? '');
    expect([...times].sort().reverse()).toEqual(times); // newest first
    expect(res.sources.find((s) => s.id === 'google-news')?.status).toBe('skipped');
    expect(res.sources.find((s) => s.id === 'yahoo-rss')?.status).toBe('ok');
    const md = renderNews(res, { now: NOW });
    expect(md).toContain('## News — AAPL');
    expect(md).toContain('[earnings]');
    expect(md).toContain('×2');
    expect(md).toContain('Sources:');
    await wv.close();
  });
  it('word-tickers (NOW, ALL) do not match prose in market feeds; the feed fallback still returns per-ticker items', async () => {
    const wv = wvFor();
    const res = await wv.markets.news({ symbols: ['NOW', 'ALL'], now: NOW, includeMarket: true });
    expect(res.items.map((i) => i.title)).not.toContain('Everything is on sale now, all of it');
    await wv.close();
  });
  it('enables gray sources with markets.graySources and strips duplicated Google summaries', async () => {
    const wv = wvFor({ markets: { graySources: true } });
    const res = await wv.markets.news({ symbols: ['AAPL'], now: NOW });
    expect(res.sources.find((s) => s.id === 'google-news')?.status).toBe('ok');
    const eu = res.items.find((i) => i.title.startsWith('Apple faces antitrust'))!;
    expect(eu.publisher).toBe('Reuters');
    expect(eu.event).toBe('legal');
    expect(eu.summary).toBeUndefined();
    await wv.close();
  });
  it('market briefing with no symbols returns everything in the window', async () => {
    const wv = wvFor();
    const res = await wv.markets.news({ now: NOW, windowMs: 2 * 3_600_000 });
    expect(res.items.map((i) => i.title)).toEqual(
      expect.arrayContaining([
        'Fed officials signal caution on rate cuts',
        'Acme Widgets Completes Acquisition of Foo',
      ]),
    );
    expect(
      res.items.every((i) => !i.publishedAt || Date.parse(i.publishedAt) >= NOW - 2 * 3_600_000),
    ).toBe(true);
    await wv.close();
  });
  it('serves the second call from the TTL cache (no new requests)', async () => {
    const wv = wvFor();
    await wv.markets.news({ symbols: ['AAPL'], now: NOW });
    const before = requests.length;
    const res = await wv.markets.news({ symbols: ['AAPL'], now: NOW });
    expect(requests.length).toBe(before);
    expect(res.sources.filter((s) => s.status === 'cached').length).toBeGreaterThan(0);
    await wv.close();
  });
  it('returns at the deadline even when a source is slow, reporting it as timeout', async () => {
    const slow: typeof fetch = async (input: any, init?: any) => {
      const url = String(typeof input === 'string' ? input : input.url);
      if (/cnbc/.test(url)) await new Promise((r) => setTimeout(r, 3000));
      return stubFetch()(input, init);
    };
    const wv = wvFor({ fetch: slow, markets: { deadlineMs: 1000 } });
    const t0 = Date.now();
    const res = await wv.markets.news({ symbols: ['AAPL'], now: NOW });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(res.sources.find((s) => s.id === 'cnbc-top')?.status).toBe('timeout');
    expect(res.items.length).toBeGreaterThan(0);
    await wv.close();
  });
  it('a failed ticker-map load is retried on the next call', async () => {
    secDown = true;
    const wv = wvFor();
    await expect(wv.markets.filings({ symbol: 'AAPL', now: NOW })).rejects.toThrow();
    secDown = false;
    const res = await wv.markets.filings({ symbol: 'AAPL', days: 60, now: NOW });
    expect(res.company?.name).toBe('Apple Inc.');
    await wv.close();
  });
});

describe('filings', () => {
  it('lists recent filings with decoded 8-K items and archive URLs', async () => {
    const wv = wvFor();
    const res = await wv.markets.filings({ symbol: 'AAPL', days: 60, now: NOW });
    expect(res.company?.name).toBe('Apple Inc.');
    expect(res.filings.map((f) => f.form)).toEqual(['4', '8-K']); // 10-Q from 2025 is outside 60 days
    const k = res.filings[1]!;
    expect(k.items).toEqual(['2.02', '9.01']);
    expect(k.itemLabels?.[0]).toContain('Results of Operations');
    expect(k.event).toBe('earnings');
    expect(k.url).toBe(
      'https://www.sec.gov/Archives/edgar/data/320193/000032019326000018/a8-k20260730.htm',
    );
    expect(k.indexUrl).toBe(
      'https://www.sec.gov/Archives/edgar/data/320193/000032019326000018/0000320193-26-000018-index.htm',
    );
    const only8k = await wv.markets.filings({ symbol: 'AAPL', forms: ['8-k'], days: 60, now: NOW });
    expect(only8k.filings.map((f) => f.form)).toEqual(['8-K']);
    await wv.close();
  });
  it('declares the SEC User-Agent (the stub rejects anything else) and full-text searches', async () => {
    const wv = wvFor();
    const res = await wv.markets.searchFilings({
      query: '"Apple"',
      forms: ['8-K'],
      days: 30,
      now: NOW,
    });
    expect(res.total).toBe(1);
    expect(res.filings[0]?.company).toBe('Apple Inc.');
    expect(res.filings[0]?.ticker).toBe('AAPL');
    expect(res.filings[0]?.url).toContain('/000032019326000018/a8-kex991q3202606272026.htm');
    expect(requests.some((u) => u.includes('efts.sec.gov') && u.includes('forms=8-K'))).toBe(true);
    await wv.close();
  });
  it('fails clearly for an unknown ticker', async () => {
    const wv = wvFor();
    await expect(wv.markets.filings({ symbol: 'ZZZZ', now: NOW })).rejects.toThrow(
      /Unknown ticker/,
    );
    await wv.close();
  });
});

describe('calendar / sentiment / pulse', () => {
  it('merges this + next week, filters by window, impact and country; includes today’s prints with actuals', async () => {
    const wv = wvFor();
    const res = await wv.markets.calendar({ days: 7, impact: 'medium', now: NOW, earnings: false });
    expect(res.events.map((e) => e.title)).toEqual([
      'Retail Sales m/m',
      'CPI m/m',
      'Unemployment Claims',
      'NFP',
    ]);
    expect(res.events[0]?.actual).toBe('0.5%');
    const all = await wv.markets.calendar({
      days: 3,
      impact: 'low',
      countries: ['ALL'],
      now: NOW,
      earnings: false,
    });
    expect(all.events.map((e) => e.title)).toContain('ECB Rate');
    expect(all.events.map((e) => e.title)).toContain('Some Low Thing');
    expect(
      parseFfCalendar([{ title: 'x', country: 'usd', date: 'garbage', impact: 'High' }]),
    ).toEqual([]);
    await wv.close();
  });
  it('summarises StockTwits and FINRA short volume', async () => {
    const wv = wvFor();
    const s = await wv.markets.sentiment({ symbol: 'aapl', now: NOW });
    expect(s.messages).toBe(4);
    expect(s.bullish).toBe(2);
    expect(s.bearish).toBe(1);
    expect(s.bullRatio).toBeCloseTo(2 / 3);
    expect(s.top[0]?.likes).toBe(9);
    expect(s.watchers).toBe(989908);
    expect(s.shortVolume?.date).toBe('2026-08-21');
    expect(s.shortVolume?.ratio).toBeCloseTo(25 / 60);
    // The 404 probe for the newer date is remembered: the second call skips it.
    const before = requests.filter((u) => /CNMSshvol/.test(u)).length;
    await wv.markets.sentiment({ symbol: 'aapl', now: NOW + 1 });
    expect(requests.filter((u) => /CNMSshvol/.test(u)).length).toBe(before);
    expect(finraShortRow(FINRA, 'AAPLX')?.totalVolume).toBe(2);
    expect(finraShortRow(FINRA, 'MSFT')).toBeUndefined();
    expect(summarizeStocktwits({ messages: [] }, 'X').bullRatio).toBeUndefined();
    await wv.close();
  });
  it('pulse reads VIX + FRED and skips the gray Yahoo source by default', async () => {
    const wv = wvFor();
    const res = await wv.markets.pulse({ now: NOW });
    const vix = res.series.find((s) => s.id === 'VIX')!;
    expect(vix.last).toEqual({ date: '2026-08-21', value: 17.2 });
    expect(vix.change).toBeCloseTo(1.3);
    const dgs10 = res.series.find((s) => s.id === 'DGS10')!;
    expect(dgs10.last.value).toBe(4.7);
    expect(dgs10.prev?.value).toBe(4.63); // the '.' row is skipped
    expect(res.quotes).toEqual([]);
    expect(res.sources.find((s) => s.id === 'yahoo-chart')?.status).toBe('skipped');
    await wv.close();
  });
  it('pulse quotes the basket when gray sources are on; a bad symbol is a partial failure, not a failed source', async () => {
    const wv = wvFor({ markets: { graySources: true } });
    const res = await wv.markets.pulse({ now: NOW, basket: false, symbols: ['SPY', 'NOPE'] });
    expect(res.quotes.map((q) => q.symbol)).toEqual(['SPY']);
    expect(res.quotes[0]?.changePct).toBeCloseTo(-1.37, 1);
    expect(res.quotes[0]?.dayHigh).toBeUndefined(); // 0 → unknown
    const y = res.sources.find((s) => s.id === 'yahoo-chart')!;
    expect(y.status).toBe('ok');
    expect(y.reason).toMatch(/1\/2 failed/);
    expect(parseVixCsv('DATE,OPEN,HIGH,LOW,CLOSE\n')).toBeUndefined();
    expect(parseFredCsv('observation_date,X\n2026-01-01,.\n', 'X')).toBeUndefined();
    expect(parseYahooChart({ chart: { result: [] } }, 'Q')).toBeUndefined();
    await wv.close();
  });
  it('status() reports the policy per source', async () => {
    const wv = wvFor({ markets: { disableSources: ['benzinga'], feedRobots: 'respect' } });
    const st = wv.markets.status();
    expect(st.find((s) => s.id === 'benzinga')?.enabled).toBe(false);
    expect(st.find((s) => s.id === 'google-news')?.enabled).toBe(false);
    expect(st.find((s) => s.id === 'yahoo-rss')?.enabled).toBe(false);
    expect(st.find((s) => s.id === 'sec-submissions')?.enabled).toBe(true);
    await wv.close();
  });
  it('domain policy applies to the unwrapped target of redirect links (read gate + ToolGuard)', () => {
    const guard = new ToolGuard({ blockedDomains: ['evil.example'] });
    expect(() =>
      guard.assertUrlAllowed(
        'https://www.bing.com/news/apiclick.aspx?ref=FexRss&url=https%3A%2F%2Fevil.example%2Fx',
      ),
    ).toThrow(/not allowed/);
    expect(() => guard.assertUrlAllowed('https://www.bing.com/news/x')).not.toThrow();
    const allow = new ToolGuard({ allowedDomains: ['bing.com'] });
    expect(() =>
      allow.assertUrlAllowed(
        'https://www.bing.com/news/apiclick.aspx?url=https%3A%2F%2Fother.example%2F',
      ),
    ).toThrow(/not allowed/);
  });
  it('every renderer ends with the untrusted-content note; capMarkdown keeps "Source:" footers too', async () => {
    const wv = wvFor();
    const [cal, pulse, sent] = await Promise.all([
      wv.markets.calendar({ now: NOW, earnings: false }),
      wv.markets.pulse({ now: NOW }),
      wv.markets.sentiment({ symbol: 'AAPL', now: NOW }),
    ]);
    for (const md of [renderCalendar(cal), renderPulse(pulse), renderSentiment(sent)])
      expect(md.trimEnd().endsWith(UNTRUSTED_NOTE)).toBe(true);
    const filings = await wv.markets.filings({ symbol: 'AAPL', days: 60, now: NOW });
    const long = renderFilings({ ...filings, filings: Array(60).fill(filings.filings[0]) });
    const capped = capMarkdown(long, 300);
    expect(capped).toContain('Source: sec-submissions');
    expect(capped.trimEnd().endsWith(UNTRUSTED_NOTE)).toBe(true);
    await wv.close();
  });
  it('capMarkdown trims items but keeps the footer', () => {
    const body = Array.from({ length: 40 }, (_, i) => `- item ${i} ${'x'.repeat(80)}`).join('\n');
    const md = `## News\n${body}\n\nSources: a(1)\n${'note'}`;
    const capped = capMarkdown(md, 200);
    expect(capped.length).toBeLessThan(1000);
    expect(capped).toContain('Sources: a(1)');
    expect(capped).toMatch(/more items omitted/);
    expect(capMarkdown('short', 200)).toBe('short');
  });
});
