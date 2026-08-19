import robotsParserModule from 'robots-parser';
import type { Logger } from '../types.js';

interface Robots {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
}
// robots-parser is CJS (`module.exports = fn`); Node ESM exposes it as the default export.
const robotsParser = ((robotsParserModule as any).default ?? robotsParserModule) as unknown as (
  url: string,
  txt: string,
) => Robots;

import { withTimeout } from '../util/concurrency.js';
import { LRU } from '../util/lru.js';
import { readCapped } from './fetcher.js';

interface Entry {
  robots: Robots | null; // null = allow all
  crawlDelayMs?: number;
}

export interface RobotsOptions {
  userAgent: string;
  /** Fetch implementation; the Fetcher passes its SSRF-guarded fetch. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Max robots.txt bytes read (default 512 KiB). */
  maxBytes?: number;
  timeoutMs?: number;
  ttlMs?: number;
  logger?: Logger;
}

/**
 * robots.txt cache + checker. Semantics (RFC 9309-ish): 4xx → allow all; 5xx/network → allow
 * (logged); parse errors → allow. `Crawl-delay` is exposed for the per-host queue.
 */
export class RobotsCache {
  private readonly cache: LRU<string, Promise<Entry>>;
  private readonly fetchImpl: NonNullable<RobotsOptions['fetch']>;
  private readonly ua: string;
  private readonly uaToken: string;
  constructor(private readonly opts: RobotsOptions) {
    this.cache = new LRU(1000, opts.ttlMs ?? 60 * 60_000);
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.ua = opts.userAgent;
    // robots groups match on the product token, e.g. "WebVector"
    this.uaToken = /WebVector/i.test(this.ua) ? 'WebVector' : this.ua.split(/[\s/]/)[0] || this.ua;
  }

  async check(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ allowed: boolean; crawlDelayMs?: number }> {
    const u = new URL(url);
    const origin = u.origin;
    let p = this.cache.get(origin);
    if (!p) {
      p = this.load(origin, signal);
      this.cache.set(origin, p);
      p.catch(() => this.cache.delete(origin));
    }
    const entry = await p;
    if (!entry.robots) return { allowed: true, crawlDelayMs: entry.crawlDelayMs };
    const allowed = entry.robots.isAllowed(url, this.uaToken);
    return { allowed: allowed !== false, crawlDelayMs: entry.crawlDelayMs };
  }

  private async load(origin: string, signal?: AbortSignal): Promise<Entry> {
    const robotsUrl = `${origin}/robots.txt`;
    try {
      const res = await this.fetchImpl(robotsUrl, {
        headers: { 'user-agent': this.ua, accept: 'text/plain,*/*;q=0.8' },
        // Never follow: a robots.txt redirect must not become a blind request to another host.
        redirect: 'manual',
        signal: withTimeout(this.opts.timeoutMs ?? 8000, signal),
      });
      if (res.status >= 300 && res.status < 500) return { robots: null };
      if (!res.ok) {
        this.opts.logger?.debug(`robots: ${robotsUrl} → HTTP ${res.status}; allowing`);
        return { robots: null };
      }
      const ct = res.headers.get('content-type') ?? '';
      if (ct && !/text\/plain/i.test(ct) && !ct.includes('octet-stream')) {
        // Some hosts serve HTML for robots.txt (misconfigured); ignore it.
        return { robots: null };
      }
      const bytes = await readCapped(res, this.opts.maxBytes ?? 512 * 1024, robotsUrl);
      const text = new TextDecoder().decode(bytes);
      const robots = robotsParser(robotsUrl, text);
      const delay = robots.getCrawlDelay(this.uaToken) ?? robots.getCrawlDelay('*');
      return {
        robots,
        crawlDelayMs:
          typeof delay === 'number' && delay > 0 ? Math.min(delay, 30) * 1000 : undefined,
      };
    } catch (err) {
      this.opts.logger?.debug(
        `robots: ${robotsUrl} failed (${err instanceof Error ? err.message : err}); allowing`,
      );
      return { robots: null };
    }
  }
}
