/**
 * Polite HTTP client for market sources: every request goes through the pipeline's `Fetcher`
 * (SSRF guard, per-host pacing, bot-wall detection, size caps), then through the TTL cache with
 * conditional revalidation (ETag / Last-Modified → 304) and stale-on-error. Source policy is
 * enforced here from the catalog: gray sources are refused unless `markets.graySources` is on,
 * syndication feeds skip the robots check only when `markets.feedRobots` is `exempt`, SEC hosts
 * get the declared `Name (contact)` User-Agent, and each source's `minIntervalMs` is handed to
 * the fetcher's per-host queue (the same mechanism robots `Crawl-delay` uses).
 */
import { WebVectorError } from '../errors.js';
import type { FetchedResource, Fetcher } from '../ingest/fetcher.js';
import { decodeBytes } from '../ingest/parsers.js';
import type { Logger } from '../types.js';
import { withTimeout } from '../util/concurrency.js';
import { hostnameOf } from '../util/url.js';
import { WEBVECTOR_VERSION } from '../util/version.js';
import type { CacheEntry, MarketsCache } from './cache.js';
import { MARKETS_BROWSER_UA, robotsModeFor, sourceEnabled } from './sources.js';
import type { MarketSource, MarketsPolicyLike, SourceRun } from './types.js';

export interface MarketsPolicy extends MarketsPolicyLike {
  /** Contact for the SEC EDGAR User-Agent (falls back to `ingestion.contactEmail`). */
  contact?: string;
  /** Per-call wall-clock budget for fan-out (ms). */
  deadlineMs: number;
}

export interface MarketsClientOptions {
  fetcher: () => Promise<Fetcher>;
  cache: MarketsCache;
  policy: MarketsPolicy;
  contactEmail?: string;
  logger?: Logger;
}

export interface TextResponse {
  text: string;
  fromCache: boolean;
  /** A refresh failed and an expired copy was served. */
  stale: boolean;
  fetchedAt: number;
}

export class MarketsClient {
  private readonly paced = new Set<string>();
  constructor(readonly opts: MarketsClientOptions) {}

  get policy(): MarketsPolicy {
    return this.opts.policy;
  }

  /** Is this source usable under the current policy? */
  enabled(source: MarketSource): { ok: boolean; reason?: string } {
    return sourceEnabled(source, this.opts.policy);
  }

  /** Declared User-Agent for SEC hosts: `WebVector/<ver> (<contact>)` — URLs in the UA are rejected by EDGAR. */
  secUserAgent(): string {
    // Header value: one line, printable ASCII only (no CR/LF/control characters from config).
    const contact = (this.opts.policy.contact ?? this.opts.contactEmail ?? '')
      .replace(/[^\x20-\x7e]/g, '')
      .trim();
    return `WebVector/${WEBVECTOR_VERSION} (${contact || 'contact not configured'})`;
  }

  private assertEnabled(source: MarketSource): void {
    const en = this.enabled(source);
    if (!en.ok)
      throw new WebVectorError(`market source ${source.id} is not enabled: ${en.reason}`, {
        code: 'INVALID_CONFIG',
        stage: 'ingest',
        retryable: false,
        remediation: en.reason,
      });
  }

  /** One guarded request (no cache). */
  async request(
    source: MarketSource,
    url: string,
    opts: { signal?: AbortSignal; headers?: Record<string, string> } = {},
  ): Promise<FetchedResource> {
    this.assertEnabled(source);
    const fetcher = await this.opts.fetcher();
    if (source.minIntervalMs && !this.paced.has(source.id)) {
      for (const h of source.hosts) fetcher.setHostMinInterval(h, source.minIntervalMs);
      this.paced.add(source.id);
    }
    const headers: Record<string, string> = { ...source.headers, ...opts.headers };
    if (source.ua === 'browser') headers['user-agent'] = MARKETS_BROWSER_UA;
    if (source.ua === 'declared' || /(^|\.)sec\.gov$/.test(hostnameOf(url)))
      headers['user-agent'] = this.secUserAgent();
    return fetcher.fetch(url, opts.signal, { headers, retries: 1, robots: robotsModeFor(source) });
  }

  /**
   * Text body through the TTL cache. Conditional revalidation when the cached copy carries
   * validators; a failed refresh serves the stale copy (flagged) instead of failing the call.
   */
  async fetchText(
    source: MarketSource,
    url: string,
    opts: { signal?: AbortSignal; headers?: Record<string, string>; now?: number } = {},
  ): Promise<TextResponse> {
    this.assertEnabled(source);
    const r = await this.opts.cache.remember<string>(
      `${source.id} ${url}`,
      source.ttlMs,
      async (prev?: CacheEntry<string>) => {
        const cond: Record<string, string> = {};
        if (prev?.etag) cond['if-none-match'] = prev.etag;
        if (prev?.lastModified) cond['if-modified-since'] = prev.lastModified;
        const res = await this.request(source, url, {
          signal: opts.signal,
          headers: { ...cond, ...opts.headers },
        });
        if (res.status === 304 && prev) return { notModified: true };
        return {
          value: decodeBytes(res.bytes, res.charset),
          etag: res.headers.get('etag') ?? undefined,
          lastModified: res.headers.get('last-modified') ?? undefined,
        };
      },
      opts.now,
    );
    return { text: r.value, fromCache: r.fromCache, stale: r.stale, fetchedAt: r.fetchedAt };
  }

  async fetchJson<T = unknown>(
    source: MarketSource,
    url: string,
    opts: { signal?: AbortSignal; now?: number } = {},
  ): Promise<{ data: T; fromCache: boolean; stale: boolean; fetchedAt: number }> {
    const r = await this.fetchText(source, url, {
      ...opts,
      headers: { accept: 'application/json' },
    });
    try {
      return { ...r, data: JSON.parse(r.text) as T };
    } catch (err) {
      throw new WebVectorError(`${source.id}: response is not JSON (${url})`, {
        code: 'PROVIDER_ERROR',
        provider: source.id,
        stage: 'ingest',
        retryable: false,
        cause: err,
      });
    }
  }
}

/** Short, model-readable reason for a failed source. */
export function failureReason(err: unknown): string {
  if (WebVectorError.is(err)) {
    const status = (err.details as { status?: number } | undefined)?.status;
    return `${err.code}${status ? ` ${status}` : ''}`;
  }
  if (err instanceof Error)
    return err.name === 'AbortError' ? 'ABORTED' : err.message.slice(0, 120);
  return String(err).slice(0, 120);
}

/** HTTP 404/410 — the resource does not exist (worth remembering briefly). */
export function isNotFound(err: unknown): boolean {
  const status = WebVectorError.is(err) ? (err.details as { status?: number })?.status : undefined;
  return status === 404 || status === 410;
}

export interface SourceTask {
  source: MarketSource;
  /** Do the work (pushing results into caller-owned arrays); report how many items came back. */
  run: (signal: AbortSignal) => Promise<{ count: number; fromCache?: boolean; stale?: boolean }>;
}

/**
 * Run source tasks concurrently under one deadline and report one `SourceRun` per source id
 * (a source that ran several times — one per symbol — is collapsed: counts summed, a partial
 * failure reported as `ok` with a reason, a total failure as `failed`/`timeout`). A slow or broken
 * source never fails the whole call; work still pending at the deadline is abandoned (its requests
 * are aborted through the shared signal and counted as `timeout`).
 */
export async function runSources(
  client: MarketsClient,
  tasks: SourceTask[],
  opts: { deadlineMs?: number; signal?: AbortSignal } = {},
): Promise<SourceRun[]> {
  const deadlineMs = opts.deadlineMs ?? client.policy.deadlineMs;
  const signal = withTimeout(deadlineMs, opts.signal);
  const t0 = Date.now();
  const runs = await Promise.all(
    tasks.map(async (t): Promise<SourceRun> => {
      const en = client.enabled(t.source);
      if (!en.ok) return { id: t.source.id, status: 'skipped', count: 0, reason: en.reason };
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<SourceRun>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              id: t.source.id,
              status: 'timeout',
              count: 0,
              ms: deadlineMs,
              reason: `deadline ${deadlineMs}ms`,
            }),
          deadlineMs,
        );
      });
      const work = t.run(signal).then(
        (r): SourceRun => ({
          id: t.source.id,
          status: r.stale ? 'stale' : r.fromCache ? 'cached' : 'ok',
          count: r.count,
          ms: Date.now() - t0,
        }),
        (err): SourceRun => {
          client.opts.logger?.debug(`markets: ${t.source.id} failed (${failureReason(err)})`);
          const timedOut = signal.aborted && !opts.signal?.aborted;
          return {
            id: t.source.id,
            status: timedOut ? 'timeout' : 'failed',
            count: 0,
            ms: Date.now() - t0,
            reason: timedOut ? `deadline ${deadlineMs}ms` : failureReason(err),
          };
        },
      );
      return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
    }),
  );
  return mergeRuns(runs, tasks);
}

function mergeRuns(runs: SourceRun[], tasks: SourceTask[]): SourceRun[] {
  const order = new Map(tasks.map((t, i) => [t.source.id, i]));
  const groups = new Map<string, SourceRun[]>();
  for (const r of runs) groups.set(r.id, [...(groups.get(r.id) ?? []), r]);
  const out: SourceRun[] = [];
  for (const [id, rs] of groups) {
    if (rs.length === 1) {
      out.push(rs[0] as SourceRun);
      continue;
    }
    const bad = rs.filter((r) => r.status === 'failed' || r.status === 'timeout');
    const good = rs.filter(
      (r) => r.status === 'ok' || r.status === 'cached' || r.status === 'stale',
    );
    const count = rs.reduce((n, r) => n + r.count, 0);
    const ms = Math.max(...rs.map((r) => r.ms ?? 0));
    if (!good.length && bad.length) {
      const last = bad[bad.length - 1] as SourceRun;
      out.push({ id, status: last.status, count, ms, reason: last.reason });
    } else if (good.length) {
      const status = good.some((r) => r.status === 'ok')
        ? 'ok'
        : good.some((r) => r.status === 'stale')
          ? 'stale'
          : 'cached';
      out.push({
        id,
        status,
        count,
        ms,
        reason: bad.length
          ? `${bad.length}/${rs.length} failed (${bad[bad.length - 1]?.reason})`
          : undefined,
      });
    } else out.push({ ...(rs[0] as SourceRun), count });
  }
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}
