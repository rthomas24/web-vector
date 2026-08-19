/**
 * webvector — provider-agnostic web research for AI agents.
 *
 * search → full-page ingestion → embeddings → hybrid semantic retrieval → cited passages.
 */

export type { CacheDbOptions, CacheStats, PageRow } from './cache/db.js';
export { CACHE_DB_FILENAME, CacheDb, openCacheDb, resolveCacheDir } from './cache/db.js';
export { FetchCoordinator, isNegativeCacheable, SingleFlight } from './cache/single-flight.js';
export type {
  DeepPartial,
  LoadConfigOptions,
  ResolvedConfig,
  WebVectorConfig,
  WebVectorFileConfig,
  WebVectorFileConfigInput,
} from './config/index.js';
export {
  CONFIG_DESCRIPTIONS,
  CONFIG_FILENAMES,
  CONFIG_SCHEMA_URL,
  CONFIG_SCHEMA_YAML_MODELINE,
  configFromEnv,
  configJsonSchema,
  defineConfig,
  embeddingProviderNames,
  envKeyFor,
  envUrlFor,
  findConfigFile,
  interpolateEnv,
  loadConfig,
  mergeConfig,
  PROVIDER_KEY_ENV,
  PROVIDER_URL_ENV,
  readConfigFile,
  redactConfig,
  rerankerNames,
  searchProviderNames,
  storeProviderNames,
  validateConfig,
  webVectorFileConfigSchema,
} from './config/index.js';
export {
  autoEmbeddingProviderName,
  createEmbeddingProvider,
  customEmbeddingProvider,
  hasLocalRuntime,
  listEmbeddingProviders,
  registerEmbeddingProvider,
  SEMANTIC_UPGRADE_HINT,
} from './embeddings/index.js';
export type { ErrorCode, WebVectorErrorOptions } from './errors.js';
export {
  importOptional,
  missingDependency,
  redactSecrets,
  requireApiKey,
  WebVectorError,
} from './errors.js';
export type {
  FetchedDocument,
  FetchOptions,
  PageLink,
  SliceResult,
} from './pipeline/fetch-options.js';
export {
  excludeFromHtml,
  extractLinks,
  selectFromHtml,
  slicePage,
} from './pipeline/fetch-options.js';
export type { FetchToolOutput, FetchToolStructured } from './pipeline/fetch-tool.js';
export {
  continuationSentence,
  DEFAULT_FETCH_MAX_LENGTH,
  runFetchTool,
} from './pipeline/fetch-tool.js';
export type {
  LinkMode,
  MarkdownRenderOptions,
  PackedPassages,
  RenderedMarkdown,
  ResponseFormat,
} from './pipeline/format.js';
export {
  citationFor,
  packPassages,
  renderMarkdown,
  renderPassage,
  renderResearch,
  suggestedQueriesFor,
  textFragmentUrl,
  transformLinks,
} from './pipeline/format.js';
export type { ToolGuardOptions, UserLocation } from './pipeline/guard.js';
export {
  DOMAIN_NOT_ALLOWED,
  MAX_USES_EXCEEDED,
  parseUserLocation,
  ToolGuard,
} from './pipeline/guard.js';
export type { Session } from './pipeline/session.js';
export { ephemeralSession, SessionRegistry } from './pipeline/session.js';
export type {
  JsonSchema,
  ToolDefinition,
  WebFetchInput,
  WebResearchInput,
  WebResearchSlimOutput,
  WebSearchInput,
  WebVectorToolName,
} from './pipeline/tool.js';
export {
  canonicalToolName,
  DEPTH_PRESETS,
  LEGACY_TOOL_NAMES,
  MAX_DESCRIPTION_BYTES,
  TOOL_NAMES,
  toResearchOptions,
  toSlimOutput,
  WEB_FETCH_DESCRIPTION,
  WEB_FETCH_TOOL_NAME,
  WEB_RESEARCH_DESCRIPTION,
  WEB_RESEARCH_TOOL_NAME,
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_TOOL_NAME,
  WEBVECTOR_STATUS_DESCRIPTION,
  WEBVECTOR_STATUS_TOOL_NAME,
  webFetchInputSchema,
  webFetchToolDefinition,
  webResearchInputSchema,
  webResearchOutputSchema,
  webResearchSlimOutputSchema,
  webResearchToolDefinition,
  webSearchInputSchema,
  webSearchToolDefinition,
} from './pipeline/tool.js';
export type { WebVectorInitOptions } from './pipeline/webvector.js';
export {
  categoryQuery,
  mergeSearchResults,
  objectiveTerms,
  WebVector,
} from './pipeline/webvector.js';
export {
  createReranker,
  customReranker,
  LlmReranker,
  listRerankers,
  registerReranker,
} from './rerankers/index.js';
export type { Evidence as EvidenceVerdict } from './retrieval/evidence.js';
export { assessEvidence } from './retrieval/evidence.js';
export { HeuristicExpander, LlmExpander } from './retrieval/expansion.js';
export type { Highlight } from './retrieval/highlight.js';
export { bestHighlight, segmentText } from './retrieval/highlight.js';
export { BUILTIN_SOURCE_PRIORS } from './retrieval/priors.js';
export type {
  CitationStatus,
  SentenceCheck,
  VerifyOptions,
  VerifyResult,
  VerifySource,
} from './retrieval/verify.js';
export { sourcesFromPassages, verifyCitations } from './retrieval/verify.js';
export type { RuntimeCapabilities } from './runtime.js';
export {
  defaultCacheDir,
  defaultDataDir,
  expandHome,
  importNodeSqlite,
  probeRuntime,
} from './runtime.js';
// Convenience re-exports of factories (full adapter sets live in subpath exports)
export {
  buildSearchStack,
  createSearchProvider,
  customSearchProvider,
  FallbackSearchProvider,
  listSearchProviders,
  registerSearchProvider,
} from './search/index.js';
export {
  createVectorStore,
  listVectorStores,
  MemoryVectorStore,
  registerVectorStore,
} from './stores/index.js';
export type * from './types.js';
export { currentUsage, UsageMeter } from './usage/meter.js';
export type { PriceTable } from './usage/pricing.js';
export {
  DEFAULT_PRICING,
  estimateCostUsd,
  PRICING_AS_OF,
  resolvePricing,
} from './usage/pricing.js';
export type { WebVectorEvents } from './util/events.js';
export { contentHash, sha256, uuidFromString } from './util/hash.js';
export { createLogger, silentLogger } from './util/logger.js';
export {
  canonicalizeUrl,
  hostnameOf,
  matchesDomain,
  normalizeUrl,
  registrableDomain,
} from './util/url.js';
export { cosine, dot, l2Normalize } from './util/vector.js';
