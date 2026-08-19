/**
 * Stages 2+3: turn a fetched page into chunks in a session — chunk → dedupe → embed (with cache)
 * → upsert into the vector store → add to the BM25 side index. Shared by research() and
 * fetchAndRetrieve(). Embedding is skipped in lexical-only mode.
 */
import type { EmbeddingCache } from '../embeddings/base.js';
import { WebVectorError } from '../errors.js';
import { chunkMarkdown } from '../ingest/chunker.js';
import { HostBoilerplateIndex } from '../ingest/extract-boilerplate.js';
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
  chunking: {
    chunkSize: number;
    chunkOverlap: number;
    maxChunks: number;
    minChunkChars?: number;
    /**
     * Drop chunks whose text (content hash or ≥ 80 % of word shingles) already appeared on another
     * page of the same host in this session — nav, footers, "related" rails — and retract the
     * earlier copies from the lexical index. Code blocks are never dropped. Default true.
     */
    dropSharedBoilerplate?: boolean;
  };
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
  // Dedupe key: the page's declared canonical URL when it has one (merges AMP / mobile / tracking
  // variants), else the normalised fetch URL.
  const urlCanonical = canonicalizeUrl(doc.url);
  const canonical = doc.canonicalUrl ? canonicalizeUrl(doc.canonicalUrl) : urlCanonical;
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
  let chunks: Chunk[] = textChunks.map((tc) => {
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
        updatedAt: doc.updatedAt,
        lang: doc.lang,
        breadcrumb: tc.breadcrumb,
        kind: doc.kind,
        page: pageAt(doc.pages, tc.startOffset),
      },
    };
  });

  // Same-host boilerplate: text repeated across pages of one host is chrome, not content.
  let kept = chunks;
  if (chunking.dropSharedBoilerplate !== false && chunks.length) {
    let index = boilerplateIndexes.get(session);
    if (!index) {
      index = new HostBoilerplateIndex();
      boilerplateIndexes.set(session, index);
    }
    const verdict = index.judge(
      canonical,
      chunks.map((ch) => ({
        id: ch.id,
        url: canonical,
        text: ch.text,
        contentHash: ch.metadata.contentHash,
      })),
    );
    if (verdict.drop.size) kept = chunks.filter((ch) => !verdict.drop.has(ch.id));
    for (const id of verdict.retract) {
      // Earlier copies leave the lexical index and the passage map; vector stores have no delete,
      // so a hybrid run may still see them via the store until the session ends.
      if (session.bm25.has(id)) session.bm25.remove(id);
      session.chunks.delete(id);
    }
  }
  chunks = kept;

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

  const lead = leadTextOf(doc.markdown);
  for (const ch of chunks) {
    if (!session.bm25.has(ch.id)) session.bm25.add(ch.id, bm25FieldsFor(ch, lead));
    if (!session.chunks.has(ch.id)) {
      // Keep the vector handy for MMR (memory store returns it; external stores don't).
      const vector = ch.vector ?? (session.store as MemoryVectorStore).get?.(ch.id)?.vector;
      session.chunks.set(ch.id, vector ? { ...ch, vector } : ch);
    }
  }
  session.urls.add(canonical);
  session.urls.add(urlCanonical);
  return { chunks, embedded: toEmbed.length, stats };
}

/** PDF page (1-based) containing markdown offset `offset`, from the parser's page boundaries. */
export function pageAt(
  pages: { start: number; page: number }[] | undefined,
  offset: number,
): number | undefined {
  if (!pages?.length) return undefined;
  let page: number | undefined;
  for (const p of pages) {
    if (p.start > offset) break;
    page = p.page;
  }
  return page;
}

/** Per-session host → seen-chunk index for boilerplate suppression (GC'd with the session). */
const boilerplateIndexes = new WeakMap<Session, HostBoilerplateIndex>();

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

/**
 * BM25F fields for a chunk: page title, heading breadcrumb (without the title), the page's lead
 * text (contextual-retrieval "lite": what the page is about, for chunks deep inside it), body.
 */
export function bm25FieldsFor(ch: Chunk, lead?: string): Record<string, string> {
  const title = ch.metadata.title ?? '';
  let crumbs = ch.metadata.breadcrumb ?? '';
  if (title && crumbs.startsWith(title))
    crumbs = crumbs.slice(title.length).replace(/^\s*›\s*/, '');
  const fields: Record<string, string> = { title, breadcrumb: crumbs, body: ch.text };
  if (lead && ch.metadata.chunkIndex > 0) fields.lead = lead;
  return fields;
}

/** First ~N chars of prose from a page (skipping headings, images, tables and link-only lines). */
export function leadTextOf(markdown: string, maxChars = 240): string {
  let out = '';
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('![') || line.startsWith('|')) continue;
    if (line.startsWith('[') || line.length < 40) continue;
    out += `${line} `;
    if (out.length >= maxChars) break;
  }
  return out.slice(0, maxChars).trim();
}
