/**
 * Runtime capability probe. WebVector runs on Node ≥ 22.12 but several features depend on what
 * the host actually provides:
 *   - `node:sqlite` (flag-free from 22.13; a non-functional stub on Cloudflare Workers) → the
 *     persistent page/embedding cache and the `sqlite` vector store; without it caches are
 *     memory-only (or the legacy JSON layout) and the store falls back to memory.
 *   - undici's global dispatcher (Node's built-in fetch) → the connect-time SSRF guard. Without it
 *     (Bun, Deno, edge runtimes, or an injected `fetch`) targets are still validated by hostname /
 *     resolved address before the request, but a DNS-rebinding race is possible — `doctor` warns.
 *   - `node:dns` → resolve-then-check SSRF mode.
 * Everything here is cheap and side-effect free apart from a lazy `import('node:sqlite')`.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface RuntimeCapabilities {
  runtime: 'node' | 'bun' | 'deno' | 'workerd' | 'unknown';
  nodeVersion: string;
  /** `node:sqlite` importable and functional (DatabaseSync present). */
  sqlite: boolean;
  /** Whether importing `node:sqlite` prints an ExperimentalWarning on this Node line (22.x). */
  sqliteExperimentalWarning: boolean;
  /** undici global dispatcher reachable → connect-time SSRF guard available. */
  undiciDispatcher: boolean;
  /** `node:dns` usable → resolve-then-check SSRF mode. */
  dns: boolean;
  /** SSRF protection level the fetcher can offer on this runtime. */
  ssrfMode: 'connect-time' | 'resolve-then-check' | 'hostname-only';
  warnings: string[];
}

type SqliteModule = typeof import('node:sqlite');
let sqlitePromise: Promise<SqliteModule | undefined> | undefined;

/**
 * Lazily import `node:sqlite`, swallowing the 22.x ExperimentalWarning for this feature only
 * (other warnings still surface). Resolves to undefined when the module is missing or a stub.
 */
export function importNodeSqlite(): Promise<SqliteModule | undefined> {
  if (!sqlitePromise) {
    sqlitePromise = (async () => {
      const original = process.emitWarning;
      const filtered: typeof process.emitWarning = function (this: unknown, warning, ...rest) {
        const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string })?.type;
        const msg = typeof warning === 'string' ? warning : warning?.message;
        const name = typeof warning === 'string' ? type : (warning?.name ?? type);
        if (name === 'ExperimentalWarning' && /sqlite/i.test(msg ?? '')) return;
        return (original as any).call(process, warning, ...rest);
      };
      try {
        process.emitWarning = filtered;
        const mod = (await import('node:sqlite')) as SqliteModule;
        if (typeof mod?.DatabaseSync !== 'function') return undefined;
        return mod;
      } catch {
        return undefined;
      } finally {
        if (process.emitWarning === filtered) process.emitWarning = original;
      }
    })();
  }
  return sqlitePromise;
}

function detectRuntime(): RuntimeCapabilities['runtime'] {
  const g = globalThis as any;
  if (typeof g.Bun !== 'undefined') return 'bun';
  if (typeof g.Deno !== 'undefined') return 'deno';
  if (
    typeof g.navigator?.userAgent === 'string' &&
    /Cloudflare-Workers/.test(g.navigator.userAgent)
  )
    return 'workerd';
  if (typeof process !== 'undefined' && process.versions?.node) return 'node';
  return 'unknown';
}

function nodeAtLeast(major: number, minor: number): boolean {
  const [maj = 0, min = 0] = (process.versions?.node ?? '0.0').split('.').map(Number);
  return maj > major || (maj === major && min >= minor);
}

/** Probe what this runtime can do. Cached per process. */
let probePromise: Promise<RuntimeCapabilities> | undefined;
export function probeRuntime(): Promise<RuntimeCapabilities> {
  if (!probePromise) probePromise = doProbe();
  return probePromise;
}

async function doProbe(): Promise<RuntimeCapabilities> {
  const runtime = detectRuntime();
  const nodeVersion = process.versions?.node ?? '';
  const warnings: string[] = [];
  let sqlite = false;
  if (runtime !== 'workerd') {
    const mod = await importNodeSqlite();
    if (mod) {
      try {
        const db = new mod.DatabaseSync(':memory:');
        db.exec('SELECT 1');
        db.close();
        sqlite = true;
      } catch {
        sqlite = false;
      }
    }
  }
  const [maj = 0] = nodeVersion.split('.').map(Number);
  const sqliteExperimentalWarning = sqlite && runtime === 'node' && maj === 22;
  let undiciDispatcher = false;
  try {
    await fetch('data:,').catch(() => {});
    const g = globalThis as any;
    const global =
      g[Symbol.for('undici.globalDispatcher.2')] ?? g[Symbol.for('undici.globalDispatcher.1')];
    undiciDispatcher = typeof global?.constructor === 'function';
  } catch {
    undiciDispatcher = false;
  }
  let dns = false;
  try {
    const mod = await import('node:dns/promises');
    dns = typeof mod.lookup === 'function';
  } catch {
    dns = false;
  }
  const ssrfMode = undiciDispatcher ? 'connect-time' : dns ? 'resolve-then-check' : 'hostname-only';
  if (!sqlite)
    warnings.push(
      `node:sqlite is unavailable on this runtime (${runtime} ${nodeVersion}) — page/embedding caches are memory-only and store.provider "sqlite" falls back to memory. Node ≥ 22.13 provides it without flags.`,
    );
  if (ssrfMode !== 'connect-time')
    warnings.push(
      `The connect-time SSRF guard needs Node's built-in fetch (undici dispatcher); this runtime only supports ${ssrfMode} checks, which leave a DNS-rebinding window. Prefer Node ≥ 22.12 for untrusted URLs.`,
    );
  if (runtime === 'node' && !nodeAtLeast(22, 12))
    warnings.push(`Node ${nodeVersion} is below the supported minimum (22.12).`);
  return {
    runtime,
    nodeVersion,
    sqlite,
    sqliteExperimentalWarning,
    undiciDispatcher,
    dns,
    ssrfMode,
    warnings,
  };
}

// ─── XDG base directories ────────────────────────────────────────────────────

function xdg(envVar: string, fallback: string[], env: NodeJS.ProcessEnv): string {
  const v = env[envVar];
  if (v && isAbsolute(v)) return v; // XDG spec: relative paths must be ignored
  return join(homedir(), ...fallback);
}

/** `$XDG_CACHE_HOME/webvector` (default `~/.cache/webvector`). */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(xdg('XDG_CACHE_HOME', ['.cache'], env), 'webvector');
}

/** `$XDG_DATA_HOME/webvector` (default `~/.local/share/webvector`). */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(xdg('XDG_DATA_HOME', ['.local', 'share'], env), 'webvector');
}

/** Expand a leading `~` (config values like `~/.local/share/webvector/store.sqlite`). */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}
