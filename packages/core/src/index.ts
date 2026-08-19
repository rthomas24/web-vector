/**
 * webvector — provider-agnostic web research for AI agents.
 *
 * search → full-page ingestion → embeddings → hybrid semantic retrieval → cited passages.
 */

export type {
  DeepPartial,
  LoadConfigOptions,
  ResolvedConfig,
  WebVectorConfig,
  WebVectorFileConfig,
  WebVectorFileConfigInput,
} from './config/index.js';
export {
  CONFIG_FILENAMES,
  configFromEnv,
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
  RenderedMarkdown,
  ResponseFormat,
} from './pipeline/format.js';
export {
  citationFor,
  renderMarkdown,
  renderPassage,
  renderResearch,
  suggestedQueriesFor,
  textFragmentUrl,
  transformLinks,
} from './pipeline/format.js';
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
export { mergeSearchResults, WebVector } from './pipeline/webvector.js';
export {
  createReranker,
  customReranker,
  LlmReranker,
  listRerankers,
  registerReranker,
} from './rerankers/index.js';
export { HeuristicExpander, LlmExpander } from './retrieval/expansion.js';
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
