/**
 * Source-authority priors: small, text-independent multipliers on a passage's fused score based on
 * where it comes from. Two parts:
 *
 * 1. `sourcePriors` — glob → multiplier. Patterns without a `/` match the hostname (`*.gov`,
 *    `arxiv.org`, `*.wikipedia.org`); patterns with a `/` match `host/path`
 *    (e.g. `github.com/<owner>/<repo>/blob/<ref>/README*` written with `*` wildcards).
 *    Built-in defaults are deliberately tiny (≤ 1.1 up, ≥ 0.85 down) and every entry can be
 *    overridden or neutralised (`{ '*.pinterest.com': 1 }`) from config.
 * 2. `preferPrimary` — when the passage's registrable domain names something in the query
 *    (`nodejs.org` ↔ "node", `docs.python.org` ↔ "python", `sqlite.org` ↔ "sqlite"), it is very
 *    likely the primary source; boost it a little over mirrors and blogs with similar term stats.
 *
 * Multipliers are combined and clamped to [0.7, 1.3]; every applied multiplier is recorded in
 * `Passage.explain.multipliers` so it is never silent.
 */
import { tokenize } from './bm25.js';

/**
 * Conservative defaults (globs are matched case-insensitively; `*.host` also matches the apex).
 * Down-weights are a short list of aggregator / scraped-content hosts.
 */
export const BUILTIN_SOURCE_PRIORS: Readonly<Record<string, number>> = Object.freeze({
  '*.gov': 1.1,
  '*.edu': 1.1,
  '*.arxiv.org': 1.1,
  '*.wikipedia.org': 1.1,
  'github.com/*/*/blob/*/readme*': 1.1,
  '*.pinterest.com': 0.85,
  '*.scribd.com': 0.85,
  '*.slideshare.net': 0.85,
  '*.coursehero.com': 0.85,
  '*.chegg.com': 0.85,
  '*.answers.com': 0.85,
  '*.ehow.com': 0.85,
  '*.hubpages.com': 0.85,
  '*.ezinearticles.com': 0.85,
});

export interface CompiledPrior {
  glob: string;
  re: RegExp;
  /** true when the glob targets host/path rather than the hostname alone. */
  path: boolean;
  multiplier: number;
}

function globToRegExp(glob: string): RegExp {
  const esc = glob
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`);
}

/** Merge user priors over the built-ins (user wins) and compile the globs. */
export function compileSourcePriors(
  user: Record<string, number> = {},
  builtin: Readonly<Record<string, number>> = BUILTIN_SOURCE_PRIORS,
): CompiledPrior[] {
  const merged: Record<string, number> = { ...builtin, ...user };
  return Object.entries(merged)
    .filter(([, m]) => Number.isFinite(m) && m > 0 && m !== 1)
    .map(([glob, multiplier]) => {
      const g = glob.trim().replace(/^https?:\/\//, '');
      return { glob, re: globToRegExp(g), path: g.includes('/'), multiplier };
    });
}

/** Product of every matching prior for `url`, clamped to [0.7, 1.3]; lists the globs that matched. */
export function sourcePriorFor(
  url: string,
  priors: CompiledPrior[],
): { multiplier: number; matched: string[] } {
  let host: string;
  let hostPath: string;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    hostPath = host + u.pathname.toLowerCase();
  } catch {
    return { multiplier: 1, matched: [] };
  }
  let m = 1;
  const matched: string[] = [];
  for (const p of priors) {
    // `*.example.com` should also match the bare apex `example.com`.
    const target = p.path ? hostPath : host;
    const apex = !p.path && p.glob.startsWith('*.') ? p.glob.slice(2).toLowerCase() : undefined;
    if (p.re.test(target) || (apex !== undefined && target === apex)) {
      m *= p.multiplier;
      matched.push(p.glob);
    }
  }
  return { multiplier: Math.min(1.3, Math.max(0.7, m)), matched };
}

/**
 * Registrable-domain ↔ query-token match: the domain's main label (`nodejs` in `nodejs.org`,
 * `python` in `docs.python.org`) equals a query token, or starts with / contains a query token of
 * ≥ 4 chars (`nodejs` ↔ `node`; `sqlitetutorial` ↔ `sqlite` would match too — hence the small boost).
 */
export function isPrimaryFor(
  url: string,
  query: string,
  registrable: (url: string) => string,
): boolean {
  const domain = registrable(url);
  const label = domain.split('.')[0] ?? '';
  if (label.length < 3) return false;
  // Stopwords are already gone from tokenize(); keep both the stemmed token and its raw form.
  const tokens = new Set<string>();
  for (const t of tokenize(query)) tokens.add(t.replace(/[^a-z0-9]/g, ''));
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (label === t) return true;
    if (t.length >= 4 && (label.startsWith(t) || label.includes(t))) return true;
  }
  return false;
}
