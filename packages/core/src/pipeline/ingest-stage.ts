/**
 * Stages 2+3: turn a fetched page into chunks in a session — chunk → dedupe → embed (with cache)
 * → upsert into the vector store → add to the BM25 side index. Shared by research() and
 * fetchAndRetrieve(). Embedding is skipped in lexical-only mode.
 */
import type { EmbeddingCache } from '../embeddings/base.js';
import { WebVectorError } from '../errors.js';
import { chunkMarkdown } from '../ingest/chunker.js';
import type { CachedPage } from '../ingest/index.js';
import type { MemoryVectorStore } from '../stores/memory.js';
import type { Chunk, Failure, ParsedDocument, SearchResult } from '../types.js';
import { contentHash, sha256 } from '../util/hash.js';
import { canonicalizeUrl } from '../util/url.js';
import type { Components } from './components.js';
import type { Session } from './session.js';

export interface IngestDocumentInput {
  doc: ParsedDocument;
  page: Pick<CachedPage, 'pageHash' | 'fetchedAt'>;
  /** Search result the page came from (rank/provider metadata); optional for direct fetches. */
  result?: Pick<SearchResult, 'rank' | 'source' | 'publishedAt' | 'title'>;
  query: string;
  session: Session;
  chunking: { chunkSize: number; chunkOverlap: number; maxChunks: number; minChunkChars?: number };
  signal?: AbortSignal;
}

export interface EmbedStats {
  chunks: number;
  cached: number;
  batches: number;
  ms: number;
}

/** Chunk a document, embed the new chunks, and register them in the session. */
export async function ingestDocument(
  c: Components,
  cache: EmbeddingCache,
  input: IngestDocumentInput,
): Promise<{ chunks: Chunk[]; embedded: number; stats: EmbedStats }> {
  const { doc, page, result, query, session, chunking, signal } = input;
  const canonical = canonicalizeUrl(doc.url);
  const checkAbort = () => {
    if (signal?.aborted)
      throw new WebVectorError('Ingest aborted', { code: 'ABORTED', stage: 'ingest' });
  };
  checkAbort();
  const title = doc.title || result?.title || doc.url;

  const textChunks = chunkMarkdown(doc.markdown, {
    ...chunking,
    maxChunkChars: c.embedder?.limits().maxInputChars,
    countTokens: c.countTokens,
    title,
  });
  const chunks: Chunk[] = textChunks.map((tc) => {
    const hash = contentHash(tc.text);
    return {
      id: sha256(`${canonical}#${hash}`),
      text: tc.text,
      embedText: tc.embedText,
      metadata: {
        url: doc.url,
        canonicalUrl: canonical,
        title,
        chunkIndex: tc.index,
        totalChunks: textChunks.length,
        startOffset: tc.startOffset,
        endOffset: tc.endOffset,
        contentHash: hash,
        pageHash: page.pageHash,
        fetchedAt: page.fetchedAt,
        searchRank: result?.rank ?? 1,
        searchQuery: query,
        contentType: doc.contentType,
        provider: result?.source ?? 'fetch',
        sessionId: session.id,
        siteName: doc.siteName,
        publishedAt: doc.publishedAt ?? result?.publishedAt,
        lang: doc.lang,
        breadcrumb: tc.breadcrumb,
      },
    };
  });

  const stats: EmbedStats = { chunks: 0, cached: 0, batches: 0, ms: 0 };
  let toEmbed: Chunk[] = [];
  if (c.embedder) {
    // Skip chunks the store already holds (session / persistent modes).
    const existing = session.store.has
      ? await session.store.has(chunks.map((ch) => ch.id))
      : new Set<string>();
    toEmbed = chunks.filter((ch) => !existing.has(ch.id));
    const t0 = Date.now();
    await embedChunks(c.embedder, cache, toEmbed, stats, signal);
    stats.ms = Date.now() - t0;
    stats.chunks = toEmbed.length;
    checkAbort(); // deadline hit while embedding: don't persist partial work into the session
    if (toEmbed.length) await session.store.upsert(toEmbed);
  }

  for (const ch of chunks) {
    if (!session.bm25.has(ch.id)) session.bm25.add(ch.id, bm25FieldsFor(ch));
    if (!session.chunks.has(ch.id)) {
      // Keep the vector handy for MMR (memory store returns it; external stores don't).
      const vector = ch.vector ?? (session.store as MemoryVectorStore).get?.(ch.id)?.vector;
      session.chunks.set(ch.id, vector ? { ...ch, vector } : ch);
    }
  }
  session.urls.add(canonical);
  return { chunks, embedded: toEmbed.length, stats };
}

/** Embed chunks, using the content-hash cache to skip texts embedded before with this model. */
async function embedChunks(
  embedder: NonNullable<Components['embedder']>,
  cache: EmbeddingCache,
  chunks: Chunk[],
  stats: EmbedStats,
  signal?: AbortSignal,
): Promise<void> {
  const texts: string[] = [];
  const pending: Chunk[] = [];
  for (const ch of chunks) {
    const cached = cache.get(embedder.model, ch.metadata.contentHash, 'document');
    if (cached) ch.vector = cached;
    else {
      texts.push(ch.embedText ?? ch.text);
      pending.push(ch);
    }
  }
  stats.cached += chunks.length - texts.length;
  if (texts.length === 0) return;
  const vectors = await embedder.embed(texts, { kind: 'document', signal });
  pending.forEach((ch, i) => {
    ch.vector = vectors[i];
    cache.set(embedder.model, ch.metadata.contentHash, 'document', vectors[i] as Float32Array);
  });
  stats.batches++;
}

/** Errors that mean the whole run cannot continue (as opposed to one bad page). */
export function isFatalIngestError(e: WebVectorError): boolean {
  return (
    e.code === 'EMBEDDING_FAILED' ||
    e.code === 'MISSING_DEPENDENCY' ||
    e.code === 'MISSING_API_KEY' ||
    e.code === 'PROVIDER_AUTH'
  );
}

export function failureFrom(err: unknown, url: string): Failure {
  const e = WebVectorError.from(err, { code: 'FETCH_FAILED', stage: 'ingest' });
  return {
    url,
    code: e.code,
    message: e.message,
    stage: e.stage ?? 'ingest',
    provider: e.provider,
  };
}

/** BM25F fields for a chunk: page title, heading breadcrumb (without the title), body text. */
export function bm25FieldsFor(ch: Chunk): Record<string, string> {
  const title = ch.metadata.title ?? '';
  let crumbs = ch.metadata.breadcrumb ?? '';
  if (title && crumbs.startsWith(title))
    crumbs = crumbs.slice(title.length).replace(/^\s*›\s*/, '');
  return { title, breadcrumb: crumbs, body: ch.text };
}
