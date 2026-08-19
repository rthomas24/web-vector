import { WebVectorError } from '../errors.js';
import type { ContentSignal, Logger } from '../types.js';
import {
  createLimiter,
  KeyedQueue,
  type Limiter,
  retry,
  withTimeout,
} from '../util/concurrency.js';
import { cleanUrl } from '../util/url.js';
import { RobotsCache } from './robots.js';
import { assertSafeUrl, createGuardedDispatcher, isGuardedLookupError } from './ssrf.js';

export interface FetcherOptions {
  userAgent: string;
  timeoutMs: number;
  maxRedirects: number;
  maxBytes: number;
  maxConcurrentFetches: number;
  perHostConcurrency: number;
  perHostMinIntervalMs: number;
  /** Cap for robots.txt Crawl-delay (ms); 0 = ignore Crawl-delay. */
  maxCrawlDelayMs?: number;
  respectRobotsTxt: boolean;
  retries: number;
  allowPrivateNetworks: boolean;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Additional request headers. */
  headers?: Record<string, string>;
  /** Custom DNS resolver (tests). */
  resolve?: (hostname: string) => Promise<string[]>;
  /**
   * Content negotiation for served markdown (Cloudflare "Markdown for Agents", Mintlify, Vercel…):
   * `prefer` (default) asks for `text/markdown` first, `accept` lists it after HTML, `off` never
   * advertises it. Served markdown is 10–100× smaller than the HTML and skips Readability.
   */
  acceptMarkdown?: 'prefer' | 'accept' | 'off';
  /**
   * Byte cap for textual responses (HTML/XHTML/markdown/plain/XML/JSON), below `maxBytes`
   * (which still applies to PDFs). Default 2 MiB — a real article never needs more; SSR bundles do.
   */
  maxHtmlBytes?: number;
  /**
   * Content Signals (contentsignals.org): `respect` (default) refuses pages whose robots.txt group
   * or `content-signal` header says `ai-input=no` (FETCH_BLOCKED_CONTENT_SIGNAL) and records the
   * signal otherwise; `record` only records it on the resource; `ignore` does neither.
   */
  contentSignals?: 'ignore' | 'record' | 'respect';
}

export interface FetchedResource {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  charset?: string;
  bytes: Uint8Array;
  ms: number;
  redirects: number;
  headers: Headers;
  /** Content-usage signal (header wins over robots.txt); absent when none was declared or `contentSignals: 'ignore'`. */
  contentSignal?: ContentSignal;
  /** Decoded `#:~:text=` fragment from the requested URL (a retrieval hint), if any. */
  textFragment?: string;
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const ACCEPT_HEADERS = {
  prefer:
    'text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, application/pdf;q=0.8, text/plain;q=0.7, */*;q=0.5',
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,text/plain;q=0.8,text/markdown;q=0.8,*/*;q=0.5',
  off: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5',
} as const;

/** The `Accept` header sent for page fetches under a given `acceptMarkdown` mode. */
export function acceptHeaderFor(mode: FetcherOptions['acceptMarkdown'] = 'prefer'): string {
  return ACCEPT_HEADERS[mode] ?? ACCEPT_HEADERS.prefer;
}

/**
 * Polite, safe HTTP fetcher built on global fetch:
 * manual redirects (cap + SSRF re-check per hop), a connect-time DNS guard (no rebinding race),
 * timeouts, size cap via streaming, retries with backoff honouring Retry-After, per-host
 * concurrency + min interval, robots.txt.
 */
export class Fetcher {
  private readonly limiter: Limiter;
  private readonly hostQueue: KeyedQueue;
  private readonly robots?: RobotsCache;
  private readonly fetchImpl: typeof fetch;
  /** undici Agent whose DNS lookup refuses non-public addresses (undefined when a custom fetch is injected). */
  private dispatcher?: Promise<unknown | undefined>;
  constructor(private readonly opts: FetcherOptions) {
    this.limiter = createLimiter(opts.maxConcurrentFetches);
    this.hostQueue = new KeyedQueue({
      concurrency: opts.perHostConcurrency,
      minIntervalMs: opts.perHostMinIntervalMs,
    });
    this.fetchImpl = opts.fetch ?? fetch;
    if (!opts.fetch && !opts.allowPrivateNetworks) {
      this.dispatcher = createGuardedDispatcher({
        resolve: opts.resolve,
        connectTimeoutMs: Math.min(opts.timeoutMs, 10_000),
      });
    }
    if (opts.respectRobotsTxt) {
      this.robots = new RobotsCache({
        userAgent: opts.userAgent,
        // robots.txt goes through the same guarded, size-capped path as pages.
        fetch: (url, init) => this.guardedFetch(String(url), init),
        logger: opts.logger,
      });
    }
  }

  /** Raw fetch with the connect-time SSRF dispatcher attached (no redirects, no retries). */
  async guardedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const dispatcher = await this.dispatcher;
    return this.fetchImpl(url, { ...init, ...(dispatcher ? ({ dispatcher } as RequestInit) : {}) });
  }

  /**
   * Fetch a URL honouring all guards. Throws WebVectorError with a per-URL failure code.
   * URL hygiene runs first (redirect wrappers unwrapped, AMP/mobile variants folded, `#:~:text=`
   * preserved as `textFragment`); `FetchedResource.url` is the cleaned URL.
   */
  async fetch(url: string, signal?: AbortSignal): Promise<FetchedResource> {
    const cleaned = cleanUrl(url);
    if (cleaned.rewritten) this.opts.logger?.debug(`fetch: url hygiene ${url} → ${cleaned.url}`);
    url = cleaned.url;
    const parsed = new URL(url);
    await assertSafeUrl(parsed, {
      allowPrivateNetworks: this.opts.allowPrivateNetworks,
      resolve: this.opts.resolve,
    });
    let robotsSignal: ContentSignal | undefined;
    if (this.robots) {
      const { allowed, crawlDelayMs, contentSignal } = await this.robots.check(url, signal);
      const cap = this.opts.maxCrawlDelayMs ?? 10_000;
      const delay = crawlDelayMs === undefined ? 0 : Math.min(crawlDelayMs, cap);
      if (delay > 0) this.hostQueue.setMinInterval(parsed.hostname.toLowerCase(), delay);
      if (!allowed) {
        throw new WebVectorError(`robots.txt disallows fetching ${url}`, {
          code: 'FETCH_BLOCKED_ROBOTS',
          stage: 'ingest',
          remediation:
            'The site forbids crawlers for this path. Set `ingestion.respectRobotsTxt: false` only if you have permission.',
        });
      }
      if (contentSignal && this.signalMode() !== 'ignore') {
        robotsSignal = parseContentSignal(contentSignal, 'robots');
        this.assertSignalAllows(robotsSignal, url);
      }
    }
    // Politeness is per hostname (a Crawl-delay on evil.github.io must not slow all of github.io).
    const host = parsed.hostname.toLowerCase();
    const res = await this.limiter(() =>
      this.hostQueue.run(host, () =>
        retry((attempt) => this.doFetch(url, signal, attempt), {
          retries: this.opts.retries,
          signal,
          minDelayMs: 500,
          shouldRetry: (err) => WebVectorError.is(err) && err.retryable,
          delayFor: (err) => (WebVectorError.is(err) ? err.retryAfterMs : undefined),
          onRetry: (err, attempt, delay) =>
            this.opts.logger?.debug(
              `fetch: retry ${attempt} for ${url} in ${Math.round(delay)}ms (${err instanceof Error ? err.message : err})`,
            ),
        }),
      ),
    );
    if (this.signalMode() !== 'ignore') {
      const header = res.headers.get('content-signal');
      const sig = header ? parseContentSignal(header, 'header') : robotsSignal;
      if (sig) {
        this.assertSignalAllows(sig, url);
        res.contentSignal = sig;
      }
    }
    if (cleaned.textFragment) res.textFragment = cleaned.textFragment;
    return res;
  }

  private signalMode(): NonNullable<FetcherOptions['contentSignals']> {
    return this.opts.contentSignals ?? 'respect';
  }

  /** `respect` mode: refuse content whose signal says ai-input=no. */
  private assertSignalAllows(sig: ContentSignal, url: string): void {
    if (this.signalMode() !== 'respect' || sig.aiInput !== false) return;
    throw new WebVectorError(
      `Content-Signal ai-input=no (${sig.source}) — the site asks not to be used as AI input: ${url}`,
      {
        code: 'FETCH_BLOCKED_CONTENT_SIGNAL',
        stage: 'ingest',
        retryable: false,
        remediation:
          'The publisher declared `ai-input=no` via Content Signals (contentsignals.org). Set `ingestion.contentSignals: "record"` to fetch anyway (only where you have permission).',
        details: { signal: sig.raw, source: sig.source },
      },
    );
  }

  private async doFetch(
    startUrl: string,
    signal: AbortSignal | undefined,
    attempt: number,
  ): Promise<FetchedResource> {
    const t0 = Date.now();
    let current = startUrl;
    let redirects = 0;
    const timeoutSignal = withTimeout(this.opts.timeoutMs, signal);
    const startOrigin = new URL(startUrl).origin;
    for (;;) {
      let res: Response;
      try {
        // Caller-supplied headers (may include credentials) are only sent to the original origin.
        const sameOrigin = new URL(current).origin === startOrigin;
        res = await this.guardedFetch(current, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'user-agent': this.opts.userAgent,
            accept: acceptHeaderFor(this.opts.acceptMarkdown),
            'accept-language': 'en-US,en;q=0.9,*;q=0.5',
            'accept-encoding': 'gzip, deflate, br',
            ...(sameOrigin ? this.opts.headers : stripCredentialHeaders(this.opts.headers)),
          },
          signal: timeoutSignal,
        });
      } catch (err) {
        const e = err as Error;
        if (isGuardedLookupError(e)) {
          throw new WebVectorError(
            `Blocked fetch of ${current}: resolves to a non-public address.`,
            {
              code: 'FETCH_BLOCKED_SSRF',
              stage: 'ingest',
              remediation:
                'Private/loopback/link-local targets are blocked by default (SSRF protection).',
            },
          );
        }
        if (e?.name === 'TimeoutError' || (timeoutSignal.aborted && !signal?.aborted)) {
          throw new WebVectorError(`Timed out after ${this.opts.timeoutMs}ms fetching ${current}`, {
            code: 'FETCH_TIMEOUT',
            stage: 'ingest',
            retryable: attempt < 1,
          });
        }
        if (e?.name === 'AbortError')
          throw new WebVectorError('Fetch aborted', { code: 'ABORTED', stage: 'ingest', cause: e });
        throw new WebVectorError(`Network error fetching ${current}: ${causeMessage(e)}`, {
          code: 'FETCH_FAILED',
          stage: 'ingest',
          retryable: true,
          cause: e,
        });
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await drain(res);
        if (!loc)
          throw new WebVectorError(`Redirect without Location from ${current}`, {
            code: 'FETCH_HTTP_ERROR',
            stage: 'ingest',
          });
        redirects++;
        if (redirects > this.opts.maxRedirects) {
          throw new WebVectorError(
            `Too many redirects (> ${this.opts.maxRedirects}) starting at ${startUrl}`,
            { code: 'TOO_MANY_REDIRECTS', stage: 'ingest' },
          );
        }
        const next = new URL(loc, current);
        next.hash = '';
        await assertSafeUrl(next, {
          allowPrivateNetworks: this.opts.allowPrivateNetworks,
          resolve: this.opts.resolve,
        });
        current = next.toString();
        continue;
      }

      if (!res.ok) {
        const retryAfter = res.headers.get('retry-after');
        // Bot walls / paywalls: classify from headers + a small body excerpt, never retry.
        const excerpt = BLOCK_SNIFF_STATUS.has(res.status) ? await peekText(res) : '';
        await drain(res);
        const blocked = blockedError(res.status, res.headers, excerpt, current);
        if (blocked) throw blocked;
        const retryable = RETRY_STATUS.has(res.status);
        throw new WebVectorError(`HTTP ${res.status} fetching ${current}`, {
          code: res.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'FETCH_HTTP_ERROR',
          stage: 'ingest',
          retryable,
          retryAfterMs: retryAfter ? parseRetryAfterMs(retryAfter) : undefined,
          details: { status: res.status },
        });
      }

      const ctHeader = res.headers.get('content-type') ?? '';
      const { type: contentType, charset } = parseContentType(ctHeader);
      // Early abort on media/archives/scripts: nothing to extract, so don't download the body.
      if (isNonContentType(contentType) && !urlSaysDocument(current)) {
        await drain(res);
        throw unsupportedType(contentType, current, 'header');
      }
      const textual = isTextualType(contentType);
      const cap = textual
        ? Math.min(this.opts.maxBytes, this.opts.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES)
        : this.opts.maxBytes;
      const len = Number(res.headers.get('content-length') ?? '0');
      if (len > cap) {
        await drain(res);
        throw tooLarge(current, len, cap, textual);
      }
      const bytes = await readCapped(
        res,
        cap,
        current,
        // Unlabelled bodies: sniff the first chunk and bail out unless it looks like a document.
        contentType === 'application/octet-stream' || contentType === ''
          ? (head) =>
              looksLikeDocument(head) ? undefined : unsupportedType(contentType, current, 'sniff')
          : undefined,
        textual,
      );
      // A 202 or a tiny 200 HTML page can still be an interstitial challenge (DataDome, Imperva…).
      if (
        (res.status === 202 || bytes.byteLength < BLOCK_SNIFF_BYTES) &&
        /^(text\/html|application\/xhtml\+xml|)$/.test(contentType)
      ) {
        const blocked = blockedError(
          res.status,
          res.headers,
          new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, BLOCK_SNIFF_BYTES)),
          current,
        );
        if (blocked) throw blocked;
      }
      return {
        url: startUrl,
        finalUrl: current,
        status: res.status,
        contentType,
        charset,
        bytes,
        ms: Date.now() - t0,
        redirects,
        headers: res.headers,
      };
    }
  }
}

// ─── Content Signals ─────────────────────────────────────────────────────────

/**
 * Parse a Content-Signal value (`search=yes, ai-input=no, ai-train=no`) from a robots.txt group
 * or the `content-signal` response header. Unknown keys are ignored; absent keys stay undefined.
 */
export function parseContentSignal(raw: string, source: ContentSignal['source']): ContentSignal {
  const out: ContentSignal = { raw: raw.trim().slice(0, 200), source };
  for (const part of raw.split(',')) {
    const [k, v] = part.split('=').map((x) => x?.trim().toLowerCase());
    if (!k || (v !== 'yes' && v !== 'no')) continue;
    const val = v === 'yes';
    if (k === 'search') out.search = val;
    else if (k === 'ai-input') out.aiInput = val;
    else if (k === 'ai-train') out.aiTrain = val;
  }
  return out;
}

// ─── Bot-wall / paywall classification ──────────────────────────────────────

/** Statuses whose body excerpt is worth sniffing for anti-bot vendors. */
const BLOCK_SNIFF_STATUS = new Set([401, 402, 403, 405, 406, 429, 503]);
const BLOCK_SNIFF_BYTES = 8192;

export interface BotBlock {
  /** `cloudflare` | `akamai` | `datadome` | `perimeterx` | `imperva` | `cloudflare-pay-per-crawl` | `unknown` */
  vendor: string;
  /** What matched (header name or body marker). */
  reason: string;
  /** Payment walls: the advertised price (e.g. `USD 0.01`). */
  price?: string;
}

/**
 * Classify a response as an anti-bot challenge / access-denied wall or a pay-per-crawl 402.
 * Sources: Cloudflare challenge detection (`cf-mitigated: challenge`, "Just a moment…",
 * challenges.cloudflare.com), Cloudflare error pages ("Sorry, you have been blocked", 1020),
 * Akamai ("Access Denied … Reference #"), DataDome (`x-datadome*`, captcha-delivery.com),
 * PerimeterX/HUMAN (`_pxAppId`, px-captcha), Imperva/Incapsula (`x-iinfo`, `_Incapsula_Resource`),
 * Cloudflare pay-per-crawl (402 + `crawler-price`). Returns undefined for ordinary errors.
 */
export function classifyBotBlock(
  status: number,
  headers: Headers,
  body: string,
): BotBlock | undefined {
  const h = (name: string) => headers.get(name) ?? '';
  const server = h('server').toLowerCase();
  const excerpt = body.slice(0, BLOCK_SNIFF_BYTES);
  if (status === 402) {
    const price = h('crawler-price');
    return price
      ? { vendor: 'cloudflare-pay-per-crawl', reason: 'crawler-price', price }
      : { vendor: 'unknown', reason: 'HTTP 402' };
  }
  if (h('cf-mitigated').toLowerCase() === 'challenge')
    return { vendor: 'cloudflare', reason: 'cf-mitigated: challenge' };
  if (h('x-datadome') || h('x-datadome-cid') || h('x-dd-b'))
    return { vendor: 'datadome', reason: 'x-datadome' };
  if (/captcha-delivery\.com|datadome/i.test(excerpt))
    return { vendor: 'datadome', reason: 'captcha-delivery.com' };
  if (/_pxAppId|_pxUuid|px-captcha|PerimeterX|human-challenge/i.test(excerpt))
    return { vendor: 'perimeterx', reason: 'px challenge markup' };
  if (
    h('x-iinfo') ||
    /imperva/i.test(h('x-cdn')) ||
    /_Incapsula_Resource|Incapsula incident|Imperva/i.test(excerpt)
  )
    return { vendor: 'imperva', reason: 'incapsula markup' };
  if (
    /Access Denied[\s\S]{0,600}Reference(?:&#32;|\s)#/i.test(excerpt) ||
    (status === 403 && /akamai/i.test(server))
  )
    return { vendor: 'akamai', reason: 'Access Denied … Reference #' };
  if (/Just a moment\.\.\.|challenges\.cloudflare\.com|cf-chl-|_cf_chl_opt|cf_chl_/i.test(excerpt))
    return { vendor: 'cloudflare', reason: 'challenge page' };
  if (
    server.includes('cloudflare') &&
    status === 403 &&
    /Attention Required!|Sorry, you have been blocked|cf-error-details|error code: 10[0-9]{2}|<title>Access denied<\/title>/i.test(
      excerpt,
    )
  )
    return { vendor: 'cloudflare', reason: 'blocked page (1xxx)' };
  if (
    (status === 403 || status === 429 || status === 503 || status === 202 || status === 200) &&
    /Enable JavaScript and cookies to continue|Checking your browser before accessing|Verify you are human|Please verify you are a human|Are you a robot\?|Pardon Our Interruption/i.test(
      excerpt,
    )
  )
    return { vendor: 'unknown', reason: 'challenge text' };
  return undefined;
}

function blockedError(
  status: number,
  headers: Headers,
  excerpt: string,
  url: string,
): WebVectorError | undefined {
  const b = classifyBotBlock(status, headers, excerpt);
  if (!b) return undefined;
  if (status === 402) {
    return new WebVectorError(
      `Payment required for ${url} (${b.vendor}${b.price ? `, ${b.price}` : ''})`,
      {
        code: 'FETCH_PAYMENT_REQUIRED',
        stage: 'ingest',
        retryable: false,
        remediation:
          'The site charges crawlers for access (HTTP 402). WebVector never pays; use a search provider that returns page content, or an archive fallback (`ingestion.archiveFallback`).',
        details: { status, vendor: b.vendor, price: b.price },
      },
    );
  }
  return new WebVectorError(`Blocked by anti-bot protection (${b.vendor}) fetching ${url}`, {
    code: 'FETCH_BLOCKED_BOT',
    stage: 'ingest',
    retryable: false,
    remediation:
      'The host serves a bot challenge to non-browser clients; retrying will not help. Use a search provider that returns page content, enable `ingestion.archiveFallback`, or fetch the page in a browser.',
    details: { status, vendor: b.vendor, reason: b.reason },
  });
}

/** Read up to BLOCK_SNIFF_BYTES of a body as text without throwing (for classification only). */
async function peekText(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < BLOCK_SNIFF_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    /* ignore */
  } finally {
    void reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, BLOCK_SNIFF_BYTES));
}

function stripCredentialHeaders(
  h: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!h) return h;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h))
    if (!/^(authorization|cookie|proxy-authorization)$/i.test(k)) out[k] = v;
  return out;
}

function tooLarge(url: string, size: number, max: number, textual = false): WebVectorError {
  return new WebVectorError(`Response too large (${size} > ${max} bytes) for ${url}`, {
    code: 'FETCH_TOO_LARGE',
    stage: 'ingest',
    remediation: textual
      ? 'Increase `ingestion.maxHtmlBytes` (text/HTML cap) or `ingestion.maxBytes` if you need larger documents.'
      : 'Increase `ingestion.maxBytes` if you need larger documents.',
    details: { size, max, cap: textual ? 'maxHtmlBytes' : 'maxBytes' },
  });
}

// ─── Content-type gate ───────────────────────────────────────────────────────

const DEFAULT_MAX_HTML_BYTES = 2 * 1024 * 1024;
const NON_CONTENT_TYPE_RE =
  /^(?:image|video|audio|font)\/|^application\/(?:zip|gzip|x-gzip|x-tar|x-bzip2|x-xz|zstd|x-7z-compressed|x-rar-compressed|vnd\.rar|wasm|x-msdownload|x-apple-diskimage|vnd\.android\.package-archive|java-archive|x-shockwave-flash|(?:x-)?javascript|ecmascript)$|^text\/(?:css|javascript)$/;
const TEXTUAL_TYPE_RE =
  /^text\/|^application\/(?:xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml)$/;

/** Media, archives, scripts, styles: never contain extractable prose. */
export function isNonContentType(contentType: string): boolean {
  return NON_CONTENT_TYPE_RE.test(contentType);
}

/** Types capped by `maxHtmlBytes` rather than `maxBytes`. */
export function isTextualType(contentType: string): boolean {
  return TEXTUAL_TYPE_RE.test(contentType);
}

/** URL path extension says the body is a document even if the type header does not. */
function urlSaysDocument(url: string): boolean {
  try {
    return /\.(?:pdf|html?|xhtml|md|markdown|txt)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** First-chunk sniff for unlabelled bodies: PDF, HTML/XML, or plain UTF-8 text. */
export function looksLikeDocument(head: Uint8Array): boolean {
  if (head.byteLength === 0) return true;
  const sample = head.subarray(0, 1024);
  const latin = new TextDecoder('latin1').decode(sample);
  if (latin.startsWith('%PDF-')) return true;
  if (/^\s*(?:<!doctype|<html|<head|<body|<\?xml|<rss|<feed)/i.test(latin.slice(0, 256)))
    return true;
  // Text-like: no NUL bytes and few control characters in the sample.
  let controls = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) controls++;
  }
  return controls < sample.byteLength / 64;
}

function unsupportedType(
  contentType: string,
  url: string,
  via: 'header' | 'sniff',
): WebVectorError {
  return new WebVectorError(
    `Unsupported content type "${contentType || 'unknown'}" for ${url} (${via === 'header' ? 'rejected from headers; body not downloaded' : 'binary body'})`,
    {
      code: 'UNSUPPORTED_CONTENT_TYPE',
      stage: 'ingest',
      retryable: false,
      details: { contentType, via },
    },
  );
}

/**
 * Read a body up to `max` bytes (cancelling the stream past the cap). `sniff` runs once on the
 * first ~1 KB and may return an error to abort the download early.
 */
export async function readCapped(
  res: Response,
  max: number,
  url: string,
  sniff?: (head: Uint8Array) => WebVectorError | undefined,
  textual = false,
): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let sniffed = !sniff;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel().catch(() => {});
      throw tooLarge(url, total, max, textual);
    }
    chunks.push(value);
    if (!sniffed && (total >= 1024 || chunks.length >= 4)) {
      sniffed = true;
      const err = sniff?.(concat(chunks, total));
      if (err) {
        void reader.cancel().catch(() => {});
        throw err;
      }
    }
  }
  if (!sniffed && total > 0) {
    const err = sniff?.(concat(chunks, total));
    if (err) throw err;
  }
  return concat(chunks, total);
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Discard a response body without waiting: some interceptors/servers never settle cancel(). */
async function drain(res: Response): Promise<void> {
  try {
    void res.body?.cancel().catch(() => {});
  } catch {
    /* ignore */
  }
}

export function parseContentType(header: string): { type: string; charset?: string } {
  const [type = '', ...params] = header.split(';');
  let charset: string | undefined;
  for (const p of params) {
    const [k, v] = p.split('=');
    if (k?.trim().toLowerCase() === 'charset' && v)
      charset = v.trim().replace(/^"|"$/g, '').toLowerCase();
  }
  return { type: type.trim().toLowerCase(), charset };
}

function parseRetryAfterMs(v: string): number | undefined {
  const n = Number(v);
  if (Number.isFinite(n)) return n * 1000;
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : undefined;
}

function causeMessage(e: unknown): string {
  if (e instanceof Error) {
    const c = (e as Error & { cause?: unknown }).cause;
    if (c instanceof Error && c.message) return `${e.message} (${c.message})`;
    return e.message;
  }
  return String(e);
}
