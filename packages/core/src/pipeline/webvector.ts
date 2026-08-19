/**
 * WebVector — search → read full pages → embed → hybrid retrieval → cited passages, in one call.
 *
 * ```ts
 * const wv = new WebVector();                       // zero-config
 * const res = await wv.research('what is reciprocal rank fusion');
 * console.log(res.markdown);
 * ```
 *
 * This file is the orchestrator; each stage lives next to it:
 *   components.ts     builds providers/stores/fetcher from config
 *   search-stage.ts   stage 1: search + merge
 *   ingest-stage.ts   stages 2+3: fetch → chunk → embed → index (per page)
 *   retrieve-stage.ts stage 4: hybrid retrieval → passages
 *   format.ts         stage 5: markdown rendering
 */
import { configFromEnv } from '../config/env.js';
import {
  loadConfig,
  mergeConfig,
  type ResolvedConfig,
  validateConfig,
  type WebVectorConfig,
  type WebVectorFileConfig,
} from '../config/index.js';
import { WebVectorError } from '../errors.js';
import {
  approxTokens,
  assessProviderContent,
  type CachedPage,
  type CachePolicy,
  decodeBytes,
  documentFromProviderContent,
  ingestUrl,
  parseResource,
} from '../ingest/index.js';
import { RenderBudget, type RenderHook } from '../ingest/render.js';
import { assessEvidence } from '../retrieval/evidence.js';
import { sourcesFromPassages, type VerifyResult, verifyCitations } from '../retrieval/verify.js';
import { hostOf } from '../telemetry/otel.js';
import type {
  CacheMode,
  Failure,
  Logger,
  ParsedDocument,
  Passage,
  ProgressEvent,
  ResearchOptions,
  ResearchResult,
  ResearchStats,
  SearchCapabilities,
  SearchCategory,
  SearchOptions,
  SearchResult,
  SourceSummary,
  Stage,
  UsageStats,
} from '../types.js';
import { UsageMeter } from '../usage/meter.js';
import { estimateCostUsd, PRICING_NOTE, resolvePricing } from '../usage/pricing.js';
import { settleWithDeadline } from '../util/concurrency.js';
import { TypedEmitter, type WebVectorEvents } from '../util/events.js';
import { createLogger } from '../util/logger.js';
import { canonicalizeUrl } from '../util/url.js';
import { buildComponents, type Components } from './components.js';
import {
  excludeFromHtml,
  extractLinks,
  type FetchedDocument,
  type FetchOptions,
  selectFromHtml,
} from './fetch-options.js';
import { citationFor, type MarkdownRenderOptions, renderMarkdown } from './format.js';
import {
  type EmbedStats,
  failureFrom,
  ingestDocument,
  isFatalIngestError,
} from './ingest-stage.js';
import { type RetrieveOutput, registrableDomain, runRetrieveStage } from './retrieve-stage.js';
import { runSearchStage } from './search-stage.js';
import { ephemeralSession, type Session, type SessionRegistry } from './session.js';

export { mergeSearchResults } from './search-stage.js';

export interface WebVectorInitOptions {
  /** Load a config file (default: nearest webvector.config.* from cwd). Pass false to skip. */
  configFile?: string | false;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export class WebVector extends TypedEmitter<WebVectorEvents> {
  readonly config: WebVectorFileConfig;
  readonly codeConfig: WebVectorConfig;
  readonly logger: Logger;
  private components?: Promise<Components>;
  /** Passages of the latest research() per session key, for verifyCitations(). Small LRU. */
  private readonly recentPassages = new Map<string, Passage[]>();
  private closed = false;

  constructor(
    config: WebVectorConfig = {},
    opts: { env?: NodeJS.ProcessEnv; validated?: ResolvedConfig } = {},
  ) {
    super();
    if (opts.validated) {
      this.config = opts.validated.file;
      this.codeConfig = opts.validated.code;
    } else {
      this.codeConfig = mergeConfig(configFromEnv(opts.env ?? process.env), config);
      this.config = validateConfig(this.codeConfig);
    }
    this.logger = this.codeConfig.logger ?? createLogger(this.config.logging.level);
  }

  /** Create an instance resolving config from file + env + overrides. */
  static async create(
    overrides: WebVectorConfig = {},
    opts: WebVectorInitOptions = {},
  ): Promise<WebVector> {
    const resolved = await loadConfig({
      configFile: opts.configFile,
      cwd: opts.cwd,
      env: opts.env,
      overrides,
    });
    return new WebVector({}, { validated: resolved });
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────

  /** Build providers eagerly (loads local models, connects stores). research() does this lazily. */
  async init(): Promise<void> {
    await this.ensure();
  }

  async close(): Promise<void> {
    this.closed = true;
    const c = await this.components?.catch(() => undefined);
    c?.sessions.clear();
    await c?.sharedStore?.close?.();
    c?.embeddingCache.flush();
    c?.pageCache.database?.close();
    this.removeAllListeners();
  }

  private ensure(): Promise<Components> {
    if (!this.components) {
      this.components = buildComponents(this.config, this.codeConfig, this.logger);
      this.components.catch(() => {
        this.components = undefined;
      });
    }
    return this.components;
  }

  // ─── simple entry points ───────────────────────────────────────────────

  /** Search only (no fetching). */
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const c = await this.ensure();
    return c.search.search(query, { ...this.defaultSearchOptions(), ...opts });
  }

  /**
   * Fetch + parse one URL with the same guards as the pipeline (page cache with per-call policy,
   * single-flight). With `selector` / `excludeSelectors` / `includeLinks` the raw HTML is fetched
   * (page cache bypassed) and the DOM is filtered before conversion; `links` is filled when requested.
   */
  async fetch(url: string, opts: FetchOptions = {}): Promise<FetchedDocument> {
    const c = await this.ensure();
    const wantsRaw = !!(opts.selector || opts.excludeSelectors?.length || opts.includeLinks);
    if (!wantsRaw) {
      const outcome = await this.fetchOutcome(url, opts);
      if (!outcome.ok || !outcome.page) throw failureError(outcome.failure as Failure);
      return outcome.page.doc;
    }
    // Raw path: fetch, then filter/convert the HTML ourselves.
    const res = await c.fetcher.fetch(url, opts.signal);
    const isHtml =
      /^(text\/html|application\/xhtml\+xml)/.test(res.contentType) || res.contentType === '';
    let html: string | undefined;
    if (isHtml) html = decodeBytes(res.bytes, res.charset);
    let doc: ParsedDocument | undefined;
    if (html && opts.selector) {
      doc =
        selectFromHtml(html, res.finalUrl, opts.selector, {
          excludeSelectors: opts.excludeSelectors,
          contentType: res.contentType || 'text/html',
        }) ?? undefined;
      if (!doc)
        this.logger.debug(`selector "${opts.selector}" matched nothing on ${url}; falling back`);
    }
    if (!doc) {
      const filtered =
        html && opts.excludeSelectors?.length
          ? {
              ...res,
              bytes: new TextEncoder().encode(excludeFromHtml(html, opts.excludeSelectors)),
              charset: 'utf-8',
            }
          : res;
      const outcome = await parseResource(filtered, {
        parsers: c.parsers,
        cache: opts.excludeSelectors?.length ? undefined : c.pageCache,
        logger: this.logger,
      });
      if (!outcome.ok || !outcome.page) throw failureError(outcome.failure as Failure);
      doc = outcome.page.doc;
    }
    const out: FetchedDocument = { ...doc, url: res.url };
    if (opts.includeLinks && html) out.links = extractLinks(html, res.finalUrl, opts.maxLinks);
    else if (opts.includeLinks) out.links = [];
    return out;
  }

  /** ingestUrl through the page cache (per-call policy) and the single-flight coordinator. */
  private async fetchOutcome(url: string, opts: FetchOptions) {
    const c = await this.ensure();
    const policy = cachePolicyOf(opts);
    const canonical = canonicalizeUrl(url);
    return c.coordinator.ingest(
      canonical,
      () =>
        ingestUrl(url, {
          fetcher: c.fetcher,
          parsers: c.parsers,
          cache: opts.useCache === false ? undefined : c.pageCache,
          cachePolicy: policy,
          logger: this.logger,
          signal: opts.signal,
          fastPaths: this.config.ingestion.fastPaths,
          archiveFallback: this.config.ingestion.archiveFallback,
          render: this.renderHook(c),
        }),
      { bypassNegative: policy?.mode === 'bypass' },
    );
  }

  /** Fetch one URL and return only the passages relevant to `query`. */
  async fetchAndRetrieve(
    url: string,
    query: string,
    opts: FetchOptions & { topK?: number; explain?: boolean } = {},
  ): Promise<ResearchResult> {
    const c = await this.ensure();
    const meter = this.newMeter(c);
    return meter.run(() => this.doFetchAndRetrieve(c, meter, url, query, opts));
  }

  private async doFetchAndRetrieve(
    c: Components,
    meter: UsageMeter,
    url: string,
    query: string,
    opts: FetchOptions & { topK?: number; explain?: boolean },
  ): Promise<ResearchResult> {
    const t0 = Date.now();
    const outcome = await this.fetchOutcome(url, opts);
    if (!outcome.ok || !outcome.page) {
      const f = outcome.failure as Failure;
      throw new WebVectorError(f.message, {
        code: f.code as WebVectorError['code'],
        stage: 'ingest',
      });
    }
    const page = outcome.page;
    const doc = page.doc;
    this.countHttp(meter, outcome);
    const session = ephemeralSession(undefined, c.bm25Options);
    if (c.embedder) await session.store.init?.(c.dimensions, c.embedder.model);
    const { chunks, stats } = await ingestDocument(c, c.embeddingCache, {
      doc,
      page,
      query,
      session,
      chunking: this.chunkingOptions(),
      signal: opts.signal,
    });
    meter.usage.embed.cached += stats.cached;
    const warnings: string[] = [];
    const r = await runRetrieveStage(c, this.config.retrieval, {
      session,
      queries: [query],
      relatedQueries: [],
      searchResults: [],
      topK: opts.topK ?? 8,
      signal: opts.signal,
      warnings,
      explain: opts.explain,
      highlights: this.config.output.highlights,
    });
    const result: ResearchResult = {
      query,
      queries: [query],
      passages: r.passages,
      sources: [
        {
          url: doc.url,
          title: doc.title,
          status: outcome.cached ? 'cached' : 'ok',
          chunks: chunks.length,
          passageIndices: r.passages.map((p) => p.index),
          searchRank: 1,
          contentType: doc.contentType,
          fetchedAt: page.fetchedAt,
          bytes: page.bytes,
          fromCache: !!outcome.cached,
          revalidated: !!outcome.revalidated,
        },
      ],
      failures: [],
      stats: {
        search: { provider: 'none', attempts: [], resultCount: 0, ms: 0 },
        ingest: {
          requested: 1,
          fetched: outcome.cached ? 0 : 1,
          ok: 1,
          failed: 0,
          cached: outcome.cached ? 1 : 0,
          bytes: page.bytes,
          ms: outcome.ms,
        },
        embed: this.embedStats(c, stats),
        retrieve: { candidates: r.candidates, queries: 1, reranked: r.reranked, ms: 0 },
        totalMs: Date.now() - t0,
        warnings,
        http: meter.usage.http,
        usage: this.finishUsage(meter),
      },
    };
    result.markdown = renderMarkdown(result, this.renderOptions());
    result.stats.retrieve.tokensReturned = approxTokens(result.markdown);
    return result;
  }

  /** Resolved provider capabilities (builds providers on first call). */
  async capabilities(): Promise<{
    search: { id: string } & SearchCapabilities;
    embeddings?: { id: string; model: string; dimensions: number };
    reranker?: string;
    tier: 'lexical' | 'semantic';
  }> {
    const c = await this.ensure();
    return {
      search: { id: c.search.id, ...c.search.capabilities() },
      ...(c.embedder
        ? { embeddings: { id: c.embedder.id, model: c.embedder.model, dimensions: c.dimensions } }
        : {}),
      ...(c.reranker ? { reranker: c.reranker.id } : {}),
      tier: c.embedder ? 'semantic' : 'lexical',
    };
  }

  /** Sessions (store.mode: 'session' or an explicit sessionId). */
  async listSessions(): Promise<ReturnType<SessionRegistry['list']>> {
    return (await this.ensure()).sessions.list();
  }
  async clearSession(sessionId: string): Promise<boolean> {
    this.recentPassages.delete(sessionId);
    return (await this.ensure()).sessions.delete(sessionId);
  }

  /**
   * Quote-grounding check: classify each sentence of `answer` as verbatim / paraphrase /
   * unsupported / uncited against the passages its [n] markers cite — the passages of the latest
   * research() call in `sessionId` (or an explicit `passages` array), plus the whole pages when the
   * session still holds them. Numbers and dates absent from the sources are flagged. No LLM.
   */
  async verifyCitations(
    answer: string,
    opts: {
      sessionId?: string;
      passages?: Passage[];
      jaccardThreshold?: number;
      rougeThreshold?: number;
    } = {},
  ): Promise<VerifyResult> {
    const key = opts.sessionId ?? (this.config.store.mode === 'session' ? 'default' : undefined);
    const passages = opts.passages ?? (key ? this.recentPassages.get(key) : undefined);
    if (!passages?.length)
      throw new WebVectorError(
        'Nothing to verify against: pass `passages` from a research() result, or the `sessionId` of a prior research() call.',
        { code: 'INVALID_CONFIG' },
      );
    const pageText = new Map<string, string>();
    const session = key ? (await this.ensure()).sessions.get(key) : undefined;
    if (session) {
      const byUrl = new Map<string, { i: number; t: string }[]>();
      for (const ch of session.chunks.values()) {
        const arr = byUrl.get(ch.metadata.url) ?? [];
        arr.push({ i: ch.metadata.chunkIndex, t: ch.text });
        byUrl.set(ch.metadata.url, arr);
      }
      for (const [url, arr] of byUrl)
        pageText.set(
          url,
          arr
            .sort((a, b) => a.i - b.i)
            .map((x) => x.t)
            .join('\n'),
        );
    }
    return verifyCitations(answer, sourcesFromPassages(passages, pageText), {
      jaccardThreshold: opts.jaccardThreshold,
      rougeThreshold: opts.rougeThreshold,
    });
  }

  // ─── the main entry point ──────────────────────────────────────────────

  /** search → ingest → embed → retrieve → cited passages. Per-URL failures never throw. */
  async research(query: string, opts: ResearchOptions = {}): Promise<ResearchResult> {
    if (this.closed)
      throw new WebVectorError('WebVector instance is closed.', { code: 'INTERNAL' });
    query = query.trim();
    if (!query) throw new WebVectorError('Query must not be empty.', { code: 'INVALID_CONFIG' });
    const c = await this.ensure();
    const meter = this.newMeter(c);
    return c.otel.span(
      'execute_tool webvector_research',
      {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': 'webvector_research',
        'gen_ai.tool.type': 'function',
        'webvector.top_k': opts.topK,
        'webvector.max_pages': opts.maxPages,
        'webvector.session_id': opts.sessionId,
        ...(c.otel.captureContent ? { 'webvector.query': query } : {}),
      },
      async (span) => {
        const res = await meter.run(() => this.doResearch(c, meter, query, opts));
        span.set({
          'webvector.passages': res.passages.length,
          'webvector.sources.ok': res.stats.ingest.ok,
          'webvector.sources.failed': res.stats.ingest.failed,
          'webvector.degraded': res.degraded,
          'webvector.http.requests': res.stats.usage?.http.requests,
          'webvector.http.cache_hits': res.stats.usage?.http.cacheHits,
        });
        return res;
      },
    );
  }

  private async doResearch(
    c: Components,
    meter: UsageMeter,
    query: string,
    opts: ResearchOptions,
  ): Promise<ResearchResult> {
    const t0 = Date.now();
    const cfg = this.config;
    const cachePolicy = cachePolicyOf(opts);
    // Internal controller so the run deadline really cancels in-flight fetch/parse/embed work.
    const runAbort = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, runAbort.signal]) : runAbort.signal;
    const warnings: string[] = [];
    const failures: Failure[] = [];
    // Callers (including LLM tool arguments) may lower but never raise the operator's limits.
    const topK = Math.min(opts.topK ?? cfg.retrieval.topK, cfg.retrieval.topK);
    const maxPages = Math.min(opts.maxPages ?? cfg.ingestion.maxPages, cfg.ingestion.maxPages);
    const related = (opts.relatedQueries ?? [])
      .map((q) => q.trim())
      .filter((q) => q && q.toLowerCase() !== query.toLowerCase());
    const progress = (e: ProgressEvent) => {
      opts.onProgress?.(e);
      this.emit('progress', e);
    };
    const stageDone = (stage: Stage, ms: number) => this.emit('stage', { stage, ms });

    const session = this.resolveSession(opts.sessionId, c);
    if (c.embedder) await session.store.init?.(c.dimensions, c.embedder.model);
    if (!session.restored && c.sharedStore && !session.id.startsWith('ephemeral-')) {
      const n = await c.sessions.restore(session);
      if (n)
        this.logger.debug(`session ${session.id}: restored ${n} chunk(s) from ${c.sharedStore.id}`);
    }

    // ── 1. search ────────────────────────────────────────────────────────
    const ts = Date.now();
    progress({ stage: 'search', done: 0, total: 1, message: `Searching: ${query}` });
    this.emit('search:start', { queries: [query, ...related], provider: c.search.id });
    const searched = await c.otel.span(
      `search ${c.search.id}`,
      { 'webvector.search.provider': c.search.id, 'webvector.search.queries': 1 + related.length },
      async (span) => {
        const out = await runSearchStage(c, {
          query: categoryQuery(query, opts.category),
          related: related.map((q) => categoryQuery(q, opts.category)),
          maxPages,
          failures,
          options: {
            ...this.defaultSearchOptions(),
            count: Math.max(cfg.search.resultsPerQuery, Math.ceil(maxPages * 1.2)),
            freshness:
              opts.freshness ??
              cfg.search.freshness ??
              (opts.category === 'news' ? 'week' : undefined),
            ...(opts.country ? { country: opts.country } : {}),
            ...(opts.language ? { language: opts.language } : {}),
            domainsAllow: opts.domainsAllow,
            domainsBlock: opts.domainsBlock,
            signal,
          },
        });
        span.set({ 'webvector.search.results': out.results.length });
        return out;
      },
      'client',
    );
    const results = searched.results;
    meter.usage.search.calls += searched.attempts.length;
    const searchMs = Date.now() - ts;
    stageDone('search', searchMs);
    this.emit('search:complete', { results, ms: searchMs, provider: c.search.id });
    progress({ stage: 'search', done: 1, total: 1, message: `${results.length} results` });
    if (results.length === 0) warnings.push('Search returned no results.');

    // Retrieval-only query expansion (agent-supplied related queries were also searched above).
    let expanded: string[] = [];
    if (
      (opts.queryExpansion ?? cfg.retrieval.queryExpansion) &&
      cfg.retrieval.maxExpandedQueries > 0
    ) {
      try {
        expanded = await c.expander.expand(query, {
          searchResults: results,
          related,
          max: cfg.retrieval.maxExpandedQueries,
          signal,
        });
      } catch (err) {
        warnings.push(`Query expansion failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // ── 2+3. ingest → chunk → embed (streamed per page, global deadline) ─
    const ti = Date.now();
    const targets = results.slice(0, maxPages);
    const sources = new Map<string, SourceSummary>();
    const embedTotals: EmbedStats = { chunks: 0, cached: 0, batches: 0, ms: 0 };
    let bytes = 0;
    let okPages = 0;
    let cachedPages = 0;
    let done = 0;
    let batchTotal = targets.length;
    progress({
      stage: 'ingest',
      done: 0,
      total: targets.length,
      message: `Fetching ${targets.length} pages`,
    });

    const renderHook = this.renderHook(c);
    const ingestOne = async (r: SearchResult): Promise<void> => {
      const canonical = canonicalizeUrl(r.url);
      const summary: SourceSummary = {
        url: r.url,
        title: r.title,
        status: 'failed',
        chunks: 0,
        passageIndices: [],
        searchRank: r.rank,
      };
      sources.set(canonical, summary);
      try {
        if (session.urls.has(canonical)) {
          // Already ingested earlier in this session — nothing to fetch.
          summary.status = 'cached';
          summary.chunks = [...session.chunks.values()].filter(
            (ch) => ch.metadata.canonicalUrl === canonical,
          ).length;
          cachedPages++;
          okPages++;
          return;
        }
        this.emit('page:start', { url: r.url });
        const fetched = await this.fetchPage(c, r, signal, cachePolicy, meter, renderHook);
        if ('failure' in fetched) {
          failures.push(fetched.failure);
          summary.failure = fetched.failure;
          summary.ms = fetched.ms;
          this.emit('page:error', { url: r.url, failure: fetched.failure });
          return;
        }
        const { page, cachedHit, revalidated, ms } = fetched;
        bytes += page.bytes;
        Object.assign(summary, {
          contentType: page.doc.contentType,
          fetchedAt: page.fetchedAt,
          bytes: page.bytes,
          approxTokens: approxTokens(page.doc.markdown),
          title: page.doc.title || r.title,
          ms,
          fromCache: cachedHit,
          revalidated,
        });

        const { chunks, embedded, stats } = await ingestDocument(c, c.embeddingCache, {
          doc: { ...page.doc, url: r.url },
          page,
          result: r,
          query,
          session,
          chunking: this.chunkingOptions(),
          signal,
        });
        if (chunks.length === 0) {
          const f: Failure = {
            url: r.url,
            code: 'PARSE_EMPTY',
            message: 'Page produced no chunks',
            stage: 'ingest',
          };
          failures.push(f);
          summary.failure = f;
          return;
        }
        embedTotals.chunks += stats.chunks;
        embedTotals.cached += stats.cached;
        embedTotals.batches += stats.batches;
        embedTotals.ms += stats.ms;
        meter.usage.embed.cached += stats.cached;
        summary.status = cachedHit ? 'cached' : 'ok';
        summary.chunks = chunks.length;
        okPages++;
        if (cachedHit) cachedPages++;
        this.emit('page:complete', {
          url: r.url,
          doc: page.doc,
          ms,
          bytes: page.bytes,
          cached: cachedHit,
        });
        this.emit('embed:batch', { count: embedded, ms: stats.ms, cached: stats.cached });
      } catch (err) {
        const f = failureFrom(err, r.url);
        failures.push(f);
        summary.failure = f;
        this.emit('page:error', { url: r.url, failure: f });
        const e = WebVectorError.from(err, { code: 'FETCH_FAILED' });
        if (isFatalIngestError(e)) throw e;
      } finally {
        done++;
        const failedSoFar = done - okPages;
        progress({
          stage: 'ingest',
          done,
          total: batchTotal,
          failed: failedSoFar,
          message: `Fetched ${done}/${batchTotal}${failedSoFar ? ` (${failedSoFar} failed)` : ''}`,
        });
      }
    };

    const deadlineMs = Math.min(
      opts.deadlineMs ?? cfg.ingestion.totalDeadlineMs,
      cfg.ingestion.totalDeadlineMs,
    );
    let deadlineHits = 0;
    /** Ingest a batch of results under a deadline; per-URL failures are recorded, fatal ones thrown. */
    const ingestBatch = async (batch: SearchResult[], batchDeadlineMs: number): Promise<void> => {
      done = 0;
      batchTotal = batch.length;
      const settled = await settleWithDeadline(
        batch.map((r) =>
          ingestOne(r).then(
            () => undefined as unknown,
            (e) => e as unknown,
          ),
        ),
        batchDeadlineMs,
        () => 'deadline' as const,
        () => runAbort.abort(new Error('run deadline exceeded')), // stop orphaned work
      );
      let fatal: WebVectorError | undefined;
      settled.forEach((outcome, i) => {
        const url = batch[i]?.url ?? '';
        if (outcome === 'deadline') {
          deadlineHits++;
          const s = sources.get(canonicalizeUrl(url));
          if (s && s.status === 'failed' && !s.failure) {
            const f: Failure = {
              url,
              code: 'FETCH_TIMEOUT',
              message: `Deadline of ${batchDeadlineMs}ms exceeded`,
              stage: 'ingest',
            };
            s.failure = f;
            failures.push(f);
          }
        } else if (outcome instanceof Error && !fatal) {
          fatal = WebVectorError.from(outcome, { code: 'INTERNAL', stage: 'ingest' });
        }
      });
      if (fatal && isFatalIngestError(fatal)) {
        if (cfg.retrieval.fallbackToLexical && session.chunks.size) {
          warnings.push(`Embedding failed (${fatal.code}); falling back to lexical retrieval.`);
        } else throw fatal;
      }
    };
    await ingestBatch(targets, deadlineMs);
    let ingestMs = Date.now() - ti;
    stageDone('ingest', ingestMs);
    if (opts.signal?.aborted) throw new WebVectorError('Research aborted', { code: 'ABORTED' });

    // ── 4. retrieve ──────────────────────────────────────────────────────
    const tr = Date.now();
    progress({ stage: 'retrieve', done: 0, total: 1, message: 'Retrieving relevant passages' });
    let queries = dedupeStrings([query, ...related, ...expanded]);
    let passages: Passage[] = [];
    let candidates = 0;
    let reranked = false;
    let coverage: ResearchResult['coverage'];
    let degraded: ResearchResult['degraded'];
    let degradedReason: string | undefined;
    if (deadlineHits > 0) {
      degraded = 'partial';
      degradedReason = `deadline of ${deadlineMs}ms reached: ${deadlineHits} of ${targets.length} pages not fetched`;
      warnings.push(degradedReason);
    }
    const objectiveQuery = opts.objective ? objectiveTerms(opts.objective) : '';
    let signals: RetrieveOutput['signals'] | undefined;
    const retrieve = async (qs: string[]): Promise<void> => {
      const hasChunks =
        session.chunks.size > 0 || (c.sharedStore && (await session.store.size?.()) !== 0);
      if (!hasChunks) return;
      const r = await c.otel.span(
        'retrieval',
        { 'webvector.retrieve.queries': qs.length, 'webvector.retrieve.top_k': topK },
        async (span) => {
          const out = await runRetrieveStage(c, cfg.retrieval, {
            session,
            // The objective's top terms ride along as an extra low-weight list (expansionWeight);
            // it is not searched and not reported in result.queries.
            queries: objectiveQuery ? [...qs, objectiveQuery] : qs,
            relatedQueries: related,
            searchResults: results,
            topK,
            rerank: opts.rerank,
            signal,
            warnings,
            explain: opts.explain,
            highlights: cfg.output.highlights,
            freshness: opts.freshness ?? cfg.search.freshness,
          });
          span.set({
            'webvector.retrieve.candidates': out.candidates,
            'webvector.retrieve.passages': out.passages.length,
            'webvector.retrieve.reranked': out.reranked,
          });
          return out;
        },
      );
      passages = r.passages;
      candidates = r.candidates;
      reranked = r.reranked;
      coverage = r.coverage;
      signals = r.signals;
      if (r.lexicalOnly && c.embedder) {
        degraded = 'partial'; // configured lexical mode is not degraded
        degradedReason ??= 'embeddings unavailable; lexical retrieval only';
      }
    };
    await retrieve(queries);
    const assess = () =>
      assessEvidence(query, passages, {
        topK,
        signals,
        domainOf: registrableDomain,
        fallbackTexts: results.slice(0, 5).map((r) => `${r.title}. ${r.snippet ?? ''}`),
      });
    let evidence = assess();

    // ── 4b. auto-retry: one more search round with the suggested queries (same deadline) ──
    let autoRetryStats: ResearchStats['retrieve']['autoRetry'];
    const autoRetry = Math.min(1, opts.autoRetry ?? cfg.retrieval.autoRetry);
    const remaining = cfg.ingestion.totalDeadlineMs - (Date.now() - ti);
    if (
      autoRetry > 0 &&
      evidence.level !== 'strong' &&
      evidence.suggestedQueries.length &&
      remaining > 2000 &&
      !signal.aborted
    ) {
      const t2 = Date.now();
      const retryQueries = evidence.suggestedQueries.slice(0, 2);
      const levelBefore = evidence.level;
      let newPages = 0;
      try {
        const again = await runSearchStage(c, {
          query: retryQueries[0] as string,
          related: retryQueries.slice(1),
          maxPages,
          failures,
          options: {
            ...this.defaultSearchOptions(),
            count: Math.max(cfg.search.resultsPerQuery, Math.ceil(maxPages * 1.2)),
            freshness: opts.freshness ?? cfg.search.freshness,
            domainsAllow: opts.domainsAllow,
            domainsBlock: opts.domainsBlock,
            signal,
          },
        });
        searched.attempts.push(...again.attempts);
        const fresh = again.results
          .filter((r) => !sources.has(canonicalizeUrl(r.url)))
          .slice(0, maxPages);
        newPages = fresh.length;
        for (const r of fresh) results.push(r);
        if (fresh.length) await ingestBatch(fresh, remaining - (Date.now() - t2));
        queries = dedupeStrings([...queries, ...retryQueries]);
        await retrieve(queries);
        evidence = assess();
      } catch (err) {
        warnings.push(`Auto-retry failed: ${err instanceof Error ? err.message : err}`);
      }
      autoRetryStats = {
        queries: retryQueries,
        newPages,
        levelBefore,
        levelAfter: evidence.level,
        ms: Date.now() - t2,
      };
      ingestMs = Date.now() - ti;
    }
    if (
      passages.length === 0 &&
      okPages === 0 &&
      cfg.output.includeSnippetsOnFailure &&
      results.length
    ) {
      degraded = 'search_only';
      passages = snippetPassages(results.slice(0, topK), query);
      if (targets.length)
        failures.push({
          code: 'ALL_FETCHES_FAILED',
          message: 'No pages could be fetched; returning search snippets.',
          stage: 'ingest',
        });
    }
    if (cfg.output.order === 'date-asc' && passages.length > 1) passages = orderByDate(passages);
    for (const p of passages) {
      const s = sources.get(canonicalizeUrl(p.url));
      if (s) {
        s.passageIndices.push(p.index);
        s.bestScore = Math.max(s.bestScore ?? 0, p.score);
      }
    }
    const retrieveMs = Date.now() - tr;
    stageDone('retrieve', retrieveMs);
    this.emit('retrieve:complete', { candidates, ms: retrieveMs });
    progress({ stage: 'retrieve', done: 1, total: 1, message: `${passages.length} passages` });

    // ── 5. format ────────────────────────────────────────────────────────
    const result: ResearchResult = {
      query,
      queries,
      passages,
      sources: [...sources.values()].sort((a, b) => a.searchRank - b.searchRank),
      failures,
      stats: {
        search: {
          provider: c.search.id,
          attempts: searched.attempts,
          resultCount: results.length,
          ms: searchMs,
        },
        ingest: {
          requested: targets.length,
          fetched: targets.length - cachedPages,
          ok: okPages,
          failed: targets.length - okPages,
          cached: cachedPages,
          bytes,
          ms: ingestMs,
        },
        embed: this.embedStats(c, embedTotals),
        retrieve: {
          candidates,
          queries: queries.length,
          reranked,
          ms: retrieveMs,
          ...(autoRetryStats ? { autoRetry: autoRetryStats } : {}),
        },
        totalMs: Date.now() - t0,
        warnings,
        http: meter.usage.http,
        usage: this.finishUsage(meter),
      },
      degraded,
      degradedReason,
      sessionId: opts.sessionId,
      ...(coverage ? { coverage } : {}),
      evidence,
    };
    if (opts.markdown ?? cfg.output.markdown) {
      // Callers may tighten the operator's token budget, never loosen it.
      const budgets = [cfg.output.maxTokens, opts.maxOutputTokens].filter(
        (n): n is number => !!n && n > 0,
      );
      result.markdown = renderMarkdown(result, {
        ...this.renderOptions(),
        maxTokens: budgets.length ? Math.min(...budgets) : undefined,
        format: opts.responseFormat ?? cfg.output.format,
        relatedQueries: related,
      });
      result.stats.output = {
        chars: result.markdown.length,
        approxTokens: approxTokens(result.markdown),
      };
    }
    result.stats.retrieve.tokensReturned = approxTokens(
      result.markdown ?? passages.map((p) => p.text).join('\n\n'),
    );
    const sessionKey = opts.sessionId ?? (cfg.store.mode === 'session' ? 'default' : undefined);
    if (sessionKey) {
      this.recentPassages.delete(sessionKey);
      this.recentPassages.set(sessionKey, passages);
      if (this.recentPassages.size > 100)
        this.recentPassages.delete(this.recentPassages.keys().next().value as string);
    }
    stageDone('format', Date.now() - t0 - result.stats.totalMs);
    return result;
  }

  // ─── internals ─────────────────────────────────────────────────────────

  /** Get page content: provider-supplied text (Tavily/Exa) when allowed, else fetch + parse. */
  /** Render hook with a fresh per-run budget (undefined when ingestion.render is off). */
  private renderHook(c: Components): RenderHook | undefined {
    if (!c.render) return undefined;
    const rc = this.config.ingestion.render;
    return {
      provider: c.render,
      when: rc.when,
      budget: new RenderBudget(rc.maxPerRun),
      timeoutMs: rc.timeoutMs,
      allowPrivateNetworks: this.config.ingestion.allowPrivateNetworks,
    };
  }

  private async fetchPage(
    c: Components,
    r: SearchResult,
    signal: AbortSignal | undefined,
    cachePolicy: CachePolicy | undefined,
    meter: UsageMeter,
    render?: RenderHook,
  ): Promise<
    | { page: CachedPage; cachedHit: boolean; revalidated: boolean; ms: number }
    | { failure: Failure; ms: number }
  > {
    const mode = this.config.ingestion.useProviderContent;
    const content = mode && typeof r.extra?.content === 'string' ? r.extra.content : undefined;
    let providerRejected = false;
    if (content) {
      // 'auto': quality gate (length, raw HTML, round-cap truncation, boilerplate); true: legacy length check.
      const verdict =
        mode === 'auto'
          ? assessProviderContent(content)
          : { ok: content.length > 400, reason: 'short' as const, chars: content.length };
      if (verdict.ok) {
        return {
          page: documentFromProviderContent(r.url, r.title, content),
          cachedHit: false,
          revalidated: false,
          ms: 0,
        };
      }
      providerRejected = true;
      this.logger.debug(
        `provider content for ${r.url} rejected (${verdict.reason}, ${verdict.chars} chars); fetching`,
      );
    }
    const outcome = await c.otel.span(
      `fetch ${hostOf(r.url)}`,
      {
        'server.address': hostOf(r.url),
        ...(c.otel.captureContent ? { 'url.full': r.url } : {}),
      },
      async (span) => {
        const o = await c.coordinator.ingest(
          canonicalizeUrl(r.url),
          () =>
            ingestUrl(r.url, {
              fetcher: c.fetcher,
              parsers: c.parsers,
              cache: c.pageCache,
              cachePolicy,
              logger: this.logger,
              signal,
              fastPaths: this.config.ingestion.fastPaths,
              archiveFallback: this.config.ingestion.archiveFallback,
              render,
            }),
          { bypassNegative: cachePolicy?.mode === 'bypass' },
        );
        span.set({
          'webvector.fetch.cache': o.revalidated ? 'revalidated' : o.cached ? 'hit' : 'miss',
          'webvector.fetch.coalesced': !!o.coalesced,
          'webvector.fetch.bytes': o.page?.bytes,
          'webvector.fetch.ok': o.ok,
          'error.type': o.failure?.code,
        });
        return o;
      },
      'client',
    );
    this.countHttp(meter, outcome);
    if (!outcome.ok || !outcome.page)
      return { failure: outcome.failure as Failure, ms: outcome.ms };
    let page = outcome.page;
    if (providerRejected) {
      page = {
        ...page,
        doc: {
          ...page.doc,
          parser: 'provider→fetch',
          metadata: { ...page.doc.metadata, fetchParser: page.doc.parser },
        },
      };
    }
    return {
      page,
      cachedHit: !!outcome.cached,
      revalidated: !!outcome.revalidated,
      ms: outcome.ms,
    };
  }

  private newMeter(c: Components): UsageMeter {
    return new UsageMeter({
      search: c.search.id,
      embedProvider: c.embedder?.id ?? 'none',
      embedModel: c.embedder?.model ?? 'bm25',
    });
  }

  /** Attribute one ingest outcome to the call's HTTP counters. */
  private countHttp(meter: UsageMeter, o: Awaited<ReturnType<typeof ingestUrl>>): void {
    const h = meter.usage.http;
    if (o.coalesced) return; // the request belongs to the call that started it
    if (o.revalidated) {
      h.requests++;
      h.notModified++;
    } else if (o.cached) h.cacheHits++;
    else if (o.ok || (o.failure && o.failure.code !== 'CACHE_MISS')) {
      h.requests++;
      if (o.page) h.bytes += o.page.bytes;
    }
  }

  /** Finalise a call's usage: optional cost estimate, then emit `usage`. */
  private finishUsage(meter: UsageMeter): UsageStats {
    const u = meter.usage;
    const pricing = this.config.telemetry.pricing;
    if (pricing) {
      const usd = estimateCostUsd(u, resolvePricing(pricing));
      if (usd !== undefined) {
        u.estimatedCostUsd = usd;
        u.pricingNote = PRICING_NOTE;
      }
    }
    this.emit('usage', u);
    return u;
  }

  private resolveSession(sessionId: string | undefined, c: Components): Session {
    const mode = this.config.store.mode;
    if (sessionId) return c.sessions.getOrCreate(sessionId);
    if (mode === 'persistent' && c.sharedStore) return c.sessions.getOrCreate('persistent');
    if (mode === 'session') return c.sessions.getOrCreate('default');
    return ephemeralSession(c.sharedStore, c.bm25Options);
  }

  private defaultSearchOptions(): SearchOptions {
    const s = this.config.search;
    return {
      count: s.resultsPerQuery,
      safeSearch: s.safeSearch,
      country: s.country,
      language: s.language,
      freshness: s.freshness,
    };
  }

  /** Render options derived from `output.*` config (format, link policy, deep links). */
  renderOptions(): MarkdownRenderOptions {
    const o = this.config.output;
    return {
      maxPassageChars: o.maxPassageChars,
      format: o.format,
      links: o.links,
      deepLinks: o.deepLinks,
      maxTokens: o.maxTokens || undefined,
      passageMode: o.passageMode,
      evidenceCards: o.evidenceCards,
    };
  }

  private chunkingOptions() {
    const i = this.config.ingestion;
    return {
      chunkSize: i.chunkSize,
      chunkOverlap: i.chunkOverlap,
      maxChunks: i.maxChunksPerPage,
      minChunkChars: i.minChunkChars,
      dropSharedBoilerplate: i.dropSharedBoilerplate,
    };
  }

  private embedStats(c: Components, s: EmbedStats) {
    return {
      provider: c.embedder?.id ?? 'none',
      model: c.embedder?.model ?? 'bm25',
      dimensions: c.dimensions,
      ...s,
    };
  }
}

function failureError(f: Failure): WebVectorError {
  return new WebVectorError(f.message, { code: f.code as WebVectorError['code'], stage: 'ingest' });
}

function cachePolicyOf(o: { maxAgeMs?: number; cacheMode?: CacheMode }): CachePolicy | undefined {
  if (o.maxAgeMs === undefined && !o.cacheMode) return undefined;
  return { maxAgeMs: o.maxAgeMs, mode: o.cacheMode };
}

/** Degraded output when nothing could be fetched: the search snippets themselves. */
function snippetPassages(results: SearchResult[], query: string): Passage[] {
  return results.map((r, i) => ({
    index: i + 1,
    text: r.snippet ?? r.title,
    url: r.url,
    title: r.title,
    score: Math.max(0.05, 1 - i / Math.max(1, results.length)),
    chunkIndex: 0,
    startOffset: 0,
    endOffset: (r.snippet ?? r.title).length,
    publishedAt: r.publishedAt,
    fetchedAt: new Date().toISOString(),
    matchedQueries: [query],
    citation: citationFor(i + 1, r.title, r.url),
    fromSnippet: true,
  }));
}

const CATEGORY_OPERATORS: Record<SearchCategory, string> = {
  pdf: 'filetype:pdf',
  github: 'site:github.com',
  research: '(arxiv OR doi OR paper)',
  docs: 'documentation',
  news: 'news',
};

/** Append the search-operator form of a category hint (providers without a native feature). */
export function categoryQuery(query: string, category?: SearchCategory): string {
  if (!category) return query;
  const op = CATEGORY_OPERATORS[category];
  return op && !query.toLowerCase().includes(op.toLowerCase()) ? `${query} ${op}` : query;
}

const STOP = new Set(
  'a an the and or but of to in on for with by from as at is are was were be been being it its this that these those i we you they he she them our your their my me us do does did doing have has had having not no so if then than about into over under between while which who whom whose what when where why how would could should can may might will shall just also very more most much many some any each other such only own same too s t don now want need find know tell'.split(
    ' ',
  ),
);

/**
 * Reduce a long-form objective to its most distinctive terms (max `n`), keeping identifiers,
 * versions and numbers, so it can join retrieval as one bounded query that cannot dominate BM25.
 */
export function objectiveTerms(objective: string, n = 12): string {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const raw of objective
    .slice(0, 2000)
    .toLowerCase()
    .split(/[^\p{L}\p{N}._\-/:]+/u)) {
    const w = raw.replace(/^[._\-/:]+|[._\-/:]+$/g, '');
    if (w.length < 2 || STOP.has(w)) continue;
    if (!counts.has(w)) order.push(w);
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const score = (w: string) =>
    (counts.get(w) ?? 0) + (/\d|[._\-/:]/.test(w) ? 1.5 : 0) + Math.min(w.length, 12) / 24;
  return order
    .sort((a, b) => score(b) - score(a))
    .slice(0, n)
    .join(' ');
}

/**
 * Oldest → newest (undated first), renumbering indices/citations so [n] markers stay consistent.
 * Newest-last keeps the freshest evidence closest to the model's answer.
 */
function orderByDate(passages: Passage[]): Passage[] {
  const key = (p: Passage) => (p.publishedAt ? Date.parse(p.publishedAt) || 0 : 0);
  return passages
    .slice()
    .sort((a, b) => key(a) - key(b) || a.index - b.index)
    .map((p, i) => ({
      ...p,
      index: i + 1,
      citation: citationFor(i + 1, p.title, p.url, p.publishedAt),
    }));
}

function dedupeStrings(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const k = s.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s.trim());
  }
  return out;
}
