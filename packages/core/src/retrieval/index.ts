export { BM25Index, lightStem, tokenize } from './bm25.js';
export type { AssessOptions, Evidence, EvidenceLevel, EvidenceSignals } from './evidence.js';
export { assessEvidence, bridgeEntities, prfTerms } from './evidence.js';
export { HeuristicExpander, LlmExpander } from './expansion.js';
export type { Adjacent, Aspect, MmrOptions, Ranked } from './fusion.js';
export {
  autocut,
  dbsfNormalize,
  dedupeChunks,
  diversifyBySource,
  groupAdjacent,
  joinAdjacentText,
  minMaxNormalize,
  mmr,
  rrf,
  scoreFusion,
  shingleJaccard,
  xquad,
} from './fusion.js';
export type { Highlight, HighlightOptions, ScoredWindow, Segment } from './highlight.js';
export { bestHighlight, rankHighlightWindows, segmentText } from './highlight.js';
export type { CompiledPrior } from './priors.js';
export {
  BUILTIN_SOURCE_PRIORS,
  compileSourcePriors,
  isPrimaryFor,
  sourcePriorFor,
} from './priors.js';
