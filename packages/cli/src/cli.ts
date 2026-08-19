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
  .action(async (opts) => {
    const { overrides, configFile } = globalOverrides();
    try {
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

program
  .command('init')
  .description('Write a starter webvector.config.yaml and .env.example into the current directory')
  .option('-f, --force', 'overwrite existing files')
  .action((opts) => {
    const cfgPath = resolve('webvector.config.yaml');
    if (existsSync(cfgPath) && !opts.force) {
      console.error(`${cfgPath} already exists (use --force to overwrite)`);
      process.exit(1);
    }
    writeFileSync(cfgPath, STARTER_CONFIG);
    const envPath = resolve('.env.example');
    if (!existsSync(envPath) || opts.force) writeFileSync(envPath, STARTER_ENV);
    console.log(
      `✔ wrote ${cfgPath}\n✔ wrote ${envPath}\nNext: \`webvector doctor\` then \`webvector search "your question"\``,
    );
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

const STARTER_CONFIG = `# WebVector configuration — https://github.com/rthomas24/web-vector
# Precedence: code overrides > this file > environment variables > defaults.
# \${VAR} and \${VAR:-default} are interpolated from the environment.

search:
  provider: duckduckgo          # duckduckgo (keyless) | brave | serper | serpapi | tavily | tavily-keyless | exa | perplexity | searxng | wikipedia
  # apiKey: \${BRAVE_API_KEY}
  resultsPerQuery: 10
  safeSearch: moderate
  fallbackProviders: [tavily-keyless, wikipedia]

embeddings:
  provider: auto                # auto | none (lexical BM25, smallest install) | local (Transformers.js) | openai | openai-compatible | gemini | voyage | cohere | mistral | jina | ollama
  model: Xenova/all-MiniLM-L6-v2   # local presets: minilm (fast) | granite (quality) | embeddinggemma (best) | bge-small | nomic …
  # apiKey: \${OPENAI_API_KEY}
  # dimensions: 512             # Matryoshka truncation where supported

store:
  provider: memory              # memory | chroma | qdrant | pgvector
  mode: ephemeral               # ephemeral | session | persistent
  # url: \${QDRANT_URL}
  # collection: webvector

retrieval:
  topK: 12
  queryExpansion: true
  maxExpandedQueries: 4
  hybrid: true                  # BM25 + vectors fused with RRF
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

output:
  markdown: true
  maxPassageChars: 1500

logging:
  level: warn
`;

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
