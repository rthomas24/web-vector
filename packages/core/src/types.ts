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
  lang?: string;
  breadcrumb?: string;
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
  lang?: string;
  excerpt?: string;
  contentType: string;
  /** Parser id that produced the document. */
  parser: string;
}

export interface ParseContext {
  url: string;
  contentType: string;
  charset?: string;
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
  startOffset: number;
  endOffset: number;
  siteName?: string;
  publishedAt?: string;
  fetchedAt: string;
  matchedQueries: string[];
  /** Ready-to-print citation, e.g. "[3] Title — https://…". */
  citation: string;
  /** True when this passage is a raw search snippet (degraded mode). */
  fromSnippet?: boolean;
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
  failure?: Failure;
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
  retrieve: { candidates: number; queries: number; reranked: boolean; ms: number };
  totalMs: number;
  warnings: string[];
  /** Size of `result.markdown` when rendered (chars and approximate tokens). */
  output?: { chars: number; approxTokens: number };
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
  sessionId?: string;
}

export interface ProgressEvent {
  stage: Stage;
  done: number;
  total: number;
  message: string;
}

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
  /** Trim passages so the rendered markdown stays under this many (approximate) tokens. */
  maxOutputTokens?: number;
  /** Attach a per-passage ranking breakdown (`Passage.explain`). Off by default (payload size). */
  explain?: boolean;
  /** Markdown shape for `result.markdown` (default `output.format`): `concise` or `detailed`. */
  responseFormat?: 'concise' | 'detailed';
}

// ─── Logging ────────────────────────────────────────────────────────────────

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}
