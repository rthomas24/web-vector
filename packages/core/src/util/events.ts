import { EventEmitter } from 'node:events';
import type { Failure, ParsedDocument, ProgressEvent, SearchResult, Stage } from '../types.js';

export interface WebVectorEvents {
  'search:start': { queries: string[]; provider: string };
  'search:complete': { results: SearchResult[]; ms: number; provider: string };
  'page:start': { url: string };
  'page:complete': { url: string; doc: ParsedDocument; ms: number; bytes: number; cached: boolean };
  'page:error': { url: string; failure: Failure };
  'embed:batch': { count: number; ms: number; cached: number };
  'retrieve:complete': { candidates: number; ms: number };
  stage: { stage: Stage; ms: number };
  progress: ProgressEvent;
  warning: { message: string };
}

/** Typed EventEmitter wrapper. */
export class TypedEmitter<Events extends object> {
  private readonly ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(50);
  }
  on<K extends keyof Events & string>(event: K, listener: (payload: Events[K]) => void): this {
    this.ee.on(event, listener as (...args: unknown[]) => void);
    return this;
  }
  once<K extends keyof Events & string>(event: K, listener: (payload: Events[K]) => void): this {
    this.ee.once(event, listener as (...args: unknown[]) => void);
    return this;
  }
  off<K extends keyof Events & string>(event: K, listener: (payload: Events[K]) => void): this {
    this.ee.off(event, listener as (...args: unknown[]) => void);
    return this;
  }
  emit<K extends keyof Events & string>(event: K, payload: Events[K]): boolean {
    return this.ee.emit(event, payload);
  }
  removeAllListeners(): void {
    this.ee.removeAllListeners();
  }
}
