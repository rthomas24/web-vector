import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importOptional, WebVectorError } from '../errors.js';
import { configFromEnv, stripUndefined } from './env.js';
import {
  type WebVectorConfig,
  type WebVectorFileConfig,
  webVectorFileConfigSchema,
} from './schema.js';

export { configFromEnv, envKeyFor, envUrlFor, PROVIDER_KEY_ENV, PROVIDER_URL_ENV } from './env.js';
export {
  CONFIG_DESCRIPTIONS,
  CONFIG_SCHEMA_URL,
  CONFIG_SCHEMA_YAML_MODELINE,
  configJsonSchema,
} from './json-schema.js';
export * from './schema.js';

/** Keys never copied from config objects (prototype pollution). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const EXECUTABLE_CONFIG = /\.(m?[jt]s|cjs|cts)$/;

export const CONFIG_FILENAMES = [
  'webvector.config.ts',
  'webvector.config.mts',
  'webvector.config.js',
  'webvector.config.mjs',
  'webvector.config.cjs',
  'webvector.config.json',
  'webvector.config.yaml',
  'webvector.config.yml',
  '.webvectorrc',
  '.webvectorrc.json',
  '.webvectorrc.yaml',
  '.webvectorrc.yml',
];

/** Interpolate `${VAR}` / `${VAR:-default}` in all string leaves. */
export function interpolateEnv<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === 'string') {
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (_m, name: string, def?: string) => {
        const v = env[name];
        return v !== undefined && v !== '' ? v : (def ?? '');
      },
    ) as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (UNSAFE_KEYS.has(k)) continue;
      out[k] = interpolateEnv(v, env);
    }
    return out as T;
  }
  return value;
}

/**
 * Find the nearest config file walking up from `cwd`.
 *
 * Security: JS/TS config files are *executed*, so they are only picked up from `cwd` itself (or an
 * explicit `configFile` path) — never discovered in parent directories, where a stray file could run
 * code when you invoke the CLI/MCP server inside an untrusted checkout. JSON/YAML are data and are
 * discovered up the tree like most tools do.
 */
export function findConfigFile(cwd = process.cwd()): string | undefined {
  const start = resolve(cwd);
  let dir = start;
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      if (EXECUTABLE_CONFIG.test(name) && dir !== start) continue;
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, 'utf8'));
        if (json.webvector && typeof json.webvector === 'object') return pkg;
      } catch {
        /* ignore */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Drop the editor-only `$schema` key (JSON configs may reference the published JSON Schema). */
function stripSchemaKey<T>(cfg: T): T {
  if (cfg && typeof cfg === 'object' && !Array.isArray(cfg) && '$schema' in cfg) {
    const { $schema: _ignored, ...rest } = cfg as Record<string, unknown>;
    return rest as T;
  }
  return cfg;
}

/** Load and parse a config file (json/yaml/js/ts). Returns the raw (unvalidated) object. */
export async function readConfigFile(path: string): Promise<WebVectorConfig> {
  const abs = resolve(path);
  if (abs.endsWith('package.json')) {
    const json = JSON.parse(readFileSync(abs, 'utf8'));
    return stripSchemaKey(json.webvector ?? {});
  }
  if (/\.(json|rc)$/.test(abs) || abs.endsWith('.webvectorrc')) {
    const text = readFileSync(abs, 'utf8');
    try {
      return stripSchemaKey(JSON.parse(text));
    } catch {
      // .webvectorrc may be YAML
      const yaml = await importOptional<typeof import('yaml')>('yaml', 'YAML config files');
      return stripSchemaKey(yaml.parse(text) ?? {});
    }
  }
  if (/\.ya?ml$/.test(abs)) {
    const yaml = await importOptional<typeof import('yaml')>('yaml', 'YAML config files');
    return stripSchemaKey(yaml.parse(readFileSync(abs, 'utf8')) ?? {});
  }
  // js / ts / mjs / cjs — dynamic import (Node 22.18+/24 strips types natively for .ts)
  const mod = await import(pathToFileURL(abs).href);
  const cfg = mod.default ?? mod.config ?? mod;
  return typeof cfg === 'function' ? await cfg() : cfg;
}

export interface LoadConfigOptions {
  /** Explicit config path; when omitted, searched from cwd upward. */
  configFile?: string | false;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Highest-precedence overrides (code). */
  overrides?: WebVectorConfig;
}

export interface ResolvedConfig {
  file: WebVectorFileConfig;
  code: WebVectorConfig;
  configPath?: string;
}

/** Deep merge where later sources win; arrays are replaced, not concatenated. */
export function mergeConfig(...sources: (WebVectorConfig | undefined)[]): WebVectorConfig {
  const out: Record<string, unknown> = {};
  for (const src of sources) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined || UNSAFE_KEYS.has(k)) continue;
      const cur = out[k];
      if (isPlainObject(v)) {
        // Recurse even without a counterpart so nested unsafe keys are stripped too.
        out[k] = mergeConfig(
          isPlainObject(cur) ? (cur as WebVectorConfig) : undefined,
          v as WebVectorConfig,
        );
      } else out[k] = v;
    }
  }
  return out as WebVectorConfig;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Resolve configuration: overrides (code) → config file → environment → defaults.
 * Returns validated file-style config plus the raw code config (which may hold instances).
 */
export async function loadConfig(opts: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const env = opts.env ?? process.env;
  let configPath: string | undefined;
  let fileCfg: WebVectorConfig = {};
  if (opts.configFile !== false) {
    configPath = opts.configFile ? resolve(opts.configFile) : findConfigFile(opts.cwd);
    if (configPath) {
      if (opts.configFile && !existsSync(configPath)) {
        throw new WebVectorError(`Config file not found: ${configPath}`, {
          code: 'INVALID_CONFIG',
          remediation: 'Check the path or run `webvector init` to create one.',
        });
      }
      fileCfg = interpolateEnv(await readConfigFile(configPath), env);
    }
  }
  const merged = mergeConfig(configFromEnv(env), fileCfg, opts.overrides);
  return { file: validateConfig(merged), code: merged, configPath };
}

/** Validate a merged config against the schema; strips non-serialisable instances first. */
export function validateConfig(cfg: WebVectorConfig): WebVectorFileConfig {
  const serialisable = JSON.parse(
    JSON.stringify(stripUndefined(cfg), (k, v) =>
      typeof v === 'function' ||
      k === 'instance' ||
      k === 'fallbackInstances' ||
      k === 'reranker' ||
      k === 'expander' ||
      k === 'llm' ||
      k === 'logger' ||
      k === 'fetch'
        ? undefined
        : v,
    ),
  );
  const parsed = webVectorFileConfigSchema.safeParse(serialisable);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new WebVectorError(`Invalid WebVector configuration: ${issues}`, {
      code: 'INVALID_CONFIG',
      remediation: 'Fix the listed keys. See docs/CONFIGURATION.md for every option and default.',
      details: parsed.error.issues,
    });
  }
  return parsed.data;
}

const SECRET_KEYS =
  /(api[-_]?key|apikey|token|secret|password|passwd|credential|authorization|^auth$|cookie)/i;
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)([^/@:]+):([^/@]+)@/i;

/** Redact secrets for printing (`webvector config`). */
export function redactConfig<T>(cfg: T): T {
  if (Array.isArray(cfg)) return cfg.map((v) => redactConfig(v)) as T;
  if (cfg && typeof cfg === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
      if (SECRET_KEYS.test(k) && typeof v === 'string' && v)
        out[k] = `${v.slice(0, 3)}…${v.slice(-2)} (redacted)`;
      else if (typeof v === 'string' && URL_USERINFO.test(v))
        out[k] = v.replace(URL_USERINFO, '$1$2:***@');
      else out[k] = redactConfig(v);
    }
    return out as T;
  }
  return cfg;
}
