/**
 * Opt-in OpenTelemetry spans (`telemetry.otel: true` / WEBVECTOR_OTEL=1) through
 * `@opentelemetry/api` ONLY — an optional peer. WebVector never registers a provider or exporter:
 * without an SDK set up by the host application every span is a no-op, so "no telemetry, ever"
 * stays true. Span shape (GenAI semantic conventions, still in development upstream):
 *
 *   execute_tool webvector_research          gen_ai.operation.name=execute_tool, gen_ai.tool.name
 *     ├─ search <provider>                    webvector.search.*
 *     ├─ fetch <host>                         webvector.fetch.* (url.full only with captureContent)
 *     ├─ embeddings <model>                   gen_ai.operation.name=embeddings, gen_ai.request.model,
 *     │                                       gen_ai.provider.name, gen_ai.usage.input_tokens (≈)
 *     ├─ rerank <provider>
 *     └─ retrieval                            webvector.retrieve.*
 *
 * Query text / passage excerpts are only attached when `telemetry.captureContent` is on.
 */
import { importOptional } from '../errors.js';
import type { Logger } from '../types.js';

type OtelApi = typeof import('@opentelemetry/api');
type Span = import('@opentelemetry/api').Span;

export type SpanAttributes = Record<string, string | number | boolean | undefined>;

export interface OtelTracerOptions {
  captureContent: boolean;
  version?: string;
}

/** Per-instance tracing helper. `span()` is a pass-through when the API is not loaded. */
export class OtelTracer {
  private constructor(
    private readonly api: OtelApi | undefined,
    readonly captureContent: boolean,
    private readonly version: string,
  ) {}

  /** Load `@opentelemetry/api` lazily; returns a disabled tracer (no-op) when it is missing. */
  static async create(opts: OtelTracerOptions, logger?: Logger): Promise<OtelTracer> {
    try {
      const api = await importOptional<OtelApi>('@opentelemetry/api', 'OpenTelemetry spans');
      if (typeof api?.trace?.getTracer !== 'function') throw new Error('unexpected API shape');
      logger?.debug(
        'telemetry: OpenTelemetry spans enabled (no-op until the host registers an SDK)',
      );
      return new OtelTracer(api, opts.captureContent, opts.version ?? '0.1.0');
    } catch (err) {
      logger?.warn(
        `telemetry.otel is on but @opentelemetry/api is not installed (${err instanceof Error ? err.message : err}); spans disabled. Run: npm i @opentelemetry/api`,
      );
      return new OtelTracer(undefined, opts.captureContent, opts.version ?? '0.1.0');
    }
  }

  static disabled(): OtelTracer {
    return new OtelTracer(undefined, false, '0.1.0');
  }

  get enabled(): boolean {
    return !!this.api;
  }

  /**
   * Run `fn` inside an active span. Attributes with undefined values are dropped; `onEnd` can add
   * result attributes. Errors are recorded and re-thrown.
   */
  async span<T>(
    name: string,
    attributes: SpanAttributes,
    fn: (span: SpanHandle) => Promise<T>,
    kind: 'internal' | 'client' = 'internal',
  ): Promise<T> {
    if (!this.api) return fn(NOOP_HANDLE);
    const api = this.api;
    const tracer = api.trace.getTracer('webvector', this.version);
    return tracer.startActiveSpan(
      name,
      {
        kind: kind === 'client' ? api.SpanKind.CLIENT : api.SpanKind.INTERNAL,
        attributes: clean(attributes),
      },
      async (span: Span) => {
        const handle: SpanHandle = {
          set: (attrs) => span.setAttributes(clean(attrs)),
          event: (n, attrs) => span.addEvent(n, attrs ? clean(attrs) : undefined),
        };
        try {
          const out = await fn(handle);
          span.setStatus({ code: api.SpanStatusCode.OK });
          return out;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({
            code: api.SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }
}

/** Minimal handle exposed to pipeline code (works for the no-op case too). */
export interface SpanHandle {
  set(attrs: SpanAttributes): void;
  event(name: string, attrs?: SpanAttributes): void;
}

const NOOP_HANDLE: SpanHandle = { set: () => {}, event: () => {} };

function clean(attrs: SpanAttributes): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) out[k] = v;
  return out;
}

/** Hostname for `fetch <host>` span names (never throws). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}
