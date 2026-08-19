import { z } from 'zod';
import type { RenderProvider } from '../ingest/render.js';
import type {
  EmbeddingProvider,
  LlmFn,
  Logger,
  QueryExpander,
  Reranker,
  SearchProvider,
  VectorStore,
} from '../types.js';
import { DEFAULT_USER_AGENT } from '../util/version.js';

// ─── Zod schema for serialisable config (files / env) ────────────────────────

export const searchProviderNames = [
  'duckduckgo',
  'brave',
  'serper',
  'serpapi',
  'google-cse',
  'searxng',
  'tavily',
  'tavily-keyless',
  'exa',
  'perplexity',
  'wikipedia',
] as const;
export type SearchProviderName = (typeof searchProviderNames)[number];

export const embeddingProviderNames = [
  'auto',
  'none',
  'local',
  'openai',
  'openai-compatible',
  'gemini',
  'voyage',
  'cohere',
  'mistral',
  'jina',
  'ollama',
] as const;
export type EmbeddingProviderName = (typeof embeddingProviderNames)[number];

export const storeProviderNames = ['memory', 'sqlite', 'chroma', 'qdrant', 'pgvector'] as const;
export type StoreProviderName = (typeof storeProviderNames)[number];

export const rerankerNames = ['cohere', 'voyage', 'jina', 'local'] as const;
export type RerankerName = (typeof rerankerNames)[number];

const freshnessSchema = z.union([
  z.enum(['day', 'week', 'month', 'year']),
  z.object({ after: z.string().optional(), before: z.string().optional() }),
]);

export const searchConfigSchema = z.object({
  provider: z.string().default('duckduckgo'),
  apiKey: z.string().optional(),
  /** google-cse engine id */
  cx: z.string().optional(),
  /** searxng / custom base URL */
  baseUrl: z.string().optional(),
  resultsPerQuery: z.number().int().min(1).max(100).default(10),
  safeSearch: z.enum(['off', 'moderate', 'strict']).default('moderate'),
  country: z.string().optional(),
  language: z.string().optional(),
  freshness: freshnessSchema.optional(),
  fallbackProviders: z.array(z.string()).default(['tavily-keyless', 'wikipedia']),
  timeoutMs: z.number().int().min(1000).default(20_000),
  /** Provider-specific extra options passed through. */
  options: z.record(z.string(), z.unknown()).default({}),
});

export const embeddingsConfigSchema = z.object({
  /**
   * 'auto' (default): local model if @huggingface/transformers is installed, else the first
   * hosted provider with a key in the environment, else 'none'.
   * 'none' | 'lexical': no embeddings — BM25 over the fetched pages (smallest install).
   */
  provider: z.string().default('auto'),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  dimensions: z.number().int().min(16).optional(),
  batchSize: z.number().int().min(1).optional(),
  cacheDir: z.string().optional(),
  /** Local models: 'q8' | 'fp32' | 'fp16' | 'q4' … */
  dtype: z.string().optional(),
  device: z.string().optional(),
  allowRemoteModels: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).default(60_000),
  /**
   * Persist chunk embeddings (keyed by model + dimensions + dtype + content hash) in the page
   * cache's SQLite file so re-runs and restarts never re-embed the same text. Needs a cache dir
   * (`ingestion.cache.dir`) and `node:sqlite`; the in-process cache is always on.
   */
  cache: z.boolean().default(true),
  options: z.record(z.string(), z.unknown()).default({}),
});

export const storeConfigSchema = z.object({
  provider: z.string().default('memory'),
  mode: z.enum(['ephemeral', 'session', 'persistent']).default('ephemeral'),
  collection: z.string().default('webvector'),
  url: z.string().optional(),
  apiKey: z.string().optional(),
  sessionTtlMs: z
    .number()
    .int()
    .min(1000)
    .default(30 * 60_000),
  maxSessions: z.number().int().min(1).default(100),
  options: z.record(z.string(), z.unknown()).default({}),
});

export const retrievalConfigSchema = z.object({
  topK: z.number().int().min(1).max(200).default(12),
  candidateMultiplier: z.number().min(1).default(4),
  queryExpansion: z.boolean().default(true),
  maxExpandedQueries: z.number().int().min(0).max(10).default(4),
  hybrid: z.boolean().default(true),
  /**
   * `rsf` (min-max relative score fusion, default — keeps score magnitude, +0.02–0.17 MRR over RRF
   * on the eval in both tiers) or `rrf` (reciprocal rank fusion, rank-only).
   */
  fusion: z.enum(['rrf', 'rsf']).default('rsf'),
  rrfK: z.number().min(1).default(60),
  /** Weight of BM25 lists in fusion relative to the original query vector list (1.0). */
  lexicalWeight: z.number().min(0).default(1.5),
  /**
   * Scale `lexicalWeight` per query: up for exact-match queries (quotes, identifiers, versions,
   * error strings, proper nouns), down for long natural-language questions. Off by default: on the
   * bundled eval a fixed 1.5 already suits exact-match queries and boosting further overshoots.
   */
  adaptiveWeights: z.boolean().default(false),
  expansionWeight: z.number().min(0).default(0.7),
  maxPerSource: z.number().int().min(1).default(3),
  /**
   * Prefer at most this many passages per registrable domain (eTLD+1) after the per-URL cap;
   * extra ones are demoted behind other domains, not dropped. 0 = off.
   */
  maxPerDomain: z.number().int().min(0).default(5),
  /**
   * Weight of the search engine's own ordering as an extra fused list (each chunk inherits its
   * page's SERP rank); lifts official/primary pages over mirrors with similar term stats. 0 = off.
   */
  serpPriorWeight: z.number().min(0).default(0),
  mmr: z.boolean().default(true),
  mmrLambda: z.number().min(0).max(1).default(0.7),
  /**
   * Redundancy measure for MMR: `auto` = cosine over chunk vectors when every candidate has one,
   * else word-3-gram Jaccard over text; `jaccard` forces text similarity even in semantic mode;
   * `vector` = cosine when available (falls back to Jaccard in lexical mode).
   */
  mmrSimilarity: z.enum(['auto', 'vector', 'jaccard']).default('auto'),
  /**
   * Aspect coverage (xQuAD-lite): treat caller-supplied related queries as aspects and re-select
   * the top-k so every aspect is covered before any aspect gets a third passage. `auto` = on
   * whenever related queries are given (there is nothing to do without them); `off` disables.
   */
  aspectCoverage: z.enum(['auto', 'off']).default('auto'),
  /** xQuAD λ: 0 = pure relevance, 1 = pure aspect coverage. */
  aspectLambda: z.number().min(0).max(1).default(0.5),
  /**
   * Recency boost, applied only when the caller asks for `freshness`:
   * score × (1 + weight · 0.5^(ageDays / halfLife)), capped at +30 %; undated pages are never
   * penalised. Half-life follows the freshness request (day 2 · week 7 · month 30 · year 180 days);
   * `halfLifeDays` is used for `{ after, before }` ranges.
   */
  recency: z
    .object({
      weight: z.number().min(0).max(0.3).default(0.3),
      halfLifeDays: z.number().min(1).default(180),
    })
    .default({ weight: 0.3, halfLifeDays: 180 }),
  /**
   * Boost passages corroborated by other domains: × (1 + 0.1·min(n−1, 3)) where n =
   * `Passage.corroboration`. Off by default (the count is always reported).
   */
  corroborationBoost: z.boolean().default(false),
  /** Word-3-gram Jaccard threshold for two chunks to count as corroborating each other. */
  corroborationJaccard: z.number().min(0).max(1).default(0.25),
  /**
   * When `result.evidence.level` is `weak`/`none`, run one more search round with the top
   * suggested queries inside the same call (same run deadline). 0 = off (default), max 1.
   */
  autoRetry: z.number().int().min(0).max(1).default(0),
  /**
   * Source-authority priors: glob → score multiplier, merged over the built-in defaults (user
   * wins; set a pattern to 1 to neutralise a built-in). Hostname globs (`*.gov`) or host/path globs
   * (`github.com/*\/*\/blob/*\/README*`). Combined multipliers are clamped to [0.7, 1.3] and shown
   * in `explain.multipliers.sourcePrior`.
   */
  sourcePriors: z.record(z.string(), z.number().positive()).default({}),
  /** Apply the small built-in prior list (*.gov/*.edu/arxiv/wikipedia/GitHub READMEs up; a few aggregators down). */
  builtinSourcePriors: z.boolean().default(true),
  /**
   * Boost passages whose registrable domain names something in the query (nodejs.org ↔ "node",
   * docs.python.org ↔ "python") — usually the primary source. Shown in `explain.multipliers.preferPrimary`.
   */
  preferPrimary: z.boolean().default(true),
  preferPrimaryBoost: z.number().min(1).max(1.3).default(1.15),
  minScore: z.number().min(-1).max(1).nullable().default(null),
  relativeCutoff: z.number().min(0).max(1).default(0.6),
  /**
   * Lexical-mode analogue of `relativeCutoff`: drop chunks whose best BM25 score is below this
   * fraction of the top hit (0 = off).
   */
  lexicalRelativeCutoff: z.number().min(0).max(1).default(0.3),
  /** Cut the final list after this many score "jumps" (gap > 3× mean gap); 0 = off. */
  autocut: z.number().int().min(0).default(0),
  nearDuplicateThreshold: z.number().min(0).max(1).default(0.9),
  /**
   * Return neighbouring chunks of one page (chunkIndex ±1) that both made the cut as a single
   * passage, so an answer straddling a chunk boundary comes back whole. Counts once toward
   * `maxPerSource`; freed slots are backfilled.
   */
  mergeAdjacent: z.boolean().default(true),
  rerank: z.union([z.boolean(), z.string()]).default(false),
  rerankModel: z.string().optional(),
  rerankApiKey: z.string().optional(),
  rerankTopN: z.number().int().min(1).default(50),
  fallbackToLexical: z.boolean().default(true),
  /** Lexical (BM25) scoring knobs; see retrieval/bm25.ts. */
  bm25: z
    .object({
      /** `okapi` = classic BM25 saturation; `bmx` = entropy-weighted coverage variant (arXiv:2408.06643). */
      variant: z.enum(['okapi', 'bmx']).default('okapi'),
      k1: z.number().min(0).default(1.2),
      b: z.number().min(0).max(1).default(0.75),
      /** BM25+ lower bound so long chunks containing a rare term aren't outscored by short ones lacking it (0 = off). */
      delta: z.number().min(0).default(0.5),
      /** Bonus for covering more distinct query terms (0 = off; ignored for `bmx`, which has its own). */
      coverageWeight: z.number().min(0).default(0),
      /** Bonus when matched query terms co-occur in a tight window (0 = off). */
      proximityWeight: z.number().min(0).default(0.3),
      /**
       * BM25F field weights: page title / heading breadcrumb / chunk body. The breadcrumb carries
       * section context a chunk's own words lack; the title is shared by every chunk of a page, so
       * weighting it mostly favours long pages — keep it at 1 unless you rank whole pages.
       */
      fields: z
        .object({
          title: z.number().min(0).default(1),
          breadcrumb: z.number().min(0).default(1.5),
          body: z.number().min(0).default(1),
          /** Page lead paragraph, indexed with chunks past the first (contextual retrieval "lite"). */
          lead: z.number().min(0).default(0),
        })
        .default({ title: 1, breadcrumb: 1.5, body: 1, lead: 0 }),
    })
    .default({
      variant: 'okapi',
      k1: 1.2,
      b: 0.75,
      delta: 0.5,
      coverageWeight: 0,
      proximityWeight: 0.3,
      fields: { title: 1, breadcrumb: 1.5, body: 1, lead: 0 },
    }),
});

export const ingestionConfigSchema = z.object({
  maxPages: z.number().int().min(1).max(100).default(10),
  maxConcurrentFetches: z.number().int().min(1).max(64).default(8),
  perHostConcurrency: z.number().int().min(1).default(2),
  perHostMinIntervalMs: z.number().int().min(0).default(500),
  /**
   * Upper bound applied to robots.txt `Crawl-delay` (some sites declare 15–30 s, which would
   * serialise a handful of pages past the run deadline). 0 ignores Crawl-delay entirely.
   */
  maxCrawlDelayMs: z.number().int().min(0).default(10_000),
  timeoutMs: z.number().int().min(1000).default(15_000),
  totalDeadlineMs: z.number().int().min(1000).default(45_000),
  maxRedirects: z.number().int().min(0).max(20).default(5),
  maxBytes: z
    .number()
    .int()
    .min(10_000)
    .default(5 * 1024 * 1024),
  /**
   * Byte cap for textual responses (HTML/markdown/plain/XML/JSON) — below `maxBytes`, which still
   * governs PDFs. Media, archives and scripts are rejected from the headers without downloading.
   */
  maxHtmlBytes: z
    .number()
    .int()
    .min(10_000)
    .default(2 * 1024 * 1024),
  respectRobotsTxt: z.boolean().default(true),
  /**
   * Content Signals (contentsignals.org — `Content-Signal: search=yes, ai-input=no, ai-train=no`
   * in a robots.txt group, or a `content-signal` response header): `respect` refuses pages that say
   * `ai-input=no` (FETCH_BLOCKED_CONTENT_SIGNAL) and records the signal on the document otherwise;
   * `record` only records `doc.contentSignal`; `ignore` does neither.
   */
  contentSignals: z.enum(['ignore', 'record', 'respect']).default('respect'),
  /**
   * Self-describing agent identity: `WebVector/<version> (+https://github.com/rthomas24/web-vector;
   * user-directed research agent)`. robots.txt groups match on the `WebVector` product token.
   */
  userAgent: z.string().default(DEFAULT_USER_AGENT),
  /** Optional contact address sent as the `From:` request header (crawler etiquette, RFC 9110 §10.1.2). */
  contactEmail: z.email().optional(),
  retries: z.number().int().min(0).max(5).default(2),
  allowPrivateNetworks: z.boolean().default(false),
  parsers: z.array(z.string()).default(['html', 'pdf', 'text']),
  /**
   * Content negotiation for served markdown (Cloudflare "Markdown for Agents", Mintlify, Vercel…):
   * `prefer` asks for `text/markdown` first (measured 10–100× smaller bodies on docs sites),
   * `accept` lists it after HTML, `off` never advertises it. Served markdown bypasses Readability
   * and goes through the served-markdown cleaner (`parser: 'server-markdown'`).
   */
  acceptMarkdown: z.enum(['prefer', 'accept', 'off']).default('prefer'),
  /**
   * URL-rewrite / API fast paths for hosts whose HTML is the worst way to get the content
   * (arxiv → HTML paper, github repo → raw README, github blob → raw, google docs → markdown
   * export, npm/pypi → registry readme, HN → Algolia API, Stack Exchange → API with answers,
   * GitHub issues/PRs → REST). true (all), false, or a list of ids. Rewritten hosts still go
   * through robots.txt/SSRF/politeness; any failure falls back to the original URL.
   */
  fastPaths: z.union([z.boolean(), z.array(z.string())]).default(true),
  /**
   * Wayback Machine fallback (opt-in): `'blocked'` retries bot-walled (FETCH_BLOCKED_BOT),
   * pay-walled (FETCH_PAYMENT_REQUIRED), 404/410 and needs-JS pages from web.archive.org via the
   * availability API; `'always'` any fetch failure except robots/SSRF/content-signal refusals.
   * ≈1 request/s process-wide, a 429 disables it for 10 min, never for `isAccessibleForFree:false`
   * pages; archived documents carry `doc.fetchedFrom: 'archive'` and `doc.archivedAt`.
   */
  archiveFallback: z.union([z.literal(false), z.enum(['blocked', 'always'])]).default(false),
  /** HTML extraction knobs (see ingest/extract-ensemble.ts). */
  html: z
    .object({
      /**
       * `auto` (default): route by page type — Q&A/forum threads and docs pages convert the whole
       * main content (Readability deletes answers and sidebars-adjacent tables), <pre> documents
       * are unwrapped, articles run Readability with a recall guard against the full page.
       * `readability`: classic Readability, whole page only when the article is thin.
       * `full`: always the whole page with navigation/chrome removed.
       */
      strategy: z.enum(['auto', 'readability', 'full']).default('auto'),
      /**
       * Use the JSON-LD `articleBody` when the DOM yields too little text and the page is not
       * paywalled (`isAccessibleForFree !== false`, including `hasPart`). Never overrides good DOM output.
       */
      useJsonLdBody: z.boolean().default(true),
    })
    .default({ strategy: 'auto', useJsonLdBody: true }),
  /**
   * Optional page renderer, used only when the served HTML is a JavaScript shell
   * (`PARSE_NEEDS_JS`) or — with `when: 'blocked'` — also when the fetch was blocked (401/403/
   * 429/451, bot challenge). No browser is bundled: `cloudflare` calls Browser Rendering's
   * `/markdown` REST endpoint (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN), `browserless` calls
   * `/content` (BROWSERLESS_TOKEN, BROWSERLESS_URL), `custom` takes `ingestion.render.instance`.
   * Off by default (`when: 'never'`). Remote renderers see the URLs you send them.
   */
  render: z
    .object({
      provider: z.enum(['cloudflare', 'browserless', 'custom']).optional(),
      when: z.enum(['needs-js', 'blocked', 'never']).default('never'),
      /** Renders per research() call / per fetch(). */
      maxPerRun: z.number().int().min(0).default(5),
      timeoutMs: z.number().int().min(1000).default(30_000),
      accountId: z.string().optional(),
      baseUrl: z.string().optional(),
      apiToken: z.string().optional(),
    })
    .default({ when: 'never', maxPerRun: 5, timeoutMs: 30_000 }),
  chunkSize: z.number().int().min(64).max(4096).default(480),
  chunkOverlap: z.number().int().min(0).default(60),
  maxChunksPerPage: z.number().int().min(1).default(200),
  minChunkChars: z.number().int().min(1).default(100),
  /**
   * Drop chunks whose text already appeared on another page of the same host in this session
   * (navigation, footers, "related" rails) and retract the earlier copies from the lexical index;
   * code blocks are never dropped.
   */
  dropSharedBoilerplate: z.boolean().default(true),
  /**
   * Use provider-returned page content (Tavily raw_content / Exa text) instead of fetching:
   * `'auto'` (default) only when it passes a quality gate (≥ 300 chars, not raw HTML, not cut off
   * at a round provider cap, not mostly links/nav) and falls through to a fetch otherwise
   * (`parser: 'provider'` vs `'provider→fetch'`); `true` always (when > 400 chars); `false` never.
   */
  useProviderContent: z.union([z.boolean(), z.literal('auto')]).default('auto'),
  cache: z
    .object({
      enabled: z.boolean().default(true),
      /** Freshness window; past it a cached page is revalidated (ETag / Last-Modified) or refetched. 0 = never expires. */
      ttlMs: z
        .number()
        .int()
        .min(0)
        .default(15 * 60_000),
      /** In-memory LRU capacity (pages). */
      maxPages: z.number().int().min(1).default(500),
      /**
       * On-disk layer: `'auto'` (default) → `pages.sqlite` in `$XDG_CACHE_HOME/webvector`
       * (`~/.cache/webvector`); a directory path; `false` → memory only. Needs `node:sqlite`
       * (Node ≥ 22.13); explicit directories fall back to one JSON file per URL without it.
       */
      dir: z.union([z.string(), z.literal(false)]).default('auto'),
      /** Disk budgets (LRU eviction by last access). */
      maxDiskPages: z.number().int().min(1).default(20_000),
      maxDiskBytes: z
        .number()
        .int()
        .min(1024 * 1024)
        .default(1024 * 1024 * 1024),
      /** Remember robots-blocked / 4xx URLs for this long so agent swarms don't re-hit them (0 = off). */
      negativeTtlMs: z.number().int().min(0).max(300_000).default(15_000),
    })
    .default({
      enabled: true,
      ttlMs: 15 * 60_000,
      maxPages: 500,
      dir: 'auto',
      maxDiskPages: 20_000,
      maxDiskBytes: 1024 * 1024 * 1024,
      negativeTtlMs: 15_000,
    }),
});

export const outputConfigSchema = z.object({
  markdown: z.boolean().default(true),
  maxPassageChars: z.number().int().min(100).default(1500),
  /**
   * Token budget for the rendered markdown (0 = unlimited). Passages are packed by score per token;
   * the top passage and one per source are kept first; a footer lists omitted indices.
   */
  maxTokens: z.number().int().min(0).default(0),
  /** Compute `Passage.highlight` (best 1–3 sentence window for the query). Cheap; no model needed. */
  highlights: z.boolean().default(true),
  /** `full` renders whole passages in the markdown; `highlight` renders only the highlight window. */
  passageMode: z.enum(['full', 'highlight']).default('full'),
  /**
   * Evidence-card header per passage: `**[n]** Title — <url> · domain · published … ·
   * corroborated by k sites · matched: "q1", "q2" · score` — lets the model weigh recency,
   * corroboration and which sub-question a passage answers without extra tool calls (< 40 tokens).
   */
  evidenceCards: z.boolean().default(false),
  /**
   * `score` (default) or `date-asc`: passages ordered oldest → newest (undated first) so the most
   * recent evidence sits closest to the model's answer (FreshPrompt: up to +2.2 % accuracy).
   * Passage indices are renumbered after ordering.
   */
  order: z.enum(['score', 'date-asc']).default('score'),
  includeSnippetsOnFailure: z.boolean().default(true),
  /** `detailed` (score/date per passage, failures, stats) or `concise` (passages + sources only). */
  format: z.enum(['concise', 'detailed']).default('detailed'),
  /**
   * Links inside rendered passages: `strip` (`[text](url)` → `text`, images → `[image: alt]`),
   * `footnote` (`text[^k]` + per-passage footnotes) or `inline` (unchanged). Stored chunks never change.
   */
  links: z.enum(['strip', 'footnote', 'inline']).default('strip'),
  /** Cite passages with text-fragment deep links (`url#:~:text=start,end`; PDFs skipped). */
  deepLinks: z.boolean().default(false),
});

export const loggingConfigSchema = z.object({
  level: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('warn'),
});

const priceTableSchema = z.object({
  embed: z.record(z.string(), z.number().min(0)).optional(),
  search: z.record(z.string(), z.number().min(0)).optional(),
  rerank: z.record(z.string(), z.number().min(0)).optional(),
});

/** Observability. Nothing here ever sends data anywhere by itself. */
export const telemetryConfigSchema = z.object({
  /**
   * Add `stats.usage.estimatedCostUsd` from a static list-price table (an ESTIMATE, clearly
   * labelled). `true` uses the bundled table; an object overrides entries
   * (`{ embed: { 'openai/text-embedding-3-small': 0.02 }, search: { brave: 5 } }`).
   */
  pricing: z.union([z.boolean(), priceTableSchema]).default(false),
  /**
   * Emit OpenTelemetry spans through `@opentelemetry/api` (optional peer; a no-op without an SDK
   * registered by the host application). Env: WEBVECTOR_OTEL=1.
   */
  otel: z.boolean().default(false),
  /** Include query text / passage excerpts in span attributes (off: counts and ids only). */
  captureContent: z.boolean().default(false),
});

export const webVectorFileConfigSchema = z.object({
  search: searchConfigSchema.default(searchConfigSchema.parse({})),
  embeddings: embeddingsConfigSchema.default(embeddingsConfigSchema.parse({})),
  store: storeConfigSchema.default(storeConfigSchema.parse({})),
  retrieval: retrievalConfigSchema.default(retrievalConfigSchema.parse({})),
  ingestion: ingestionConfigSchema.default(ingestionConfigSchema.parse({})),
  output: outputConfigSchema.default(outputConfigSchema.parse({})),
  logging: loggingConfigSchema.default(loggingConfigSchema.parse({})),
  telemetry: telemetryConfigSchema.default(telemetryConfigSchema.parse({})),
});

export type WebVectorFileConfig = z.infer<typeof webVectorFileConfigSchema>;
export type WebVectorFileConfigInput = z.input<typeof webVectorFileConfigSchema>;

/** Deep partial helper for user input. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

// ─── Code config: serialisable config + instances/functions ─────────────────

export interface WebVectorConfig
  extends DeepPartial<
    Omit<WebVectorFileConfigInput, 'search' | 'embeddings' | 'store' | 'retrieval' | 'ingestion'>
  > {
  ingestion?: DeepPartial<z.input<typeof ingestionConfigSchema>> & {
    render?: {
      /** Ready renderer instance (`provider: 'custom'`): `render(url, { signal }) → { html | markdown, finalUrl }`. */
      instance?: RenderProvider;
    };
  };
  search?: DeepPartial<z.input<typeof searchConfigSchema>> & {
    /** Provide a ready instance instead of a provider name. */
    instance?: SearchProvider;
    /** Instances to try in order when the primary fails. */
    fallbackInstances?: SearchProvider[];
  };
  embeddings?: DeepPartial<z.input<typeof embeddingsConfigSchema>> & {
    instance?: EmbeddingProvider;
  };
  store?: DeepPartial<z.input<typeof storeConfigSchema>> & { instance?: VectorStore };
  retrieval?: DeepPartial<z.input<typeof retrievalConfigSchema>> & {
    reranker?: Reranker;
    expander?: QueryExpander;
    /** Provider-agnostic LLM hook enabling LLM multi-query expansion (and `rerank: 'llm'`). */
    llm?: LlmFn;
  };
  logger?: Logger;
  /** Custom fetch implementation (tests, proxies). */
  fetch?: typeof fetch;
}

/** Identity helper for typed config files. */
export function defineConfig(config: WebVectorConfig): WebVectorConfig {
  return config;
}
