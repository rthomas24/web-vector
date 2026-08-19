export { BM25Index, lightStem, tokenize } from './bm25.js';
export { HeuristicExpander, LlmExpander } from './expansion.js';
export type { Adjacent, MmrOptions, Ranked } from './fusion.js';
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
} from './fusion.js';
export type { Highlight, HighlightOptions, ScoredWindow, Segment } from './highlight.js';
export { bestHighlight, rankHighlightWindows, segmentText } from './highlight.js';
