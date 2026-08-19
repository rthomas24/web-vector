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
import { EmbeddingCache } from '../embeddings/base.js';
import { WebVectorError } from '../errors.js';
import { type CachedPage, documentFromProviderContent, ingestUrl } from '../ingest/index.js';
import type {
  Failure,
  Logger,
  ParsedDocument,
  Passage,
  ProgressEvent,
  ResearchOptions,
  ResearchResult,
  SearchOptions,
  SearchResult,
  SourceSummary,
  Stage,
} from '../types.js';
import { settleWithDeadline } from '../util/concurrency.js';
import { TypedEmitter, type WebVectorEvents } from '../util/events.js';
import { sha256 } from '../util/hash.js';
import { createLogger } from '../util/logger.js';
import { canonicalizeUrl } from '../util/url.js';
import { buildComponents, type Components } from './components.js';
import { citationFor, renderMarkdown } from './format.js';
import {
  type EmbedStats,
  failureFrom,
  ingestDocument,
  isFatalIngestError,
} from './ingest-stage.js';
import { runRetrieveStage } from './retrieve-stage.js';
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
  private readonly embeddingCache = new EmbeddingCache();
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

  /** Fetch + parse one URL with the same guards as the pipeline. */
  async fetch(
    url: string,
    opts: { signal?: AbortSignal; useCache?: boolean } = {},
  ): Promise<ParsedDocument> {
    const c = await this.ensure();
    const outcome = await ingestUrl(url, {
      fetcher: c.fetcher,
      parsers: c.parsers,
      cache: opts.useCache === false ? undefined : c.pageCache,
      logger: this.logger,
      signal: opts.signal,
    });
    if (!outcome.ok || !outcome.page) {
      const f = outcome.failure as Failure;
      throw new WebVectorError(f.message, {
        code: f.code as WebVectorError['code'],
        stage: 'ingest',
      });
    }
    return outcome.page.doc;
  }

  /** Fetch one URL and return only the passages relevant to `query`. */
  async fetchAndRetrieve(
    url: string,
    query: string,
    opts: { topK?: number; signal?: AbortSignal; explain?: boolean } = {},
  ): Promise<ResearchResult> {
    const c = await this.ensure();
    const t0 = Date.now();
    const doc = await this.fetch(url, { signal: opts.signal });
    const session = ephemeralSession();
    if (c.embedder) await session.store.init?.(c.dimensions, c.embedder.model);
    const { chunks, stats } = await ingestDocument(c, this.embeddingCache, {
      doc,
      page: { pageHash: sha256(doc.markdown), fetchedAt: new Date().toISOString() },
      query,
      session,
      chunking: this.chunkingOptions(),
      signal: opts.signal,
    });
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
    });
    const result: ResearchResult = {
      query,
      queries: [query],
      passages: r.passages,
      sources: [
        {
          url: doc.url,
          title: doc.title,
          status: 'ok',
          chunks: chunks.length,
          passageIndices: r.passages.map((p) => p.index),
          searchRank: 1,
          contentType: doc.contentType,
        },
      ],
      failures: [],
      stats: {
        search: { provider: 'none', attempts: [], resultCount: 0, ms: 0 },
        ingest: { requested: 1, fetched: 1, ok: 1, failed: 0, cached: 0, bytes: 0, ms: 0 },
        embed: this.embedStats(c, stats),
        retrieve: { candidates: r.candidates, queries: 1, reranked: r.reranked, ms: 0 },
        totalMs: Date.now() - t0,
        warnings,
      },
    };
    result.markdown = renderMarkdown(result, {
      maxPassageChars: this.config.output.maxPassageChars,
    });
    return result;
  }

  /** Sessions (store.mode: 'session' or an explicit sessionId). */
  async listSessions(): Promise<ReturnType<SessionRegistry['list']>> {
    return (await this.ensure()).sessions.list();
  }
  async clearSession(sessionId: string): Promise<boolean> {
    return (await this.ensure()).sessions.delete(sessionId);
  }

  // ─── the main entry point ──────────────────────────────────────────────

  /** search → ingest → embed → retrieve → cited passages. Per-URL failures never throw. */
  async research(query: string, opts: ResearchOptions = {}): Promise<ResearchResult> {
    if (this.closed)
      throw new WebVectorError('WebVector instance is closed.', { code: 'INTERNAL' });
    query = query.trim();
    if (!query) throw new WebVectorError('Query must not be empty.', { code: 'INVALID_CONFIG' });

    const t0 = Date.now();
    const c = await this.ensure();
    const cfg = this.config;
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

    // ── 1. search ────────────────────────────────────────────────────────
    const ts = Date.now();
    progress({ stage: 'search', done: 0, total: 1, message: `Searching: ${query}` });
    this.emit('search:start', { queries: [query, ...related], provider: c.search.id });
    const searched = await runSearchStage(c, {
      query,
      related,
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
    const results = searched.results;
    const searchMs = Date.now() - ts;
    stageDone('search', searchMs);
    this.emit('search:complete', { results, ms: searchMs, provider: c.search.id });
    progress({ stage: 'search', done: 1, total: 1, message: `${results.length} results` });
    if (results.length === 0) warnings.push('Search returned no results.');

    // Retrieval-only query expansion (agent-supplied related queries were also searched above).
    let expanded: string[] = [];
    if (cfg.retrieval.queryExpansion && cfg.retrieval.maxExpandedQueries > 0) {
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
    progress({
      stage: 'ingest',
      done: 0,
      total: targets.length,
      message: `Fetching ${targets.length} pages`,
    });

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
        const fetched = await this.fetchPage(c, r, signal);
        if ('failure' in fetched) {
          failures.push(fetched.failure);
          summary.failure = fetched.failure;
          summary.ms = fetched.ms;
          this.emit('page:error', { url: r.url, failure: fetched.failure });
          return;
        }
        const { page, cachedHit, ms } = fetched;
        bytes += page.bytes;
        Object.assign(summary, {
          contentType: page.doc.contentType,
          fetchedAt: page.fetchedAt,
          bytes: page.bytes,
          title: page.doc.title || r.title,
          ms,
        });

        const { chunks, embedded, stats } = await ingestDocument(c, this.embeddingCache, {
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
        progress({
          stage: 'ingest',
          done,
          total: targets.length,
          message: `Fetched ${done}/${targets.length}`,
        });
      }
    };

    const settled = await settleWithDeadline(
      targets.map((r) =>
        ingestOne(r).then(
          () => undefined as unknown,
          (e) => e as unknown,
        ),
      ),
      cfg.ingestion.totalDeadlineMs,
      () => 'deadline' as const,
      () => runAbort.abort(new Error('run deadline exceeded')), // stop orphaned work
    );
    let fatal: WebVectorError | undefined;
    settled.forEach((outcome, i) => {
      const url = targets[i]?.url ?? '';
      if (outcome === 'deadline') {
        const s = sources.get(canonicalizeUrl(url));
        if (s && s.status === 'failed' && !s.failure) {
          const f: Failure = {
            url,
            code: 'FETCH_TIMEOUT',
            message: `Deadline of ${cfg.ingestion.totalDeadlineMs}ms exceeded`,
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
    const ingestMs = Date.now() - ti;
    stageDone('ingest', ingestMs);
    if (opts.signal?.aborted) throw new WebVectorError('Research aborted', { code: 'ABORTED' });

    // ── 4. retrieve ──────────────────────────────────────────────────────
    const tr = Date.now();
    progress({ stage: 'retrieve', done: 0, total: 1, message: 'Retrieving relevant passages' });
    const queries = dedupeStrings([query, ...related, ...expanded]);
    let passages: Passage[] = [];
    let candidates = 0;
    let reranked = false;
    let degraded: ResearchResult['degraded'];
    const hasChunks =
      session.chunks.size > 0 || (c.sharedStore && (await session.store.size?.()) !== 0);
    if (hasChunks) {
      const r = await runRetrieveStage(c, cfg.retrieval, {
        session,
        queries,
        relatedQueries: related,
        searchResults: results,
        topK,
        rerank: opts.rerank,
        signal,
        warnings,
        explain: opts.explain,
      });
      passages = r.passages;
      candidates = r.candidates;
      reranked = r.reranked;
      if (r.lexicalOnly && c.embedder) degraded = 'partial'; // configured lexical mode is not degraded
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
        retrieve: { candidates, queries: queries.length, reranked, ms: retrieveMs },
        totalMs: Date.now() - t0,
        warnings,
      },
      degraded,
      sessionId: opts.sessionId,
    };
    if (opts.markdown ?? cfg.output.markdown) {
      result.markdown = renderMarkdown(result, {
        maxPassageChars: cfg.output.maxPassageChars,
        maxTokens: opts.maxOutputTokens,
      });
    }
    stageDone('format', Date.now() - t0 - result.stats.totalMs);
    return result;
  }

  // ─── internals ─────────────────────────────────────────────────────────

  /** Get page content: provider-supplied text (Tavily/Exa) when allowed, else fetch + parse. */
  private async fetchPage(
    c: Components,
    r: SearchResult,
    signal?: AbortSignal,
  ): Promise<
    { page: CachedPage; cachedHit: boolean; ms: number } | { failure: Failure; ms: number }
  > {
    const content =
      this.config.ingestion.useProviderContent && typeof r.extra?.content === 'string'
        ? r.extra.content
        : undefined;
    if (content && content.length > 400) {
      return {
        page: documentFromProviderContent(r.url, r.title, content),
        cachedHit: false,
        ms: 0,
      };
    }
    const outcome = await ingestUrl(r.url, {
      fetcher: c.fetcher,
      parsers: c.parsers,
      cache: c.pageCache,
      logger: this.logger,
      signal,
    });
    if (!outcome.ok || !outcome.page)
      return { failure: outcome.failure as Failure, ms: outcome.ms };
    return { page: outcome.page, cachedHit: !!outcome.cached, ms: outcome.ms };
  }

  private resolveSession(sessionId: string | undefined, c: Components): Session {
    const mode = this.config.store.mode;
    if (sessionId) return c.sessions.getOrCreate(sessionId);
    if (mode === 'persistent' && c.sharedStore) return c.sessions.getOrCreate('persistent');
    if (mode === 'session') return c.sessions.getOrCreate('default');
    return ephemeralSession(c.sharedStore);
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

  private chunkingOptions() {
    const i = this.config.ingestion;
    return {
      chunkSize: i.chunkSize,
      chunkOverlap: i.chunkOverlap,
      maxChunks: i.maxChunksPerPage,
      minChunkChars: i.minChunkChars,
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
