import { lookup as dnsLookup } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { WebVectorError } from '../errors.js';

/** True when the IP is globally routable (allow-list approach: only `unicast`). */
export function isPublicIp(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return false;
  }
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) addr = v6.toIPv4Address();
    else if (v6.parts.slice(0, 6).every((p) => p === 0)) return false; // IPv4-compatible ::a.b.c.d (deprecated, block)
  }
  return addr.range() === 'unicast';
}

const BLOCKED_HOST_RE =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa|metadata\.google\.internal|instance-data)$/i;

export interface SsrfCheckOptions {
  allowPrivateNetworks?: boolean;
  /** Custom resolver (tests). */
  resolve?: (hostname: string) => Promise<string[]>;
}

/**
 * Validate a URL before fetching: scheme, hostname patterns, IP literal or DNS resolution to only
 * public addresses. Throws FETCH_BLOCKED_SSRF. Returns the resolved addresses (for logging).
 */
export async function assertSafeUrl(url: URL, opts: SsrfCheckOptions = {}): Promise<string[]> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw blocked(url, `unsupported scheme ${url.protocol}`);
  }
  if (opts.allowPrivateNetworks) return [];
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (BLOCKED_HOST_RE.test(host)) throw blocked(url, `hostname "${host}" is not allowed`);
  if (isIP(host)) {
    if (!isPublicIp(host)) throw blocked(url, `IP ${host} is not publicly routable`);
    return [host];
  }
  let addrs: string[];
  try {
    addrs = opts.resolve
      ? await opts.resolve(host)
      : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  } catch (err) {
    throw new WebVectorError(
      `DNS lookup failed for ${host}: ${err instanceof Error ? err.message : String(err)}`,
      {
        code: 'FETCH_FAILED',
        stage: 'ingest',
        retryable: true,
        cause: err,
      },
    );
  }
  if (addrs.length === 0)
    throw new WebVectorError(`DNS lookup returned no addresses for ${host}`, {
      code: 'FETCH_FAILED',
      stage: 'ingest',
    });
  const bad = addrs.find((a) => !isPublicIp(a));
  if (bad) throw blocked(url, `${host} resolves to non-public address ${bad}`);
  return addrs;
}

function blocked(url: URL, reason: string): WebVectorError {
  return new WebVectorError(`Blocked fetch of ${url.href}: ${reason}.`, {
    code: 'FETCH_BLOCKED_SSRF',
    stage: 'ingest',
    remediation:
      'Private/loopback/link-local targets are blocked by default (SSRF protection). Set `ingestion.allowPrivateNetworks: true` only for trusted local setups.',
  });
}

// ─── Connect-time guard (closes the DNS-rebinding TOCTOU) ────────────────────

type LookupCb = (err: NodeJS.ErrnoException | null, address: any, family?: number) => void;

/**
 * A `dns.lookup`-compatible resolver that refuses non-public addresses at *connect time*, so the
 * address that was checked is the address that gets dialled (no resolve-then-connect race).
 */
export function guardedLookup(opts: SsrfCheckOptions = {}) {
  return (hostname: string, options: any, cb: LookupCb): void => {
    const o = typeof options === 'number' ? { family: options } : (options ?? {});
    dnsLookup(hostname, { ...o, all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err, undefined);
      const list = Array.isArray(addrs)
        ? addrs
        : [{ address: String(addrs), family: o.family ?? 4 }];
      if (!opts.allowPrivateNetworks) {
        const bad = list.find((a) => !isPublicIp(a.address));
        if (bad) {
          const e: NodeJS.ErrnoException = new Error(
            `blocked non-public address ${bad.address} for ${hostname}`,
          );
          e.code = 'EBLOCKED_SSRF';
          return cb(e, undefined);
        }
      }
      if (o.all) return cb(null, list);
      cb(null, list[0]!.address, list[0]!.family);
    });
  };
}

/**
 * Build a fetch `dispatcher` (an undici Agent) that applies `guardedLookup` on every connection.
 * Uses Node's bundled undici (same version as global fetch) so no extra dependency is needed.
 * Returns undefined when it cannot be constructed (then callers fall back to the pre-check only).
 */
export async function createGuardedDispatcher(
  opts: SsrfCheckOptions & { connectTimeoutMs?: number } = {},
): Promise<unknown | undefined> {
  try {
    // The global dispatcher is created lazily on first fetch; touching a data: URL is enough.
    await fetch('data:,').catch(() => {});
    const g = globalThis as any;
    const global =
      g[Symbol.for('undici.globalDispatcher.2')] ?? g[Symbol.for('undici.globalDispatcher.1')];
    const Agent = global?.constructor;
    if (typeof Agent !== 'function') return undefined;
    return new Agent({
      connect: { lookup: guardedLookup(opts), timeout: opts.connectTimeoutMs ?? 10_000 },
    });
  } catch {
    return undefined;
  }
}

/** True when a fetch error was caused by the connect-time SSRF guard. */
export function isGuardedLookupError(err: unknown): boolean {
  let e: any = err;
  for (let i = 0; i < 4 && e; i++) {
    if (e.code === 'EBLOCKED_SSRF') return true;
    e = e.cause;
  }
  return false;
}
