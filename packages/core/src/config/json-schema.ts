/**
 * JSON Schema for the serialisable config (files / env), derived from the zod schema so it can
 * never drift. `npm run build` writes it to `packages/core/schema/webvector.config.json` (shipped
 * in the package and served from the repo at a stable URL); editors pick it up through
 * `"$schema"` in JSON configs or the `# yaml-language-server: $schema=…` modeline in YAML.
 */
import { z } from 'zod';
import { webVectorFileConfigSchema } from './schema.js';

/** Stable URL of the published schema (tracks `main`). */
export const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/rthomas24/web-vector/main/packages/core/schema/webvector.config.json';

/** YAML modeline understood by the yaml-language-server (VS Code YAML extension and friends). */
export const CONFIG_SCHEMA_YAML_MODELINE = `# yaml-language-server: $schema=${CONFIG_SCHEMA_URL}`;

/**
 * Human descriptions merged into the generated schema (dotted paths). The zod schema documents
 * options with JSDoc for TypeScript users; this keeps editor hovers useful without duplicating
 * every comment as `.describe()`. Full reference: docs/CONFIGURATION.md.
 */
export const CONFIG_DESCRIPTIONS: Record<string, string> = {
  search: 'Search engine: which provider answers the query, result count, freshness, fallbacks.',
  'search.provider':
    'duckduckgo (keyless, default) | brave | serper | serpapi | google-cse | searxng | tavily | tavily-keyless | exa | perplexity | wikipedia. API keys are read from the conventional env vars (BRAVE_API_KEY, …) or search.apiKey.',
  'search.fallbackProviders': 'Providers tried in order when the primary fails or is rate-limited.',
  'search.freshness': "'day' | 'week' | 'month' | 'year' or { after, before } ISO dates.",
  embeddings:
    'Embedding tier: auto (local model if @huggingface/transformers is installed, else a hosted provider with a key, else lexical BM25), none, local, or a hosted provider.',
  'embeddings.provider':
    'auto | none | local | openai | openai-compatible | gemini | voyage | cohere | mistral | jina | ollama.',
  'embeddings.dimensions': 'Matryoshka truncation where the model supports it.',
  'embeddings.dtype': "Local models: 'q8' (default) | 'fp32' | 'fp16' | 'q4'.",
  'embeddings.cache':
    'Persist chunk embeddings in the page cache’s pages.sqlite (key: model + dimensions + dtype + role + content hash) so re-runs never re-embed the same text.',
  store: 'Vector store and session lifetime.',
  'store.provider':
    'memory (default) | sqlite (zero-dependency persistent store on node:sqlite) | chroma | qdrant | pgvector.',
  'store.mode':
    'ephemeral (per call) | session (reuse pages by sessionId, TTL) | persistent (one shared session that survives restarts with sqlite/external stores).',
  'store.url':
    'Connection URL — for sqlite a file path (default ~/.local/share/webvector/store.sqlite).',
  'store.sessionTtlMs':
    'Idle sessions are dropped after this long; persistent stores also expire their rows on disk.',
  'store.options':
    'Provider-specific options, e.g. sqlite: { vec: true } to rank with the optional sqlite-vec extension.',
  retrieval: 'Ranking: hybrid BM25 + vectors, fusion, expansion, MMR, cutoffs, reranking.',
  'retrieval.topK': 'Passages returned per call (tool calls may ask for fewer, never more).',
  'retrieval.rerank': 'false | true | local | cohere | voyage | jina | llm.',
  ingestion: 'Fetching, politeness, parsing, chunking and the page cache.',
  'ingestion.maxPages': 'Pages fetched per call (1–100).',
  'ingestion.respectRobotsTxt':
    'Honour robots.txt (incl. Crawl-delay). Only disable with permission.',
  'ingestion.allowPrivateNetworks': 'Disables the SSRF guard — only for trusted local setups.',
  'ingestion.cache':
    'Page cache: in-process LRU in front of pages.sqlite; conditional revalidation when stale.',
  'ingestion.cache.enabled': 'Turn the page cache off entirely.',
  'ingestion.cache.ttlMs':
    'Freshness window (ms); past it a page is revalidated (ETag / Last-Modified → 304) or refetched. 0 = never expires. A longer Cache-Control max-age extends it.',
  'ingestion.cache.dir':
    "'auto' (default: pages.sqlite in $XDG_CACHE_HOME/webvector, i.e. ~/.cache/webvector), a directory path, or false for memory only.",
  'ingestion.cache.maxPages': 'In-memory LRU capacity (pages).',
  'ingestion.cache.maxDiskPages':
    'On-disk budget (pages); least-recently-used pages are evicted first.',
  'ingestion.cache.maxDiskBytes': 'On-disk budget for page markdown (bytes).',
  'ingestion.cache.negativeTtlMs':
    'Remember robots-blocked / SSRF-blocked / 4xx URLs for this long (ms; 0 = off).',
  output: 'Markdown rendering of results.',
  logging: 'Log level for stderr output.',
  telemetry: 'Observability. Nothing here sends data anywhere by itself.',
  'telemetry.pricing':
    'true → stats.usage.estimatedCostUsd from a bundled list-price table (an ESTIMATE); an object overrides entries: { embed: { "openai/text-embedding-3-small": 0.02 }, search: { brave: 5 }, rerank: { cohere: 2 } }.',
  'telemetry.otel':
    'Emit OpenTelemetry spans via @opentelemetry/api (optional peer; no-op without an SDK).',
  'telemetry.captureContent': 'Include query text / passage excerpts in span attributes.',
};

function annotate(schema: Record<string, unknown>, prefix = ''): void {
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return;
  for (const [key, node] of Object.entries(props)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const text = CONFIG_DESCRIPTIONS[path];
    if (text && !node.description) node.description = text;
    annotate(node, path);
  }
}

/** Build the JSON Schema (draft-07, input shape: every key optional, defaults annotated). */
export function configJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(webVectorFileConfigSchema, {
    io: 'input',
    target: 'draft-7',
    unrepresentable: 'any',
  }) as Record<string, unknown> & { properties?: Record<string, unknown> };
  annotate(schema);
  const properties = schema.properties ?? {};
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: CONFIG_SCHEMA_URL,
    title: 'WebVector configuration',
    description:
      'webvector.config.{json,yaml} — every key is optional; ${VAR} / ${VAR:-default} in strings are interpolated from the environment. Precedence: code > file > env > defaults. See docs/CONFIGURATION.md.',
    ...schema,
    properties: {
      $schema: {
        type: 'string',
        description: 'Editor schema reference (ignored by WebVector).',
      },
      ...properties,
    },
    additionalProperties: false,
  };
}
