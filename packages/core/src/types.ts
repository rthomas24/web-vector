/**
 * Core public types for WebVector.
 *
 * Everything an adapter author or integrator needs lives here. Runtime helpers live next to the
 * stage that owns them (search/, ingest/, embeddings/, stores/, retrieval/).
 */

// ─── Search ──────────────────────────────────────────────────────────────────

export type Freshness = 'day' | 'week' | 'month' | 'year' | { after?: string; before?: string };

export interface SearchResult {
  /** Absolute http(s) URL, already normalised (fragment stripped). */
  url: string;
  title: string;
  snippet?: string;
  /** 1-based rank as returned by the provider. */
  rank: number;
  /** ISO date if the provider exposes one. */
  publishedAt?: string;
  /** Provider id that produced this result. */
  source: string;
  /** Provider-specific extras (e.g. Brave `extra_snippets`, Tavily `raw_content`). */
  extra?: Record<string, unknown>;
}

export interface SearchOptions {
  count?: number;
  freshness?: Freshness;
  safeSearch?: 'off' | 'moderate' | 'strict';
  country?: string;
  language?: string;
  domainsAllow?: string[];
  domainsBlock?: string[];
  signal?: AbortSignal;
}

export interface SearchCapabilities {
  requiresApiKey: boolean;
  keyless: boolean;
  maxResults: number;
  supportsFreshness: boolean;
  supportsDomainFilter: boolean;
  supportsSafeSearch: boolean;
  supportsCountry: boolean;
  supportsLanguage: boolean;
  /** Provider can return full page content (e.g. Tavily raw_content, Exa text) usable as a fetch shortcut. */
  returnsContent?: boolean;
}

export interface SearchProvider {
  readonly id: string;
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
  capabilities(): SearchCapabilities;
}

// ─── Embeddings ──────────────────────────────────────────────────────────────

export type EmbedKind = 'query' | 'document';

export interface EmbedOptions {
  kind?: EmbedKind;
  signal?: AbortSignal;
}

export interface EmbeddingLimits {
  maxBatchSize: number;
  maxTokensPerInput?: number;
  maxTokensPerBatch?: number;
  /** Conservative character cap per input applied by the chunker/embedder. */
  maxInputChars?: number;
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  embed(texts: string[], opts?: EmbedOptions): Promise<Float32Array[]>;
  dimensions(): Promise<number> | number;
  limits(): EmbeddingLimits;
  /** Optional warm-up (e.g. load a local model). */
  init?(): Promise<void>;
  /** Weight/output dtype for local models (e.g. 'q8', 'fp32'); part of the persistent cache key. */
  readonly dtype?: string;
}

// ─── Chunks & vector stores ──────────────────────────────────────────────────

export interface ChunkMetadata {
  url: string;
  canonicalUrl: string;
  title: string;
  chunkIndex: number;
  totalChunks: number;
  /** Char offsets into the page markdown. */
  startOffset: number;
  endOffset: number;
  contentHash: string;
  pageHash: string;
  fetchedAt: string;
  searchRank: number;
  searchQuery: string;
  contentType: string;
  /** Search provider id. */
  provider: string;
  sessionId?: string;
  siteName?: string;
  publishedAt?: string;
  /** Last-modified date declared by the page (article:modified_time, dateModified, …). */
  updatedAt?: string;
  lang?: string;
  breadcrumb?: string;
  /** Page kind from og:type / JSON-LD (article, news, blog, qa, docs, product, video, other). */
  kind?: string;
  /** 1-based PDF page the chunk starts on (PDF documents only). */
  page?: number;
  [k: string]: unknown;
}

export interface Chunk {
  /** Deterministic id: hash(canonicalUrl + contentHash). */
  id: string;
  /** Text returned to callers. */
  text: string;
  /** Text that was embedded (breadcrumb + text). Defaults to `text`. */
  embedText?: string;
  vector?: Float32Array;
  metadata: ChunkMetadata;
}

export interface ScoredChunk extends Chunk {
  /** Similarity in [-1, 1] for cosine stores; higher is better. */
  score: number;
  /** Set by rerankers. */
  rerankScore?: number;
}

export type ChunkFilter = {
  sessionId?: string;
  urls?: string[];
  /** Equality filters on metadata keys. */
  where?: Record<string, string | number | boolean>;
};

export interface VectorStoreQueryOptions {
  topK: number;
  filter?: ChunkFilter;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface VectorStoreCapabilities {
  persistent: boolean;
  supportsFilter: boolean;
  supportsHas: boolean;
}

export interface VectorStore {
  readonly id: string;
  /**
   * Called once before first use with the embedding dimensions/model. Persistent stores must verify
   * that any existing collection matches (throw EMBEDDING_DIMENSION_MISMATCH otherwise).
   */
  init?(dimensions: number, embeddingModel: string): Promise<void>;
  upsert(chunks: Chunk[]): Promise<void>;
  query(vector: Float32Array, opts: VectorStoreQueryOptions): Promise<ScoredChunk[]>;
  /** Return the subset of ids already present (used for content-hash dedup). */
  has?(ids: string[]): Promise<Set<string>>;
  clear(sessionId?: string): Promise<void>;
  close?(): Promise<void>;
  capabilities(): VectorStoreCapabilities;
  /** Optional: number of stored chunks (memory store). */
  size?(): number | Promise<number>;
  /** Optional: one chunk (with vector) by id — lets the pipeline reuse vectors for MMR. */
  get?(id: string): Chunk | undefined;
  /**
   * Optional: chunks of a session (or all) without vectors. Persistent stores implement this so a
   * session's BM25 side-index and chunk map can be rebuilt after a restart.
   */
  listChunks?(sessionId?: string): Promise<Chunk[]>;
}

// ─── Content parsing ─────────────────────────────────────────────────────────

export interface ParsedDocument {
  url: string;
  title: string;
  markdown: string;
  /** Plain text derived from markdown (for BM25 / previews). */
  text: string;
  byline?: string;
  siteName?: string;
  publishedAt?: string;
  /** Last-modified date declared by the page (article:modified_time, og:updated_time, dateModified, …). */
  updatedAt?: string;
  /** BCP-47-ish language tag from <html lang> / Content-Language / JSON-LD / script heuristic. */
  lang?: string;
  excerpt?: string;
  /**
   * Absolute canonical URL (<link rel=canonical> / og:url) when declared and sane; the ingest
   * stage uses it as the dedupe key so AMP/mobile/tracking variants merge.
   */
  canonicalUrl?: string;
  /** hreflang alternates. */
  alternates?: { lang: string; url: string }[];
  /** Page kind from og:type / JSON-LD @type / generator / URL path. */
  kind?: 'article' | 'news' | 'blog' | 'qa' | 'docs' | 'product' | 'video' | 'other';
  /** schema.org isAccessibleForFree (false = paywalled); undefined when the page does not say. */
  accessibleForFree?: boolean;
  /** Whitespace-token count of `text`. */
  wordCount?: number;
  /** PDF only: 1-based page number at each markdown char offset boundary (`{ start, page }`). */
  pages?: { start: number; page: number }[];
  contentType: string;
  /** Parser id that produced the document. */
  parser: string;
  /** Content-usage signal declared by the site (robots.txt `Content-Signal:` or `content-signal` header). */
  contentSignal?: ContentSignal;
  /** Where the bytes came from: the origin (default), an API fast path, a web archive, or the search provider. */
  fetchedFrom?: 'origin' | 'api' | 'archive' | 'provider';
  /** ISO timestamp of the archived snapshot when `fetchedFrom` is `archive`. */
  archivedAt?: string;
  /** Decoded `#:~:text=` fragment from the requested URL, if any (a hint for retrieval). */
  textFragment?: string;
  /** Extra transport/parser metadata (e.g. `markdownTokens`, `fastPath`, `frontmatter.*`). */
  metadata?: Record<string, string | number | boolean>;
}

/**
 * Content Signals (contentsignals.org): a site's stated preferences for `search`, `ai-input`
 * (real-time use, e.g. RAG/agents) and `ai-train`. Absent keys = no preference expressed.
 */
export interface ContentSignal {
  search?: boolean;
  aiInput?: boolean;
  aiTrain?: boolean;
  /** Raw directive value, e.g. `search=yes, ai-train=no`. */
  raw: string;
  source: 'robots' | 'header';
}

export interface ParseContext {
  url: string;
  contentType: string;
  charset?: string;
  /** `Content-Language` response header, when the server sent one (language fallback). */
  contentLanguage?: string;
}

export interface ContentParser {
  readonly id: string;
  canHandle(contentType: string, url: string, sniff?: Uint8Array): boolean;
  parse(bytes: Uint8Array, ctx: ParseContext): Promise<ParsedDocument | null>;
}

// ─── Reranking / expansion ───────────────────────────────────────────────────

export interface Reranker {
  readonly id: string;
  rerank(
    query: string,
    chunks: ScoredChunk[],
    opts?: { topN?: number; signal?: AbortSignal },
  ): Promise<ScoredChunk[]>;
}

/** Provider-agnostic LLM hook used for optional query expansion / LLM reranking. */
export type LlmFn = (prompt: string, opts?: { signal?: AbortSignal }) => Promise<string>;

export interface QueryExpander {
  expand(
    query: string,
    ctx: { searchResults: SearchResult[]; related: string[]; max: number; signal?: AbortSignal },
  ): Promise<string[]>;
}

// ─── Pipeline I/O ────────────────────────────────────────────────────────────

export type Stage = 'plan' | 'search' | 'ingest' | 'embed' | 'retrieve' | 'format';

export interface Failure {
  url?: string;
  code: string;
  message: string;
  stage: Stage;
  provider?: string;
}

export interface Passage {
  index: number;
  text: string;
  url: string;
  title: string;
  /** Fused, normalised relevance in [0, 1]. */
  score: number;
  cosine?: number;
  bm25?: number;
  rerankScore?: number;
  chunkIndex: number;
  /** Number of neighbouring chunks merged into this passage (≥ 2 when merged; absent otherwise). */
  chunkCount?: number;
  startOffset: number;
  endOffset: number;
  siteName?: string;
  publishedAt?: string;
  updatedAt?: string;
  /** Page kind (article, news, blog, qa, docs, product, video, other) when the page declared one. */
  kind?: string;
  /** PDF page the passage starts on (1-based); the citation then carries `#page=N`. */
  page?: number;
  fetchedAt: string;
  matchedQueries: string[];
  /** Ready-to-print citation, e.g. "[3] Title — https://…". */
  citation: string;
  /** True when this passage is a raw search snippet (degraded mode). */
  fromSnippet?: boolean;
  /** Best 1–3 sentence window for the query (`output.highlights`); offsets are into the page markdown. */
  highlight?: { text: string; startOffset: number; endOffset: number };
  /**
   * Distinct registrable domains (including this passage's own) whose retrieved chunks say the
   * same thing (word-3-gram Jaccard ≥ 0.25 or cosine ≥ 0.85). 1 = uncorroborated.
   */
  corroboration?: number;
  /** Ranking breakdown; present only when `explain: true` was requested. */
  explain?: PassageExplain;
}

/** Why a passage ranked where it did (`ResearchOptions.explain`). */
export interface PassageExplain {
  /** Fused score before display normalisation (RRF sum, or reranker score when reranked). */
  fused: number;
  /** Best 1-based rank across BM25 lists (undefined if no lexical list matched). */
  bm25Rank?: number;
  /** Best 1-based rank across vector lists (undefined if no vector list matched). */
  vectorRank?: number;
  /** Rank in the final ordering before display sort (after diversify/MMR/rerank). */
  poolRank: number;
  /** Every ranked list this chunk appeared in. */
  lists: { kind: 'bm25' | 'vector'; query: string; rank: number; score: number; weight: number }[];
  /** Chunk indices merged into this passage (`retrieval.mergeAdjacent`). */
  mergedChunks?: number[];
  /** xQuAD objective value when aspect coverage re-selected the top-k (`retrieval.aspectCoverage`). */
  aspectScore?: number;
  /** Multipliers applied to the fused score (`recency`, `corroboration`, `sourcePrior`, `preferPrimary`). */
  multipliers?: Record<string, number>;
}

export interface SourceSummary {
  url: string;
  title: string;
  status: 'ok' | 'failed' | 'skipped' | 'cached';
  chunks: number;
  bestScore?: number;
  passageIndices: number[];
  contentType?: string;
  fetchedAt?: string;
  searchRank: number;
  bytes?: number;
  ms?: number;
  /** Approximate tokens of the page's Markdown (chars/4, CJK-aware) — what a full fetch would cost. */
  approxTokens?: number;
  failure?: Failure;
  /** Page came from the page cache (fresh hit, or a stale copy confirmed by 304). */
  fromCache?: boolean;
  /** The cached copy was revalidated with a conditional request (304 Not Modified). */
  revalidated?: boolean;
}

/** HTTP-level counters for one call (page fetches; searches/embeddings are counted separately). */
export interface HttpUsage {
  /** Network requests made for pages (including conditional revalidations). */
  requests: number;
  /** Response bytes read. */
  bytes: number;
  /** Pages served from the page cache without a request. */
  cacheHits: number;
  /** Conditional requests answered 304 (cached copy reused). */
  notModified: number;
  /** Fetches that joined an identical in-flight request instead of starting their own. */
  coalesced: number;
  /** URLs skipped because a recent robots/4xx failure was remembered (negative cache). */
  negativeHits: number;
}

/**
 * Cost/quota accounting for one call: what was actually spent on providers and the network.
 * Also emitted as the `usage` event. `estimatedCostUsd` is only present when `telemetry.pricing`
 * is enabled and is an ESTIMATE from a static list-price table — never a bill.
 */
export interface UsageStats {
  search: { provider: string; calls: number };
  embed: {
    provider: string;
    model: string;
    /** embed() requests actually sent (cache hits do not count). */
    requests: number;
    /** Texts embedded (documents + queries). */
    texts: number;
    /** Approximate input tokens (chars / 4) — an estimate unless the provider reports usage. */
    tokens?: number;
    /** Chunk embeddings served from the in-memory / persistent embedding cache. */
    cached: number;
  };
  rerank?: { provider: string; requests: number; documents: number };
  http: HttpUsage;
  estimatedCostUsd?: number;
  /** Always set alongside `estimatedCostUsd`. */
  pricingNote?: string;
}

export interface ResearchStats {
  search: {
    provider: string;
    attempts: { provider: string; ok: boolean; ms: number; error?: string }[];
    resultCount: number;
    ms: number;
  };
  ingest: {
    requested: number;
    fetched: number;
    ok: number;
    failed: number;
    cached: number;
    bytes: number;
    ms: number;
  };
  embed: {
    provider: string;
    model: string;
    dimensions: number;
    chunks: number;
    cached: number;
    batches: number;
    ms: number;
  };
  retrieve: {
    candidates: number;
    queries: number;
    reranked: boolean;
    ms: number;
    /** Approximate tokens of the returned markdown (or passage texts when markdown is off). */
    tokensReturned?: number;
    /** Present when `autoRetry` ran a second search round inside this call. */
    autoRetry?: {
      queries: string[];
      newPages: number;
      levelBefore: 'strong' | 'weak' | 'none';
      levelAfter: 'strong' | 'weak' | 'none';
      ms: number;
    };
  };
  totalMs: number;
  warnings: string[];
  /** Size of `result.markdown` when rendered (chars and approximate tokens). */
  output?: { chars: number; approxTokens: number };
  /** HTTP counters (same object as `usage.http`). */
  http?: HttpUsage;
  /** Provider/network usage for this call (see `UsageStats`). */
  usage?: UsageStats;
}

export interface ResearchResult {
  query: string;
  queries: string[];
  passages: Passage[];
  sources: SourceSummary[];
  failures: Failure[];
  stats: ResearchStats;
  markdown?: string;
  degraded?: 'search_only' | 'partial';
  /** Why the result is degraded (e.g. the deadline was reached before every page was fetched). */
  degradedReason?: string;
  sessionId?: string;
  /**
   * How many returned passages matched each caller-supplied related query (aspect coverage,
   * `retrieval.aspectCoverage`). Only present when related queries were given.
   */
  coverage?: Record<string, number>;
  /**
   * LLM-free evidence-sufficiency verdict: is this enough to answer, and if not, what to search
   * next. `strong` | `weak` | `none`, with the signals behind it and `suggestedQueries`.
   */
  evidence?: Evidence;
}

/** Evidence-sufficiency gate output (see retrieval/evidence.ts). */
export interface Evidence {
  level: 'strong' | 'weak' | 'none';
  /** Fraction of distinct query terms present in the top-3 passages. */
  coverage: number;
  distinctDomains: number;
  /** Top passage's fused score over the mean candidate score (peaked = confident). */
  topScoreRatio: number;
  /** Returned passages / requested topK. */
  cutoffPosition: number;
  /** Follow-up queries (pseudo-relevance-feedback terms, bridge entities, missing query terms). */
  suggestedQueries: string[];
}

export interface ProgressEvent {
  stage: Stage;
  done: number;
  total: number;
  message: string;
  /** Ingest stage: pages that failed so far. */
  failed?: number;
}

/** Search-intent hint mapped to provider features where they exist, else to query operators. */
export type SearchCategory = 'news' | 'research' | 'github' | 'pdf' | 'docs';

export interface ResearchOptions {
  relatedQueries?: string[];
  topK?: number;
  maxPages?: number;
  freshness?: Freshness;
  domainsAllow?: string[];
  domainsBlock?: string[];
  sessionId?: string;
  signal?: AbortSignal;
  onProgress?: (e: ProgressEvent) => void;
  /** Override rerank for this call. */
  rerank?: boolean;
  /** Include pre-rendered markdown (default from config). */
  markdown?: boolean;
  /**
   * Token budget for the rendered markdown (approximate). Passages are packed by score per token,
   * keeping the top passage and one per source; omitted indices are listed in a footer. Can only
   * tighten `output.maxTokens`.
   */
  maxOutputTokens?: number;
  /** Attach a per-passage ranking breakdown (`Passage.explain`). Off by default (payload size). */
  explain?: boolean;
  /** Markdown shape for `result.markdown` (default `output.format`): `concise` or `detailed`. */
  responseFormat?: 'concise' | 'detailed';
  /** Override `retrieval.queryExpansion` for this call. */
  queryExpansion?: boolean;
  /**
   * Wall-clock budget for the fetch stage (ms, capped by `ingestion.totalDeadlineMs`). Partial
   * results are always returned (`degraded: 'partial'` + `degradedReason`).
   */
  deadlineMs?: number;
  /**
   * Long-form intent (≤ 2000 chars) used for ranking only — never sent to the search engine. It is
   * reduced to its most distinctive terms and fused as an extra low-weight query list.
   */
  objective?: string;
  /** Search-intent hint: provider feature where available, else query operators (`filetype:pdf`, `site:github.com`, …). */
  category?: SearchCategory;
  /** Search locale passthrough (ISO country / BCP-47 language) — overrides `search.country/language`. */
  country?: string;
  language?: string;
  /**
   * Accept cached pages at most this old (ms). Overrides `ingestion.cache.ttlMs` and any
   * `Cache-Control: max-age` for this call; older copies are revalidated or refetched.
   */
  maxAgeMs?: number;
  /**
   * `default` (cache, revalidate when stale) · `bypass` (always fetch, still fills the cache) ·
   * `readOnly` (serve only from cache, never touch the network — stale copies allowed).
   */
  cacheMode?: CacheMode;
  /**
   * When the evidence gate says `weak`/`none`, run one more search round with the suggested
   * queries inside this call (bounded by the same run deadline). 0 or 1; overrides
   * `retrieval.autoRetry`.
   */
  autoRetry?: number;
}

export type CacheMode = 'default' | 'bypass' | 'readOnly';

// ─── Logging ────────────────────────────────────────────────────────────────

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}
