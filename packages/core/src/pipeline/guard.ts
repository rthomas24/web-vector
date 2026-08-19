/**
 * Operator guardrails applied around tool calls (MCP server flags, adapter options): a use budget,
 * allowed/blocked domains, and a user location passthrough. Bounds cost and exfiltration without
 * trusting the model — parity with the `max_uses` / `allowed_domains` / `blocked_domains` /
 * `user_location` knobs on Anthropic's and OpenAI's built-in web tools.
 */
import { WebVectorError } from '../errors.js';
import { hostnameOf, matchesDomain } from '../util/url.js';
import type { WebFetchInput, WebResearchInput, WebSearchInput } from './tool.js';

export interface UserLocation {
  /** ISO 3166-1 alpha-2, e.g. "US". */
  country?: string;
  /** BCP-47 language, e.g. "en" or "en-GB". */
  language?: string;
}

export interface ToolGuardOptions {
  /** Maximum research+fetch+search calls for the lifetime of the guard (process / adapter instance). */
  maxUses?: number;
  /** Only these domains (bare hosts; subdomains match) may be searched or fetched. */
  allowedDomains?: string[];
  /** These domains are never searched or fetched. */
  blockedDomains?: string[];
  /** Passed to the search provider as country/language. */
  userLocation?: UserLocation;
}

export const MAX_USES_EXCEEDED = 'MAX_USES_EXCEEDED';
export const DOMAIN_NOT_ALLOWED = 'DOMAIN_NOT_ALLOWED';

/** Parse "US", "US,en", "country=US;language=en", "US/en" into a UserLocation. */
export function parseUserLocation(s: string | undefined): UserLocation | undefined {
  if (!s) return undefined;
  const out: UserLocation = {};
  for (const part of s.split(/[,;/ ]+/).filter(Boolean)) {
    const [k, v] = part.includes('=')
      ? (part.split('=', 2) as [string, string])
      : [undefined, part];
    if (k === 'country' || (!k && /^[A-Za-z]{2}$/.test(v) && !out.country))
      out.country = v.toUpperCase();
    else if (k === 'language' || (!k && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(v)))
      out.language = v;
  }
  return out.country || out.language ? out : undefined;
}

/** Stateful guard: counts uses and enforces domain policy. */
export class ToolGuard {
  private used = 0;
  constructor(readonly opts: ToolGuardOptions = {}) {}

  get uses(): number {
    return this.used;
  }
  get remaining(): number | undefined {
    return this.opts.maxUses === undefined ? undefined : Math.max(0, this.opts.maxUses - this.used);
  }

  /** Count one use; throws MAX_USES_EXCEEDED (in-band error) once the budget is spent. */
  consume(): void {
    if (this.opts.maxUses !== undefined && this.used >= this.opts.maxUses) {
      throw new WebVectorError(
        `This server allows at most ${this.opts.maxUses} web tool calls per session; the budget is spent.`,
        {
          code: MAX_USES_EXCEEDED as WebVectorError['code'],
          remediation:
            'Answer from what you already have, or ask the operator to raise --max-uses / WEBVECTOR_MCP_MAX_USES.',
          retryable: false,
        },
      );
    }
    this.used++;
  }

  /** Domain filters for research/search: intersect allow-lists, union block-lists. */
  applyDomains<T extends Pick<WebResearchInput, 'domains_allow' | 'domains_block'>>(input: T): T {
    const { allowedDomains, blockedDomains } = this.opts;
    if (!allowedDomains?.length && !blockedDomains?.length) return input;
    let allow = input.domains_allow;
    if (allowedDomains?.length) {
      allow = allow?.length
        ? allow.filter((d) => matchesDomain(d.replace(/^\*\./, ''), allowedDomains))
        : allowedDomains;
      if (allow.length === 0) allow = ['__none__.invalid']; // caller asked only for disallowed domains → nothing
    }
    const block = [...(blockedDomains ?? []), ...(input.domains_block ?? [])];
    return { ...input, domains_allow: allow, ...(block.length ? { domains_block: block } : {}) };
  }

  /** Throws DOMAIN_NOT_ALLOWED when a URL to fetch is outside the policy. */
  assertUrlAllowed(url: string): void {
    const host = hostnameOf(url);
    const { allowedDomains, blockedDomains } = this.opts;
    const blocked =
      matchesDomain(host, blockedDomains) ||
      (allowedDomains?.length && !matchesDomain(host, allowedDomains));
    if (blocked) {
      throw new WebVectorError(`Fetching ${host} is not allowed by this server's domain policy.`, {
        code: DOMAIN_NOT_ALLOWED as WebVectorError['code'],
        remediation: allowedDomains?.length
          ? `Allowed domains: ${allowedDomains.join(', ')}.`
          : `Blocked domains: ${(blockedDomains ?? []).join(', ')}.`,
        retryable: false,
      });
    }
  }

  /** Search options implied by the user location. */
  searchLocation(): { country?: string; language?: string } {
    return { country: this.opts.userLocation?.country, language: this.opts.userLocation?.language };
  }
}

export type GuardedInput = WebResearchInput | WebFetchInput | WebSearchInput;
