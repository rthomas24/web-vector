#!/usr/bin/env node
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import {
  autoEmbeddingProviderName,
  CONFIG_FILENAMES,
  CONFIG_SCHEMA_URL,
  CONFIG_SCHEMA_YAML_MODELINE,
  configJsonSchema,
  createEmbeddingProvider,
  createSearchProvider,
  defaultDataDir,
  envKeyFor,
  envUrlFor,
  expandHome,
  findConfigFile,
  hasLocalRuntime,
  listEmbeddingProviders,
  listSearchProviders,
  listVectorStores,
  loadConfig,
  openCacheDb,
  PROVIDER_KEY_ENV,
  PROVIDER_URL_ENV,
  probeRuntime,
  redactConfig,
  resolveCacheDir,
  SEMANTIC_UPGRADE_HINT,
  WebVector,
  type WebVectorConfig,
  WebVectorError,
} from 'webvector';
import {
  DEFAULT_LOCAL_MODEL,
  defaultModelCacheDir,
  LOCAL_MODEL_ALIASES,
} from 'webvector/embeddings';

const VERSION = '0.1.0';
const program = new Command();
program
  .name('webvector')
  .description(
    'WebVector — search → read full pages → embed → cited passages, from the command line.',
  )
  .version(VERSION)
  .option('-c, --config <path>', 'config file (default: nearest webvector.config.*)')
  .option('--no-config', 'ignore config files')
  .option('--log-level <level>', 'silent|error|warn|info|debug');

function globalOverrides(): { overrides: WebVectorConfig; configFile: string | false | undefined } {
  const o = program.opts();
  const overrides: WebVectorConfig = {};
  if (o.logLevel) overrides.logging = { level: o.logLevel };
  return { overrides, configFile: o.config === false ? false : o.config };
}

/** Parse durations like `90s`, `15m`, `2h`, `7d` (or plain ms) into milliseconds. */
export function parseDuration(v: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?\s*$/i.exec(v);
  if (!m)
    throw new WebVectorError(`Invalid duration "${v}" (use e.g. 30s, 15m, 2h, 7d)`, {
      code: 'INVALID_CONFIG',
    });
  const n = Number(m[1]);
  const unit = (m[2] ?? 'ms').toLowerCase();
  const mult =
    { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit] ?? 1;
  return Math.round(n * mult);
}

/** Cache flags shared by search/fetch: --max-age <dur>, --no-cache (bypass), --cache-only. */
function cacheOptions(opts: { maxAge?: string; cache?: boolean; cacheOnly?: boolean }) {
  return {
    maxAgeMs: opts.maxAge ? parseDuration(opts.maxAge) : undefined,
    cacheMode: opts.cacheOnly
      ? ('readOnly' as const)
      : opts.cache === false
        ? ('bypass' as const)
        : undefined,
  };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
function fmtAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}
/** Writable check for a directory that may not exist yet (walks up to the nearest ancestor). */
function isWritableDir(dir: string): boolean {
  let d = dir;
  for (let i = 0; i < 32; i++) {
    if (existsSync(d)) {
      try {
        accessSync(d, constants.W_OK);
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    }
    const parent = dirname(d);
    if (parent === d) return false;
    d = parent;
  }
  return false;
}
/** Local model files present in the Transformers.js cache (offline readiness). */
function localModelPresent(model: string, cacheDir: string): { present: boolean; dir: string } {
  const resolvedModel = LOCAL_MODEL_ALIASES[model.toLowerCase()] ?? model;
  const dir = join(cacheDir, resolvedModel);
  try {
    const walk = (d: string, depth: number): boolean => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isFile() && /\.onnx$/.test(e.name)) return true;
        if (e.isDirectory() && depth < 3 && walk(join(d, e.name), depth + 1)) return true;
      }
      return false;
    };
    return { present: existsSync(dir) && walk(dir, 0), dir };
  } catch {
    return { present: false, dir };
  }
}

function fail(err: unknown): never {
  const e = WebVectorError.from(err, { code: 'INTERNAL' });
  console.error(`\n✖ ${e.code}: ${e.message}`);
  if (e.remediation) console.error(`  → ${e.remediation}`);
  if (process.env.WEBVECTOR_DEBUG && e.cause) console.error(e.cause);
  process.exit(1);
}

program
  .command('search <query>')
  .description('Research a query: search → fetch pages → embed → cited passages')
  .option('-k, --top-k <n>', 'passages to return', (v) => Number(v))
  .option('-p, --pages <n>', 'max pages to fetch', (v) => Number(v))
  .option('-r, --related <queries...>', 'related queries to widen retrieval')
  .option('-f, --freshness <period>', 'day|week|month|year')
  .option('--allow <domains...>', 'only these domains')
  .option('--block <domains...>', 'exclude these domains')
  .option('-s, --session <id>', 'session id (reuse ingested pages across calls)')
  .option('--provider <name>', 'search provider override')
  .option('--embeddings <name>', 'embedding provider override')
  .option('--model <name>', 'embedding model override')
  .option('--rerank [name]', 'rerank: local|cohere|voyage|jina')
  .option('--json', 'print JSON result')
  .option('--md', 'print markdown (default)')
  .option('--stats', 'print stage timings')
  .option('--explain', 'print a per-passage ranking breakdown (bm25/vector ranks, fused score)')
  .option('--max-age <duration>', 'accept cached pages at most this old (e.g. 2h, 7d)')
  .option('--no-cache', 'ignore cached pages (still fills the cache)')
  .option('--cache-only', 'serve only from the page cache, never fetch')
  .option('-q, --quiet', 'no progress output')
  .action(async (query: string, opts) => {
    const { overrides, configFile } = globalOverrides();
    if (opts.provider) overrides.search = { ...overrides.search, provider: opts.provider };
    if (opts.embeddings || opts.model)
      overrides.embeddings = {
        ...overrides.embeddings,
        ...(opts.embeddings ? { provider: opts.embeddings } : {}),
        ...(opts.model ? { model: opts.model } : {}),
      };
    if (opts.rerank !== undefined)
      overrides.retrieval = {
        ...overrides.retrieval,
        rerank: opts.rerank === true ? 'local' : opts.rerank,
      };
    try {
      const wv = await WebVector.create(overrides, { configFile });
      const t0 = Date.now();
      if (!opts.quiet && !opts.json) {
        const isTTY = process.stderr.isTTY;
        wv.on('progress', (p) => {
          if (isTTY)
            process.stderr.write(`\r\x1b[2K  ${p.stage.padEnd(9)} ${p.message.slice(0, 80)}`);
        });
        wv.on('stage', (s) =>
          process.stderr.write(`${isTTY ? '\r\x1b[2K' : ''}  ${s.stage.padEnd(9)} ${s.ms}ms\n`),
        );
      }
      const res = await wv.research(query, {
        topK: opts.topK,
        maxPages: opts.pages,
        relatedQueries: opts.related,
        freshness: opts.freshness,
        domainsAllow: opts.allow,
        domainsBlock: opts.block,
        sessionId: opts.session,
        rerank: opts.rerank !== undefined ? true : undefined,
        explain: opts.explain,
        ...cacheOptions(opts),
      });
      if (!opts.quiet && !opts.json) process.stderr.write('\n');
      if (opts.json) console.log(JSON.stringify(res, null, 2));
      else console.log(res.markdown);
      if (opts.explain && !opts.json) {
        console.error('\n#   fused     bm25  vec  pool  matched queries → source');
        for (const p of res.passages) {
          const e = p.explain;
          if (!e) continue;
          console.error(
            `${String(p.index).padStart(2)}  ${e.fused.toFixed(4).padStart(8)}  ${String(e.bm25Rank ?? '-').padStart(5)}  ${String(e.vectorRank ?? '-').padStart(3)}  ${String(e.poolRank).padStart(4)}  ${p.matchedQueries.map((q) => `"${q.slice(0, 24)}"`).join(', ')} → ${p.url}`,
          );
        }
      }
      if (opts.stats && !opts.json) {
        const s = res.stats;
        console.error(
          `\n— search ${s.search.provider} ${s.search.ms}ms · pages ${s.ingest.ok}/${s.ingest.requested} ${s.ingest.ms}ms · embed ${s.embed.chunks} chunks (${s.embed.provider}/${s.embed.model}) ${s.embed.ms}ms · retrieve ${s.retrieve.candidates} cands ${s.retrieve.ms}ms · total ${Date.now() - t0}ms`,
        );
        const u = s.usage;
        if (u)
          console.error(
            `  usage: search ${u.search.calls} call(s) · embed ${u.embed.requests} req / ${u.embed.texts} texts (${u.embed.cached} cached) · http ${u.http.requests} req, ${u.http.cacheHits} cache hits, ${u.http.notModified} 304, ${u.http.coalesced} coalesced, ${Math.round(u.http.bytes / 1024)} KiB${u.estimatedCostUsd !== undefined ? ` · est. $${u.estimatedCostUsd.toFixed(4)} (${u.pricingNote})` : ''}`,
          );
        if (s.warnings.length) console.error(`  warnings: ${s.warnings.join(' | ')}`);
      }
      await wv.close();
    } catch (err) {
      fail(err);
    }
  });

program
  .command('fetch <url>')
  .description('Fetch one URL as Markdown (optionally only passages relevant to --query)')
  .option('-q, --query <text>', 'return passages relevant to this query')
  .option('-k, --top-k <n>', 'passages', (v) => Number(v))
  .option('--max-age <duration>', 'accept a cached copy at most this old (e.g. 2h, 7d)')
  .option('--no-cache', 'ignore the cached copy (still fills the cache)')
  .option('--cache-only', 'serve only from the page cache, never fetch')
  .option('--json', 'print JSON')
  .action(async (url: string, opts) => {
    const { overrides, configFile } = globalOverrides();
    try {
      const wv = await WebVector.create(overrides, { configFile });
      const cache = cacheOptions(opts);
      if (opts.query) {
        const res = await wv.fetchAndRetrieve(url, opts.query, { topK: opts.topK, ...cache });
        console.log(opts.json ? JSON.stringify(res, null, 2) : res.markdown);
      } else {
        const doc = await wv.fetch(url, cache);
        console.log(
          opts.json
            ? JSON.stringify(doc, null, 2)
            : `# ${doc.title}\n<${doc.url}>\n\n${doc.markdown}`,
        );
      }
      await wv.close();
    } catch (err) {
      fail(err);
    }
  });

program
  .command('serp <query>')
  .description('Search only (no fetching)')
  .option('-n, --count <n>', 'results', (v) => Number(v))
  .option('--provider <name>', 'search provider override')
  .option('--json', 'print JSON')
  .action(async (query: string, opts) => {
    const { overrides, configFile } = globalOverrides();
    if (opts.provider) overrides.search = { provider: opts.provider };
    try {
      const wv = await WebVector.create(overrides, { configFile });
      const results = await wv.search(query, { count: opts.count });
      if (opts.json) console.log(JSON.stringify(results, null, 2));
      else
        for (const r of results)
          console.log(`${r.rank}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('config')
  .description('Print the resolved configuration (secrets redacted)')
  .option('--json', 'print JSON')
  .option('--schema', 'print the JSON Schema for config files instead')
  .action(async (opts) => {
    const { overrides, configFile } = globalOverrides();
    try {
      if (opts.schema) {
        console.log(JSON.stringify(configJsonSchema(), null, 2));
        return;
      }
      const resolved = await loadConfig({ configFile, overrides });
      const out = {
        configFile: resolved.configPath ?? '(none — defaults + env)',
        config: redactConfig(resolved.file),
      };
      if (opts.json) console.log(JSON.stringify(out, null, 2));
      else {
        console.log(`config file: ${out.configFile}`);
        const yaml = await import('yaml').catch(() => null);
        console.log(yaml ? yaml.stringify(out.config) : JSON.stringify(out.config, null, 2));
      }
    } catch (err) {
      fail(err);
    }
  });

// ─── init ────────────────────────────────────────────────────────────────────

interface InitAnswers {
  search: string;
  embeddings: string;
  store: 'memory' | 'sqlite';
  client: 'none' | 'claude-code' | 'claude-desktop' | 'cursor';
}

const SEARCH_CHOICES = [
  'duckduckgo',
  'brave',
  'serper',
  'serpapi',
  'tavily',
  'exa',
  'perplexity',
  'google-cse',
  'searxng',
];
const EMBED_CHOICES = [
  'auto',
  'none',
  'local',
  'openai',
  'gemini',
  'voyage',
  'cohere',
  'mistral',
  'jina',
  'ollama',
];

/** Defaults inferred from the environment (keys present, local runtime installed). */
async function initDefaults(env: NodeJS.ProcessEnv): Promise<InitAnswers> {
  const search =
    env.WEBVECTOR_SEARCH_PROVIDER ??
    SEARCH_CHOICES.find((p) => p !== 'duckduckgo' && p !== 'searxng' && envKeyFor(p, env)) ??
    (envUrlFor('searxng', env) ? 'searxng' : 'duckduckgo');
  const embeddings = env.WEBVECTOR_EMBEDDINGS_PROVIDER ?? (await autoEmbeddingProviderName()).name;
  const store: InitAnswers['store'] =
    embeddings === 'none' || embeddings === 'lexical' ? 'memory' : 'sqlite';
  return { search, embeddings, store, client: 'none' };
}

async function askInit(defaults: InitAnswers): Promise<InitAnswers> {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask = async (q: string, def: string, choices?: string[]): Promise<string> => {
    for (;;) {
      const a = (
        await rl.question(`${q}${choices ? ` [${choices.join('|')}]` : ''} (${def}): `)
      ).trim();
      if (!a) return def;
      if (!choices || choices.includes(a)) return a;
      process.stderr.write(`  please choose one of: ${choices.join(', ')}\n`);
    }
  };
  try {
    process.stderr.write('WebVector setup — press Enter to accept the detected defaults.\n');
    const search = await ask('Search provider', defaults.search, SEARCH_CHOICES);
    const embeddings = await ask(
      'Embeddings (auto = local model if installed, else a keyed provider, else lexical BM25)',
      defaults.embeddings,
      EMBED_CHOICES,
    );
    const store = (await ask(
      'Vector store (sqlite = persistent, zero dependencies; memory = per process)',
      embeddings === 'none' ? 'memory' : defaults.store,
      ['memory', 'sqlite'],
    )) as InitAnswers['store'];
    const client = (await ask('MCP client snippet to print', 'none', [
      'none',
      'claude-code',
      'claude-desktop',
      'cursor',
    ])) as InitAnswers['client'];
    return { search, embeddings, store, client };
  } finally {
    rl.close();
  }
}

function starterYaml(a: InitAnswers): string {
  const keyEnv = PROVIDER_KEY_ENV[a.search]?.[0];
  const embedKeyEnv = PROVIDER_KEY_ENV[a.embeddings]?.[0];
  return `${CONFIG_SCHEMA_YAML_MODELINE}
# WebVector configuration — https://github.com/rthomas24/web-vector/blob/main/docs/CONFIGURATION.md
# Precedence: code overrides > this file > environment variables > defaults.
# \${VAR} and \${VAR:-default} are interpolated from the environment. Every key is optional.

search:
  provider: ${a.search}${' '.repeat(Math.max(1, 14 - a.search.length))}# duckduckgo (keyless) | brave | serper | serpapi | tavily | tavily-keyless | exa | perplexity | searxng | wikipedia
${keyEnv ? `  apiKey: \${${keyEnv}}` : `  # apiKey: \${BRAVE_API_KEY}`}
  resultsPerQuery: 10
  safeSearch: moderate
  fallbackProviders: [tavily-keyless, wikipedia]

embeddings:
  provider: ${a.embeddings}${' '.repeat(Math.max(1, 14 - a.embeddings.length))}# auto | none (lexical BM25, smallest install) | local (Transformers.js) | openai | openai-compatible | gemini | voyage | cohere | mistral | jina | ollama
${a.embeddings === 'local' || a.embeddings === 'auto' ? '  model: Xenova/all-MiniLM-L6-v2   # local presets: minilm (fast) | granite (quality) | embeddinggemma (best) | bge-small | nomic …' : '  # model: text-embedding-3-small'}
${embedKeyEnv ? `  apiKey: \${${embedKeyEnv}}` : `  # apiKey: \${OPENAI_API_KEY}`}
  # dimensions: 512             # Matryoshka truncation where supported
  cache: true                   # persist chunk embeddings in the page cache (never re-embed the same text)

store:
  provider: ${a.store}${' '.repeat(Math.max(1, 14 - a.store.length))}# memory | sqlite (persistent, zero deps) | chroma | qdrant | pgvector
  mode: ${a.store === 'sqlite' ? 'session' : 'ephemeral'}${' '.repeat(Math.max(1, 17 - (a.store === 'sqlite' ? 7 : 9)))}# ephemeral (per call) | session (reuse by sessionId, TTL) | persistent (survives restarts)
  # url: ~/.local/share/webvector/store.sqlite
  # collection: webvector
  sessionTtlMs: 1800000

retrieval:
  topK: 12
  queryExpansion: true
  maxExpandedQueries: 4
  hybrid: true                  # BM25 + vectors fused (relative score fusion)
  maxPerSource: 3
  mmr: true
  rerank: false                 # false | local | cohere | voyage | jina

ingestion:
  maxPages: 10
  maxConcurrentFetches: 8
  timeoutMs: 15000
  respectRobotsTxt: true
  chunkSize: 480
  chunkOverlap: 60
  cache:
    dir: auto                   # auto (~/.cache/webvector/pages.sqlite) | a directory | false (memory only)
    ttlMs: 900000               # 15 min; stale pages are revalidated with ETag / Last-Modified

output:
  markdown: true
  maxPassageChars: 1500

telemetry:
  pricing: false                # true → stats.usage.estimatedCostUsd (an estimate from docs/pricing.json)

logging:
  level: warn
`;
}

function starterJson(a: InitAnswers): string {
  const cfg = {
    $schema: CONFIG_SCHEMA_URL,
    search: { provider: a.search },
    embeddings: { provider: a.embeddings, cache: true },
    store: { provider: a.store, mode: a.store === 'sqlite' ? 'session' : 'ephemeral' },
    ingestion: { cache: { dir: 'auto' } },
    logging: { level: 'warn' },
  };
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

function mcpSnippet(client: InitAnswers['client'], a: InitAnswers): string | undefined {
  const envLines: Record<string, string> = {};
  const k = PROVIDER_KEY_ENV[a.search]?.[0];
  if (k) envLines[k] = '<your key>';
  const ek = PROVIDER_KEY_ENV[a.embeddings]?.[0];
  if (ek) envLines[ek] = '<your key>';
  const args =
    a.embeddings === 'local' || a.embeddings === 'auto'
      ? ['-y', '-p', '@huggingface/transformers', '-p', 'webvector-mcp', 'webvector-mcp']
      : ['-y', 'webvector-mcp'];
  const json = JSON.stringify(
    {
      mcpServers: {
        webvector: {
          command: 'npx',
          args,
          ...(Object.keys(envLines).length ? { env: envLines } : {}),
        },
      },
    },
    null,
    2,
  );
  switch (client) {
    case 'claude-code':
      return `Claude Code:\n  claude mcp add webvector -- npx ${args.join(' ')}`;
    case 'claude-desktop':
      return `Claude Desktop — add to claude_desktop_config.json:\n${json}`;
    case 'cursor':
      return `Cursor — add to ~/.cursor/mcp.json:\n${json}`;
    default:
      return undefined;
  }
}

program
  .command('init')
  .description(
    'Write a commented starter config (webvector.config.yaml + .env.example). Interactive on a TTY; --yes accepts detected defaults',
  )
  .option('-y, --yes', 'no questions: use defaults detected from the environment')
  .option('-f, --force', 'overwrite existing files')
  .option('--json', 'write webvector.config.json (with "$schema") instead of YAML')
  .option('--search <provider>', 'search provider (skips the question)')
  .option('--embeddings <provider>', 'embeddings provider (skips the question)')
  .option('--store <memory|sqlite>', 'vector store (skips the question)')
  .option('--client <none|claude-code|claude-desktop|cursor>', 'print an MCP client snippet')
  .action(async (opts) => {
    try {
      const cfgPath = resolve(opts.json ? 'webvector.config.json' : 'webvector.config.yaml');
      if (existsSync(cfgPath) && !opts.force) {
        console.error(`${cfgPath} already exists (use --force to overwrite)`);
        process.exit(1);
      }
      const defaults = await initDefaults(process.env);
      let answers: InitAnswers = {
        ...defaults,
        ...(opts.search ? { search: opts.search } : {}),
        ...(opts.embeddings ? { embeddings: opts.embeddings } : {}),
        ...(opts.store ? { store: opts.store } : {}),
        ...(opts.client ? { client: opts.client } : {}),
      };
      const interactive =
        !opts.yes && process.stdin.isTTY && process.stderr.isTTY && !process.env.CI;
      if (interactive) answers = await askInit(answers);
      writeFileSync(cfgPath, opts.json ? starterJson(answers) : starterYaml(answers));
      const envPath = resolve('.env.example');
      if (!existsSync(envPath) || opts.force) writeFileSync(envPath, STARTER_ENV);
      console.log(`✔ wrote ${cfgPath}\n✔ wrote ${envPath}`);
      console.log(
        `  search=${answers.search} embeddings=${answers.embeddings} store=${answers.store} · schema: ${CONFIG_SCHEMA_URL}`,
      );
      const snippet = mcpSnippet(answers.client, answers);
      if (snippet) console.log(`\n${snippet}`);
      console.log('\nNext: `webvector doctor` then `webvector search "your question"`');
    } catch (err) {
      fail(err);
    }
  });

program
  .command('doctor')
  .description('Diagnose configuration, dependencies, caches and provider connectivity')
  .option('--live', 'also run a live search + embedding probe')
  .option('--fix', 'create missing cache/store directories and download the local model')
  .option('--json', 'machine-readable output ({ ok, checks: [{status, check, message}] })')
  .action(async (opts) => {
    const { overrides, configFile } = globalOverrides();
    let ok = true;
    const report: { status: string; check: string; message: string }[] = [];
    const line = (status: 'ok' | 'warn' | 'fail' | 'info', msg: string, check?: string) => {
      const icon = { ok: '✔', warn: '⚠', fail: '✖', info: '·' }[status];
      if (status === 'fail') ok = false;
      report.push({ status, check: check ?? msg.split(':')[0]?.trim() ?? '', message: msg });
      if (!opts.json) console.log(`${icon} ${msg}`);
    };
    const finish = (): never => {
      if (opts.json) console.log(JSON.stringify({ ok, checks: report }, null, 2));
      else console.log(ok ? '\nAll checks passed.' : '\nSome checks failed — see above.');
      process.exit(ok ? 0 : 1);
    };
    // Node + runtime capabilities
    const [maj, min] = process.versions.node.split('.').map(Number);
    if ((maj as number) > 22 || ((maj as number) === 22 && (min as number) >= 12))
      line('ok', `Node ${process.versions.node}`, 'node');
    else line('fail', `Node ${process.versions.node} — WebVector requires Node ≥ 22.12`, 'node');
    const rt = await probeRuntime();
    line(
      rt.sqlite ? 'ok' : 'warn',
      `runtime: ${rt.runtime} · node:sqlite ${rt.sqlite ? 'available' : 'unavailable (caches memory-only, sqlite store → memory)'} · SSRF guard ${rt.ssrfMode}${rt.sqliteExperimentalWarning ? ' · Node 22 prints an ExperimentalWarning for node:sqlite (filtered by WebVector; MCP stdout stays clean)' : ''}`,
      'runtime',
    );
    if (rt.ssrfMode !== 'connect-time')
      line(
        'warn',
        `SSRF: connect-time guard unavailable on this runtime — ${rt.ssrfMode} checks only (DNS-rebinding window). Prefer Node ≥ 22.12 for untrusted URLs.`,
        'ssrf',
      );
    // Config
    let resolved: Awaited<ReturnType<typeof loadConfig>> | undefined;
    try {
      resolved = await loadConfig({ configFile, overrides });
      line('ok', `config: ${resolved.configPath ?? 'no config file (defaults + env)'}`, 'config');
    } catch (err) {
      line('fail', `config invalid: ${(err as Error).message}`, 'config');
      return finish();
    }
    const cfg = resolved.file;
    // Page / embedding cache
    const cacheDir = resolveCacheDir(cfg.ingestion.cache.dir);
    if (!cfg.ingestion.cache.enabled)
      line('info', 'cache: disabled (ingestion.cache.enabled: false)', 'cache');
    else if (!cacheDir) line('info', 'cache: memory only (ingestion.cache.dir: false)', 'cache');
    else if (!rt.sqlite)
      line('warn', `cache: ${cacheDir} — node:sqlite unavailable, memory only`, 'cache');
    else {
      if (opts.fix && !existsSync(cacheDir)) {
        try {
          mkdirSync(cacheDir, { recursive: true });
          line('ok', `cache: created ${cacheDir}`, 'cache');
        } catch (err) {
          line('fail', `cache: cannot create ${cacheDir}: ${(err as Error).message}`, 'cache');
        }
      }
      const exists = existsSync(join(cacheDir, 'pages.sqlite'));
      const writable = isWritableDir(cacheDir);
      const db = exists ? await openCacheDb({ dir: cacheDir, readOnly: true }) : undefined;
      const st = db?.stats();
      db?.close();
      line(
        writable ? 'ok' : 'warn',
        `cache: ${join(cacheDir, 'pages.sqlite')} — ${exists ? `${st?.pages.count ?? 0} pages, ${st?.embeddings.count ?? 0} embeddings, ${fmtBytes(st?.fileBytes ?? 0)}` : 'not created yet'}${writable ? '' : ` — NOT writable${opts.fix ? '' : ' (run with --fix or set ingestion.cache.dir)'}`}${cfg.embeddings.cache ? '' : ' · embedding cache off'}`,
        'cache',
      );
    }
    // Search
    const sp = cfg.search.provider;
    line('info', `search provider: ${sp}  (available: ${listSearchProviders().join(', ')})`);
    try {
      const p = createSearchProvider(sp, {
        apiKey: cfg.search.apiKey,
        baseUrl: cfg.search.baseUrl,
        cx: cfg.search.cx,
      });
      const caps = p.capabilities();
      line(
        'ok',
        `${sp}: ${caps.keyless ? 'keyless' : 'API key present'}${caps.supportsFreshness ? ', freshness' : ''}${caps.supportsDomainFilter ? ', domain filters' : ''}`,
      );
    } catch (err) {
      const e = WebVectorError.from(err, { code: 'INTERNAL' });
      line('fail', `${sp}: ${e.message}${e.remediation ? ` → ${e.remediation}` : ''}`);
    }
    for (const fb of cfg.search.fallbackProviders) {
      try {
        createSearchProvider(fb);
        line('info', `fallback ${fb}: ready`);
      } catch {
        line('info', `fallback ${fb}: not configured (skipped)`);
      }
    }
    // Embeddings
    let ep = cfg.embeddings.provider;
    if (ep === 'auto') {
      const auto = await autoEmbeddingProviderName();
      ep = auto.name;
      line('info', `embeddings provider: auto → ${ep} (${auto.reason})`);
    } else
      line(
        'info',
        `embeddings provider: ${ep}  (available: ${listEmbeddingProviders().join(', ')})`,
      );
    if (ep === 'none' || ep === 'lexical') {
      line(
        'ok',
        'lexical-only mode: full pages are ranked with BM25 (no embeddings, smallest install)',
      );
      line('info', SEMANTIC_UPGRADE_HINT);
    } else if (ep === 'local' || ep === 'transformers') {
      if (await hasLocalRuntime()) {
        const model = cfg.embeddings.model ?? DEFAULT_LOCAL_MODEL;
        const modelCache = cfg.embeddings.cacheDir ?? defaultModelCacheDir();
        line(
          'ok',
          `@huggingface/transformers installed; model ${model} (cache: ${modelCache})`,
          'embeddings',
        );
        let m = localModelPresent(model, modelCache);
        if (!m.present && opts.fix) {
          try {
            const t0 = Date.now();
            const e = createEmbeddingProvider('local', {
              model: cfg.embeddings.model,
              cacheDir: cfg.embeddings.cacheDir,
              dtype: cfg.embeddings.dtype,
            });
            await e.init?.();
            await e.embed(['warm-up'], { kind: 'query' });
            m = localModelPresent(model, modelCache);
            line('ok', `local model downloaded in ${Date.now() - t0}ms`, 'model');
          } catch (err) {
            line('fail', `local model download failed: ${(err as Error).message}`, 'model');
          }
        }
        line(
          m.present ? 'ok' : 'warn',
          m.present
            ? `local model files present (${m.dir}) — offline ready`
            : `local model not downloaded yet (${m.dir}) — first run downloads it${opts.fix ? '' : '; `webvector doctor --fix` downloads now'}`,
          'model',
        );
      } else {
        line(
          'fail',
          `embeddings.provider is "local" but @huggingface/transformers is not installed. ${SEMANTIC_UPGRADE_HINT} Or set embeddings.provider: none for lexical mode.`,
        );
      }
    } else {
      const key = cfg.embeddings.apiKey ?? envKeyFor(ep);
      const url = cfg.embeddings.baseUrl ?? envUrlFor(ep);
      if (['ollama', 'openai-compatible', 'lmstudio'].includes(ep))
        line('ok', `${ep}: baseUrl ${url ?? '(default)'}`);
      else if (key) line('ok', `${ep}: API key present`);
      else
        line(
          'fail',
          `${ep}: no API key — set ${(PROVIDER_KEY_ENV[ep] ?? ['embeddings.apiKey']).join(' or ')}`,
        );
    }
    // Store
    line(
      'info',
      `store: ${cfg.store.provider} (${cfg.store.mode})  (available: ${listVectorStores().join(', ')})`,
    );
    if (cfg.store.provider === 'sqlite') {
      const raw = cfg.store.url ?? envUrlFor('sqlite');
      const path = raw ? expandHome(raw) : join(defaultDataDir(), 'store.sqlite');
      if (!rt.sqlite) line('warn', 'sqlite store: node:sqlite unavailable → memory store', 'store');
      else {
        const dir = dirname(path);
        if (opts.fix && !existsSync(dir)) {
          try {
            mkdirSync(dir, { recursive: true });
          } catch {
            /* reported below */
          }
        }
        const writable = isWritableDir(dir);
        let size = 0;
        try {
          size = statSync(path).size;
        } catch {
          /* not created yet */
        }
        line(
          writable ? 'ok' : 'warn',
          `sqlite store: ${path} — ${size ? fmtBytes(size) : 'not created yet'}${writable ? '' : ' — NOT writable'}${cfg.store.options?.vec ? ' · sqlite-vec requested' : ''}`,
          'store',
        );
        if (cfg.store.options?.vec) {
          try {
            await import('sqlite-vec' as string);
            line('ok', 'sqlite-vec installed', 'store');
          } catch {
            line(
              'warn',
              'sqlite-vec not installed (npm i sqlite-vec) — JS cosine will be used',
              'store',
            );
          }
        }
      }
    } else if (cfg.store.provider !== 'memory') {
      const url = cfg.store.url ?? envUrlFor(cfg.store.provider);
      line(
        url ? 'ok' : 'warn',
        `${cfg.store.provider}: url ${url ?? `not set (${(PROVIDER_URL_ENV[cfg.store.provider] ?? []).join(' / ')})`}`,
      );
      const dep = { chroma: 'chromadb', qdrant: '@qdrant/js-client-rest', pgvector: 'pg pgvector' }[
        cfg.store.provider
      ];
      if (dep) {
        try {
          for (const d of dep.split(' ')) await import(d);
          line('ok', `${dep} installed`);
        } catch {
          line('fail', `${cfg.store.provider} requires: npm i ${dep}`);
        }
      }
    }
    // Rerank
    if (cfg.retrieval.rerank)
      line(
        'info',
        `rerank: ${cfg.retrieval.rerank === true ? 'local' : cfg.retrieval.rerank}${cfg.retrieval.rerankModel ? ` (${cfg.retrieval.rerankModel})` : ''}`,
      );
    // Optional deps
    for (const [pkg, purpose] of [
      ['gpt-tokenizer', 'exact token counting'],
      ['defuddle', 'extra HTML extraction fallback'],
    ]) {
      try {
        await import(pkg as string);
        line('info', `${pkg}: installed (${purpose})`);
      } catch {
        line('info', `${pkg}: not installed (optional — ${purpose})`);
      }
    }
    // Live probes
    if (opts.live) {
      console.log('\nLive probes:');
      try {
        const t0 = Date.now();
        const p = createSearchProvider(sp, {
          apiKey: cfg.search.apiKey,
          baseUrl: cfg.search.baseUrl,
          cx: cfg.search.cx,
        });
        const r = await p.search('webvector open source web research', { count: 3 });
        line(
          r.length ? 'ok' : 'warn',
          `search ${sp}: ${r.length} results in ${Date.now() - t0}ms${r[0] ? ` (e.g. ${r[0].url})` : ''}`,
        );
      } catch (err) {
        const e = WebVectorError.from(err, { code: 'INTERNAL' });
        line(
          'fail',
          `search ${sp}: ${e.code} ${e.message}${e.remediation ? ` → ${e.remediation}` : ''}`,
        );
      }
      if (ep === 'none' || ep === 'lexical')
        line('info', 'embeddings: lexical mode — no embedding probe');
      else
        try {
          const t0 = Date.now();
          const e = createEmbeddingProvider(ep, {
            model: cfg.embeddings.model,
            apiKey: cfg.embeddings.apiKey,
            baseUrl: cfg.embeddings.baseUrl,
            dimensions: cfg.embeddings.dimensions,
            cacheDir: cfg.embeddings.cacheDir,
          });
          await e.init?.();
          const [v] = await e.embed(['hello world'], { kind: 'query' });
          line('ok', `embeddings ${ep}/${e.model}: ${v?.length} dims in ${Date.now() - t0}ms`);
        } catch (err) {
          const er = WebVectorError.from(err, { code: 'INTERNAL' });
          line(
            'fail',
            `embeddings ${ep}: ${er.code} ${er.message}${er.remediation ? ` → ${er.remediation}` : ''}`,
          );
        }
      // SSRF/robots sanity
      try {
        const wv = await WebVector.create(overrides, { configFile });
        const t0 = Date.now();
        const doc = await wv.fetch('https://example.com/');
        line(
          'ok',
          `fetch example.com: "${doc.title}" ${doc.markdown.length} chars in ${Date.now() - t0}ms`,
        );
        await wv.close();
      } catch (err) {
        line('warn', `fetch example.com failed: ${(err as Error).message}`);
      }
    }
    finish();
  });

// ─── cache management ────────────────────────────────────────────────────────

const cache = program
  .command('cache')
  .description('Inspect and manage the persistent page/embedding cache (pages.sqlite)');

async function openCacheForCli(readOnly: boolean) {
  const { overrides, configFile } = globalOverrides();
  const resolved = await loadConfig({ configFile, overrides });
  const dir = resolveCacheDir(resolved.file.ingestion.cache.dir);
  if (!dir) return { dir: undefined, db: undefined, cfg: resolved.file };
  const exists = existsSync(join(dir, 'pages.sqlite'));
  if (readOnly && !exists) return { dir, db: undefined, cfg: resolved.file };
  const db = await openCacheDb({ dir, readOnly: readOnly && exists });
  return { dir, db, cfg: resolved.file };
}

cache
  .command('stats')
  .description('Show cache location, size, page/embedding counts and top hosts')
  .option('--json', 'print JSON')
  .action(async (opts) => {
    try {
      const { dir, db, cfg } = await openCacheForCli(true);
      if (!dir) {
        console.log('cache: memory only (ingestion.cache.dir is false)');
        return;
      }
      if (!db) {
        const rt = await probeRuntime();
        console.log(
          opts.json
            ? JSON.stringify({ path: join(dir, 'pages.sqlite'), exists: false, sqlite: rt.sqlite })
            : `cache: ${join(dir, 'pages.sqlite')} — not created yet${rt.sqlite ? '' : ' (node:sqlite unavailable on this runtime)'}`,
        );
        return;
      }
      const st = db.stats();
      db.close();
      if (opts.json) {
        console.log(
          JSON.stringify(
            { ...st, ttlMs: cfg.ingestion.cache.ttlMs, embeddingCache: cfg.embeddings.cache },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`path        ${st.path}`);
      console.log(`file size   ${fmtBytes(st.fileBytes)}`);
      console.log(
        `pages       ${st.pages.count} (${fmtBytes(st.pages.markdownBytes)} markdown)${st.pages.oldestFetchedAt ? ` · oldest ${fmtAge(Date.now() - Date.parse(st.pages.oldestFetchedAt))} · newest ${fmtAge(Date.now() - Date.parse(st.pages.newestFetchedAt as string))}` : ''} · ttl ${fmtAge(cfg.ingestion.cache.ttlMs)}`,
      );
      console.log(
        `embeddings  ${st.embeddings.count} (${fmtBytes(st.embeddings.vectorBytes)})${st.embeddings.models.length ? ` — ${st.embeddings.models.map((m) => `${m.model}@${m.dims}/${m.dtype}: ${m.count}`).join(', ')}` : ''}${cfg.embeddings.cache ? '' : ' · embedding cache off'}`,
      );
      if (st.hosts.length)
        console.log(
          `hosts       ${st.hosts
            .slice(0, 10)
            .map((h) => `${h.host} (${h.count})`)
            .join(', ')}`,
        );
    } catch (err) {
      fail(err);
    }
  });

cache
  .command('ls')
  .description('List cached pages (most recently used first)')
  .option('-n, --limit <n>', 'rows', (v) => Number(v), 50)
  .option('--json', 'print JSON')
  .action(async (opts) => {
    try {
      const { db } = await openCacheForCli(true);
      if (!db) {
        console.log('(no cache database)');
        return;
      }
      const rows = db.listPages(opts.limit);
      db.close();
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      for (const r of rows)
        console.log(
          `${fmtAge(Date.now() - r.fetched_at).padStart(6)}  ${fmtBytes(r.md_bytes).padStart(9)}  ${r.etag || r.last_modified ? 'v' : ' '}  ${r.url}`,
        );
      if (!rows.length) console.log('(empty)');
    } catch (err) {
      fail(err);
    }
  });

cache
  .command('clear')
  .description('Delete cached pages and embeddings')
  .option('--pages-only', 'keep the embedding cache')
  .option('--embeddings-only', 'keep the page cache')
  .action(async (opts) => {
    try {
      const { db } = await openCacheForCli(false);
      if (!db) {
        console.log('(no cache database)');
        return;
      }
      const pages = opts.embeddingsOnly ? 0 : db.clearPages();
      const embeddings = opts.pagesOnly ? 0 : db.clearEmbeddings();
      db.vacuum();
      db.close();
      console.log(`✔ removed ${pages} page(s) and ${embeddings} embedding(s)`);
    } catch (err) {
      fail(err);
    }
  });

cache
  .command('prune')
  .description('Delete cached pages older than a duration (e.g. --older-than 7d)')
  .requiredOption('--older-than <duration>', 'e.g. 12h, 7d, 4w')
  .option('--embeddings', 'also prune embeddings older than the duration')
  .action(async (opts) => {
    try {
      const ms = parseDuration(opts.olderThan);
      const { db } = await openCacheForCli(false);
      if (!db) {
        console.log('(no cache database)');
        return;
      }
      const pages = db.prunePages(ms);
      const embeddings = opts.embeddings ? db.pruneEmbeddings(ms) : 0;
      db.vacuum();
      db.close();
      console.log(
        `✔ pruned ${pages} page(s)${opts.embeddings ? ` and ${embeddings} embedding(s)` : ''} older than ${opts.olderThan}`,
      );
    } catch (err) {
      fail(err);
    }
  });

program
  .command('mcp')
  .description('Run the MCP server (stdio by default)')
  .option('--http', 'Streamable HTTP instead of stdio')
  .option('--port <n>', 'port for --http', (v) => Number(v))
  .option('--host <host>', 'host for --http')
  .option('--allow-remote', 'bind beyond localhost (requires --token; put TLS/auth in front)')
  .option('--token <token>', 'bearer token for the HTTP endpoint (or WEBVECTOR_MCP_TOKEN)')
  .action(async (opts) => {
    try {
      const mcp = await import('webvector-mcp');
      if (opts.http) {
        const { close } = await mcp.serveWebVectorHttp({
          port: opts.port,
          host: opts.host,
          allowRemote: opts.allowRemote,
          token: opts.token ?? process.env.WEBVECTOR_MCP_TOKEN,
        });
        const shutdown = () => void close().finally(() => process.exit(0));
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      } else {
        const handle = mcp.serveWebVectorStdio();
        const shutdown = () => void Promise.resolve(handle.close()).finally(() => process.exit(0));
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        console.error('[webvector] MCP server on stdio');
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command('providers')
  .description('List built-in providers and the env vars they read')
  .action(() => {
    console.log(`Search providers:     ${listSearchProviders().join(', ')}`);
    console.log(`Embedding providers:  ${listEmbeddingProviders().join(', ')}`);
    console.log(`Vector stores:        ${listVectorStores().join(', ')}`);
    console.log(`Config files:         ${CONFIG_FILENAMES.join(', ')}`);
    console.log('\nAPI key env vars:');
    for (const [k, v] of Object.entries(PROVIDER_KEY_ENV))
      console.log(`  ${k.padEnd(18)} ${v.join(' | ')}`);
    console.log('URL env vars:');
    for (const [k, v] of Object.entries(PROVIDER_URL_ENV))
      console.log(`  ${k.padEnd(18)} ${v.join(' | ')}`);
    const f = findConfigFile();
    console.log(`\nNearest config file: ${f ?? '(none)'}`);
  });

const STARTER_ENV = `# Copy to .env (Node 22+: \`node --env-file=.env …\`). Only set what you use.
# Search (all optional — DuckDuckGo needs no key)
# BRAVE_API_KEY=
# SERPER_API_KEY=
# TAVILY_API_KEY=
# EXA_API_KEY=
# PERPLEXITY_API_KEY=
# SEARXNG_URL=http://localhost:8080
# Embeddings (optional — local model needs no key)
# OPENAI_API_KEY=
# GEMINI_API_KEY=
# VOYAGE_API_KEY=
# COHERE_API_KEY=
# MISTRAL_API_KEY=
# JINA_API_KEY=
# OLLAMA_HOST=http://127.0.0.1:11434
# Stores (optional)
# CHROMA_URL=http://localhost:8000
# QDRANT_URL=http://localhost:6333
# DATABASE_URL=postgres://user:pass@localhost:5432/db
# WebVector
# WEBVECTOR_SEARCH_PROVIDER=duckduckgo
# WEBVECTOR_EMBEDDINGS_PROVIDER=local
# WEBVECTOR_MODEL_CACHE=~/.cache/webvector/models
# WEBVECTOR_LOG_LEVEL=warn
`;

program.parseAsync(process.argv).catch(fail);
