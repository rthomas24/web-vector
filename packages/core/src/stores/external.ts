import { importOptional, WebVectorError } from '../errors.js';
import type {
  Chunk,
  ChunkMetadata,
  Logger,
  ScoredChunk,
  VectorStore,
  VectorStoreCapabilities,
  VectorStoreQueryOptions,
} from '../types.js';
import { uuidFromString } from '../util/hash.js';

export interface ExternalStoreOptions {
  url?: string;
  apiKey?: string;
  collection?: string;
  logger?: Logger;
  options?: Record<string, unknown>;
}

const SENTINEL_ID = '__webvector_meta__';

function flattenMeta(m: ChunkMetadata): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(m)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else out[k] = JSON.stringify(v);
  }
  return out;
}

function mismatch(
  store: string,
  existingModel: string,
  existingDims: number,
  model: string,
  dims: number,
  collection: string,
): WebVectorError {
  return new WebVectorError(
    `${store} collection "${collection}" was created with ${existingModel} (${existingDims} dims); current embedding model is ${model} (${dims} dims).`,
    {
      code: 'EMBEDDING_DIMENSION_MISMATCH',
      provider: store,
      remediation: `Call store.clear() to reset the collection, or use a new \`store.collection\` name for the new model.`,
    },
  );
}

// ─── Chroma ─────────────────────────────────────────────────────────────────

/** Chroma (chromadb ≥3). Local server: `npx chroma run --path ./.chroma` or docker `chromadb/chroma`. */
export class ChromaVectorStore implements VectorStore {
  readonly id = 'chroma';
  private client?: any;
  private col?: any;
  private readonly collection: string;
  constructor(private readonly opts: ExternalStoreOptions = {}) {
    this.collection = opts.collection ?? 'webvector';
  }
  capabilities(): VectorStoreCapabilities {
    return { persistent: true, supportsFilter: true, supportsHas: true };
  }
  private async ensureClient(): Promise<any> {
    if (this.client) return this.client;
    const mod: any = await importOptional('chromadb', 'the Chroma vector store', this.id);
    const url = this.opts.url ?? process.env.CHROMA_URL;
    if (this.opts.apiKey && !url) {
      this.client = new mod.CloudClient({ apiKey: this.opts.apiKey, ...(this.opts.options ?? {}) });
    } else {
      const u = new URL(url ?? 'http://localhost:8000');
      this.client = new mod.ChromaClient({
        host: u.hostname,
        port: Number(u.port || (u.protocol === 'https:' ? 443 : 8000)),
        ssl: u.protocol === 'https:',
        headers: this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : undefined,
        ...(this.opts.options ?? {}),
      });
    }
    return this.client;
  }
  async init(dimensions: number, embeddingModel: string): Promise<void> {
    const client = await this.ensureClient();
    try {
      this.col = await client.getOrCreateCollection({
        name: this.collection,
        configuration: { hnsw: { space: 'cosine' } },
        embeddingFunction: null,
        metadata: { 'hnsw:space': 'cosine' },
      });
    } catch (err) {
      throw new WebVectorError(
        `Cannot connect to Chroma: ${err instanceof Error ? err.message : err}`,
        {
          code: 'STORE_ERROR',
          provider: this.id,
          remediation:
            'Start a Chroma server (`npx chroma run --path ./.chroma` or `docker run -p 8000:8000 chromadb/chroma`) and set CHROMA_URL / store.url.',
          cause: err,
        },
      );
    }
    const meta = await this.col.get({ ids: [SENTINEL_ID], include: ['metadatas'] });
    const existing = meta?.metadatas?.[0];
    if (existing?.dims && (existing.dims !== dimensions || existing.model !== embeddingModel)) {
      throw mismatch(
        'Chroma',
        existing.model,
        existing.dims,
        embeddingModel,
        dimensions,
        this.collection,
      );
    }
    if (!existing) {
      await this.col.upsert({
        ids: [SENTINEL_ID],
        embeddings: [new Array(dimensions).fill(0)],
        metadatas: [{ dims: dimensions, model: embeddingModel, sentinel: true }],
        documents: ['webvector metadata'],
      });
    }
  }
  async has(ids: string[]): Promise<Set<string>> {
    if (!this.col || ids.length === 0) return new Set();
    const r = await this.col.get({ ids, include: [] });
    return new Set<string>(r?.ids ?? []);
  }
  async upsert(chunks: Chunk[]): Promise<void> {
    if (!this.col)
      throw new WebVectorError('Chroma store not initialised (call init).', {
        code: 'STORE_ERROR',
        provider: this.id,
      });
    for (let i = 0; i < chunks.length; i += 200) {
      const batch = chunks.slice(i, i + 200);
      await this.col.upsert({
        ids: batch.map((c) => c.id),
        embeddings: batch.map((c) => Array.from(c.vector as Float32Array)),
        metadatas: batch.map((c) => flattenMeta(c.metadata)),
        documents: batch.map((c) => c.text),
      });
    }
  }
  async query(vector: Float32Array, opts: VectorStoreQueryOptions): Promise<ScoredChunk[]> {
    if (!this.col) return [];
    const where: Record<string, unknown>[] = [{ sentinel: { $ne: true } }];
    const sid = opts.filter?.sessionId ?? opts.sessionId;
    if (sid) where.push({ sessionId: sid });
    if (opts.filter?.urls?.length) where.push({ url: { $in: opts.filter.urls } });
    for (const [k, v] of Object.entries(opts.filter?.where ?? {})) where.push({ [k]: v });
    const res = await this.col.query({
      queryEmbeddings: [Array.from(vector)],
      nResults: opts.topK,
      where: where.length === 1 ? where[0] : { $and: where },
      include: ['documents', 'metadatas', 'distances'],
    });
    const ids: string[] = res.ids?.[0] ?? [];
    return ids.map((id, i) => ({
      id,
      text: res.documents?.[0]?.[i] ?? '',
      metadata: res.metadatas?.[0]?.[i] as ChunkMetadata,
      score: 1 - (res.distances?.[0]?.[i] ?? 1),
    }));
  }
  async clear(sessionId?: string): Promise<void> {
    if (!this.col) await this.ensureClient();
    if (!sessionId) {
      await this.client.deleteCollection({ name: this.collection });
      this.col = undefined;
      return;
    }
    await this.col?.delete({ where: { sessionId } });
  }
}

// ─── Qdrant ─────────────────────────────────────────────────────────────────

/** Qdrant (`@qdrant/js-client-rest` ≥1.19, uses `query()`). Local: `docker run -p 6333:6333 qdrant/qdrant`. */
export class QdrantVectorStore implements VectorStore {
  readonly id = 'qdrant';
  private client?: any;
  private readonly collection: string;
  private ready = false;
  constructor(private readonly opts: ExternalStoreOptions = {}) {
    this.collection = opts.collection ?? 'webvector';
  }
  capabilities(): VectorStoreCapabilities {
    return { persistent: true, supportsFilter: true, supportsHas: true };
  }
  private async ensureClient(): Promise<any> {
    if (this.client) return this.client;
    const mod: any = await importOptional(
      '@qdrant/js-client-rest',
      'the Qdrant vector store',
      this.id,
    );
    this.client = new mod.QdrantClient({
      url: this.opts.url ?? process.env.QDRANT_URL ?? 'http://localhost:6333',
      apiKey: this.opts.apiKey ?? process.env.QDRANT_API_KEY,
      ...(this.opts.options ?? {}),
    });
    return this.client;
  }
  async init(dimensions: number, embeddingModel: string): Promise<void> {
    const q = await this.ensureClient();
    try {
      const { exists } = await q.collectionExists(this.collection);
      if (!exists) {
        await q.createCollection(this.collection, {
          vectors: { size: dimensions, distance: 'Cosine' },
        });
        await q
          .createPayloadIndex(this.collection, {
            field_name: 'sessionId',
            field_schema: 'keyword',
            wait: true,
          })
          .catch(() => {});
        await q.upsert(this.collection, {
          wait: true,
          points: [
            {
              id: uuidFromString(SENTINEL_ID),
              vector: new Array(dimensions).fill(0),
              payload: { sentinel: true, dims: dimensions, model: embeddingModel },
            },
          ],
        });
      } else {
        const info = await q.getCollection(this.collection);
        const size = info?.config?.params?.vectors?.size;
        if (typeof size === 'number' && size !== dimensions)
          throw mismatch(
            'Qdrant',
            'previous model',
            size,
            embeddingModel,
            dimensions,
            this.collection,
          );
        const sentinel = await q
          .retrieve(this.collection, { ids: [uuidFromString(SENTINEL_ID)], with_payload: true })
          .catch(() => []);
        const p = sentinel?.[0]?.payload;
        if (p?.model && p.model !== embeddingModel)
          throw mismatch('Qdrant', p.model, p.dims, embeddingModel, dimensions, this.collection);
      }
      this.ready = true;
    } catch (err) {
      if (WebVectorError.is(err)) throw err;
      throw new WebVectorError(
        `Cannot connect to Qdrant: ${err instanceof Error ? err.message : err}`,
        {
          code: 'STORE_ERROR',
          provider: this.id,
          remediation:
            'Start Qdrant (`docker run -p 6333:6333 qdrant/qdrant`) or set QDRANT_URL/QDRANT_API_KEY for Qdrant Cloud.',
          cause: err,
        },
      );
    }
  }
  private pid(id: string): string {
    return uuidFromString(id);
  }
  async has(ids: string[]): Promise<Set<string>> {
    if (!this.ready || ids.length === 0) return new Set();
    const pts = await this.client.retrieve(this.collection, {
      ids: ids.map((i) => this.pid(i)),
      with_payload: ['chunkId'],
    });
    return new Set<string>((pts ?? []).map((p: any) => p.payload?.chunkId).filter(Boolean));
  }
  async upsert(chunks: Chunk[]): Promise<void> {
    if (!this.ready)
      throw new WebVectorError('Qdrant store not initialised (call init).', {
        code: 'STORE_ERROR',
        provider: this.id,
      });
    for (let i = 0; i < chunks.length; i += 200) {
      const batch = chunks.slice(i, i + 200);
      await this.client.upsert(this.collection, {
        wait: true,
        points: batch.map((c) => ({
          id: this.pid(c.id),
          vector: Array.from(c.vector as Float32Array),
          payload: { chunkId: c.id, text: c.text, ...flattenMeta(c.metadata) },
        })),
      });
    }
  }
  async query(vector: Float32Array, opts: VectorStoreQueryOptions): Promise<ScoredChunk[]> {
    if (!this.ready) return [];
    const must: any[] = [];
    const mustNot: any[] = [{ key: 'sentinel', match: { value: true } }];
    const sid = opts.filter?.sessionId ?? opts.sessionId;
    if (sid) must.push({ key: 'sessionId', match: { value: sid } });
    if (opts.filter?.urls?.length) must.push({ key: 'url', match: { any: opts.filter.urls } });
    for (const [k, v] of Object.entries(opts.filter?.where ?? {}))
      must.push({ key: k, match: { value: v } });
    const res = await this.client.query(this.collection, {
      query: Array.from(vector),
      limit: opts.topK,
      with_payload: true,
      filter: { must, must_not: mustNot },
    });
    const points: any[] = res?.points ?? [];
    return points.map((p) => {
      const { chunkId, text, ...meta } = p.payload ?? {};
      return {
        id: chunkId ?? String(p.id),
        text: text ?? '',
        metadata: meta as ChunkMetadata,
        score: p.score,
      };
    });
  }
  async clear(sessionId?: string): Promise<void> {
    const q = await this.ensureClient();
    if (!sessionId) {
      await q.deleteCollection(this.collection).catch(() => {});
      this.ready = false;
      return;
    }
    await q.delete(this.collection, {
      wait: true,
      filter: { must: [{ key: 'sessionId', match: { value: sessionId } }] },
    });
  }
}

// ─── pgvector ───────────────────────────────────────────────────────────────

/** pgvector via `pg` + `pgvector`. Table `<collection>` with HNSW cosine index (halfvec for >2000 dims). */
export class PgVectorStore implements VectorStore {
  readonly id = 'pgvector';
  private pool?: any;
  private readonly table: string;
  private dims = 0;
  private toSql?: (v: number[]) => string;
  constructor(private readonly opts: ExternalStoreOptions = {}) {
    const name = (opts.collection ?? 'webvector_chunks').replace(/[^a-zA-Z0-9_]/g, '_');
    this.table = name;
  }
  capabilities(): VectorStoreCapabilities {
    return { persistent: true, supportsFilter: true, supportsHas: true };
  }
  private async ensurePool(): Promise<any> {
    if (this.pool) return this.pool;
    const pg: any = await importOptional('pg', 'the pgvector store', this.id);
    const pgvector: any = await importOptional('pgvector/pg', 'the pgvector store', this.id);
    const connectionString =
      this.opts.url ??
      process.env.PGVECTOR_URL ??
      process.env.DATABASE_URL ??
      process.env.POSTGRES_URL;
    if (!connectionString) {
      throw new WebVectorError('pgvector store requires a connection string.', {
        code: 'INVALID_CONFIG',
        provider: this.id,
        remediation:
          'Set DATABASE_URL / PGVECTOR_URL or `store.url` (postgres://user:pass@host:5432/db).',
      });
    }
    const Pool = pg.Pool ?? pg.default?.Pool;
    this.pool = new Pool({ connectionString, ...(this.opts.options ?? {}) });
    this.pool.on('connect', (client: any) => pgvector.registerTypes(client).catch(() => {}));
    this.toSql = pgvector.toSql;
    return this.pool;
  }
  async init(dimensions: number, embeddingModel: string): Promise<void> {
    const pool = await this.ensurePool();
    this.dims = dimensions;
    const type = dimensions > 2000 ? 'halfvec' : 'vector';
    const ops = dimensions > 2000 ? 'halfvec_cosine_ops' : 'vector_cosine_ops';
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${this.table} (id text PRIMARY KEY, session_id text, url text, title text, content text, metadata jsonb, embedding ${type}(${dimensions}))`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS ${this.table}_embedding_idx ON ${this.table} USING hnsw (embedding ${ops})`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS ${this.table}_session_idx ON ${this.table} (session_id)`,
      );
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${this.table}_meta (key text PRIMARY KEY, value text)`,
      );
      const { rows } = await pool.query(
        `SELECT key, value FROM ${this.table}_meta WHERE key IN ('model','dims')`,
      );
      const meta = Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
      if (meta.dims && (Number(meta.dims) !== dimensions || meta.model !== embeddingModel))
        throw mismatch(
          'pgvector',
          meta.model,
          Number(meta.dims),
          embeddingModel,
          dimensions,
          this.table,
        );
      if (!meta.dims)
        await pool.query(
          `INSERT INTO ${this.table}_meta (key, value) VALUES ('model',$1),('dims',$2) ON CONFLICT (key) DO NOTHING`,
          [embeddingModel, String(dimensions)],
        );
    } catch (err) {
      if (WebVectorError.is(err)) throw err;
      throw new WebVectorError(
        `pgvector initialisation failed: ${err instanceof Error ? err.message : err}`,
        {
          code: 'STORE_ERROR',
          provider: this.id,
          remediation:
            'Ensure the database is reachable and the `vector` extension can be created (superuser or Neon/Supabase have it available).',
          cause: err,
        },
      );
    }
  }
  async has(ids: string[]): Promise<Set<string>> {
    if (!this.pool || ids.length === 0) return new Set();
    const { rows } = await this.pool.query(`SELECT id FROM ${this.table} WHERE id = ANY($1)`, [
      ids,
    ]);
    return new Set<string>(rows.map((r: any) => r.id));
  }
  async upsert(chunks: Chunk[]): Promise<void> {
    if (!this.pool)
      throw new WebVectorError('pgvector store not initialised (call init).', {
        code: 'STORE_ERROR',
        provider: this.id,
      });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const c of chunks) {
        await client.query(
          `INSERT INTO ${this.table} (id, session_id, url, title, content, metadata, embedding) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO UPDATE SET session_id = EXCLUDED.session_id, content = EXCLUDED.content, metadata = EXCLUDED.metadata, embedding = EXCLUDED.embedding`,
          [
            c.id,
            c.metadata.sessionId ?? null,
            c.metadata.url,
            c.metadata.title,
            c.text,
            JSON.stringify(c.metadata),
            this.toSql!(Array.from(c.vector as Float32Array)),
          ],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new WebVectorError(
        `pgvector upsert failed: ${err instanceof Error ? err.message : err}`,
        { code: 'STORE_ERROR', provider: this.id, cause: err },
      );
    } finally {
      client.release();
    }
  }
  async query(vector: Float32Array, opts: VectorStoreQueryOptions): Promise<ScoredChunk[]> {
    if (!this.pool) return [];
    const params: unknown[] = [this.toSql!(Array.from(vector))];
    const where: string[] = [];
    const sid = opts.filter?.sessionId ?? opts.sessionId;
    if (sid) {
      params.push(sid);
      where.push(`session_id = $${params.length}`);
    }
    if (opts.filter?.urls?.length) {
      params.push(opts.filter.urls);
      where.push(`url = ANY($${params.length})`);
    }
    for (const [k, v] of Object.entries(opts.filter?.where ?? {})) {
      params.push(k, String(v));
      where.push(`metadata->>$${params.length - 1} = $${params.length}`);
    }
    params.push(opts.topK);
    const sql = `SELECT id, content, metadata, 1 - (embedding <=> $1) AS score FROM ${this.table} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY embedding <=> $1 LIMIT $${params.length}`;
    const { rows } = await this.pool.query(sql, params);
    return rows.map((r: any) => ({
      id: r.id,
      text: r.content,
      metadata: r.metadata as ChunkMetadata,
      score: Number(r.score),
    }));
  }
  async clear(sessionId?: string): Promise<void> {
    const pool = await this.ensurePool();
    if (!sessionId) {
      await pool.query(`DROP TABLE IF EXISTS ${this.table}`);
      await pool.query(`DROP TABLE IF EXISTS ${this.table}_meta`);
      return;
    }
    await pool.query(`DELETE FROM ${this.table} WHERE session_id = $1`, [sessionId]);
  }
  async close(): Promise<void> {
    await this.pool?.end?.();
    this.pool = undefined;
  }
}
