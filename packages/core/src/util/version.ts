import { createRequire } from 'node:module';

/** Package version (read from package.json at load time; falls back to a static value). */
export const WEBVECTOR_VERSION: string = (() => {
  try {
    const pkg = createRequire(import.meta.url)('../../package.json') as { version?: string };
    if (typeof pkg.version === 'string') return pkg.version;
  } catch {
    /* bundled or relocated: fall through */
  }
  return '0.1.0';
})();

/** Self-describing default User-Agent (see docs/CONFIGURATION.md → ingestion.userAgent). */
export const DEFAULT_USER_AGENT = `WebVector/${WEBVECTOR_VERSION} (+https://github.com/rthomas24/web-vector; user-directed research agent)`;
