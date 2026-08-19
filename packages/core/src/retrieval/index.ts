export { BM25Index, lightStem, tokenize } from './bm25.js';
export { HeuristicExpander, LlmExpander } from './expansion.js';
export type { MmrOptions, Ranked } from './fusion.js';
export {
  autocut,
  dbsfNormalize,
  dedupeChunks,
  diversifyBySource,
  minMaxNormalize,
  mmr,
  rrf,
  scoreFusion,
  shingleJaccard,
} from './fusion.js';
