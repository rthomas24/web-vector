import { envKeyFor, envUrlFor } from '../config/env.js';
import { WebVectorError } from '../errors.js';
import type { Logger, VectorStore } from '../types.js';
import {
  ChromaVectorStore,
  type ExternalStoreOptions,
  PgVectorStore,
  QdrantVectorStore,
} from './external.js';
import { MemoryVectorStore } from './memory.js';

export type { ExternalStoreOptions } from './external.js';
export { ChromaVectorStore, PgVectorStore, QdrantVectorStore } from './external.js';
export { buildFilter, MemoryVectorStore } from './memory.js';

export interface StoreFactoryOptions extends ExternalStoreOptions {
  logger?: Logger;
}

type Factory = (opts: StoreFactoryOptions) => VectorStore;

const registry = new Map<string, Factory>([
  ['memory', () => new MemoryVectorStore()],
  ['chroma', (o) => new ChromaVectorStore(o)],
  ['qdrant', (o) => new QdrantVectorStore(o)],
  ['pgvector', (o) => new PgVectorStore(o)],
  ['postgres', (o) => new PgVectorStore(o)],
]);

export function registerVectorStore(name: string, factory: Factory): void {
  registry.set(name, factory);
}
export function listVectorStores(): string[] {
  return [...registry.keys()];
}
export function createVectorStore(name: string, opts: StoreFactoryOptions = {}): VectorStore {
  const factory = registry.get(name);
  if (!factory) {
    throw new WebVectorError(`Unknown vector store "${name}".`, {
      code: 'UNKNOWN_PROVIDER',
      remediation: `Use one of: ${listVectorStores().join(', ')} — or register a custom one with registerVectorStore().`,
    });
  }
  return factory({
    ...opts,
    apiKey: opts.apiKey ?? envKeyFor(name),
    url: opts.url ?? envUrlFor(name),
  });
}
