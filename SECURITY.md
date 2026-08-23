# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability
reporting on this repository ("Security" → "Report a vulnerability"). You will get an
acknowledgement within a few days; fixes ship as patch releases with a changelog entry crediting the
reporter (unless you prefer otherwise).

Supported: the latest minor release of `webvector`, `webvector-mcp` and `webvector-cli`.

## What WebVector does that matters for security

WebVector **fetches URLs it does not choose** — they come from a search engine, so a page you end up
reading may be adversarial. It also runs as an MCP server that LLM agents drive. The design
therefore assumes hostile pages and hostile tool arguments. Defaults:

| Concern | Default behaviour | Knob |
|---|---|---|
| SSRF (fetching internal hosts) | Refuses non-http(s) schemes, `localhost`/`*.localhost`/`*.internal`, and any IP that is private, loopback, link-local, CGNAT, multicast, reserved, unique-local, IPv4-mapped or IPv4-compatible; the check runs **at connect time inside the DNS lookup used to open the socket** (so a rebinding DNS server cannot swap the address between check and connect) and again on **every redirect hop**; robots.txt goes through the same path and never follows redirects | `ingestion.allowPrivateNetworks` (off) |
| Resource exhaustion | 5 MB per response (streamed and cut, after decompression), 5 redirects, 15 s per request, a 45 s run deadline that **aborts** in-flight work, 8 concurrent fetches, 2 per host, ≤200 chunks and ≤200 PDF pages per page, robots.txt ≤512 KiB, byte-budgeted page cache, bounded sessions; tool arguments (`max_pages`, `top_k`) can only lower the operator's limits | `ingestion.*`, `store.maxSessions` |
| Untrusted content in results | HTML parsed without script execution or sub-resource loading (linkedom); PDFs via pdf.js with `isEvalSupported: false`, page-capped, and torn down after use; every string we return (passages, titles, snippets, metadata) has C0/C1 control characters, zero-width and bidi/format characters stripped and is length-capped; MCP output starts with an "untrusted web content" notice | — |
| Prompt injection from pages | Cannot be prevented by any fetcher; passages are clearly delimited and attributed so the consuming model/app can treat them as data. Treat `passages[].text` as untrusted. | — |
| Secrets | Read from env/config only; never logged; redacted in error messages **and** error details, `webvector config`, and the MCP `webvector_status` tool (which also no longer lists session ids); provider keys are sent in headers, not URLs; caller-supplied headers are dropped on cross-origin redirects. Nothing persisted to disk unless `ingestion.cache.dir` is set (then only parsed page text, in a directory you choose) | `logging.level`, `ingestion.cache.dir` |
| Markets tools (`--tools markets`, opt-in) | Requests go only to the fixed hosts in the source catalog (`markets/sources.ts`), built from URL-encoded, schema-validated tool arguments, through the same SSRF-guarded, rate-limited Fetcher; story bodies are read only through the normal robots-respecting fetch and the server's domain allow/block lists (applied to the unwrapped target of redirect links). Deviations from the defaults above, all declared per source: syndication feeds on crawler-blocking hosts (Yahoo/Seeking Alpha symbol RSS) are fetched with the robots check skipped for that request (`markets.feedRobots: respect` turns them off); gray sources stay off unless the operator sets `markets.graySources`, and two of them (Nasdaq) then send a browser-like User-Agent; SEC hosts get `WebVector/<ver> (<contact>)` with the operator-configured contact only (sanitised to one printable line). Feed/JSON bodies are cached as text in the page-cache database (`markets_cache`, same location rules as the page cache). Every returned string is sanitised and length-capped, output is trimmed to `--max-tokens`, and every tool result carries the untrusted-content notice | `markets.*`, `--allowed-domains`, `ingestion.cache` |
| MCP over HTTP | Binds `127.0.0.1` only (`HOST` env is deliberately ignored); validates `Host` and `Origin` (DNS-rebinding protection); optional bearer token (`--token` / `WEBVECTOR_MCP_TOKEN`, constant-time compared) — **required** together with `--allow-remote` before it will bind to any other address | `--token`, `--allow-remote` |
| Config files | `webvector.config.{js,ts}` are executed (they are code) and are therefore only auto-discovered in the **current directory** or via an explicit path — never from parent directories; JSON/YAML are parsed and discovered up the tree; prototype-polluting keys are ignored | `webvector config` prints what was loaded and from where |
| Robots / etiquette | robots.txt honoured incl. `Crawl-delay`; identifiable User-Agent; per-host interval | `ingestion.respectRobotsTxt`, `ingestion.userAgent` |
| Telemetry | none | — |

## Hardening checklist for operators

- Run the MCP server as a low-privilege user; give it only the API keys it needs.
- Keep `allowPrivateNetworks` off unless the process is isolated from your internal network.
- If you expose `--http` beyond localhost, put it behind authentication and TLS; do not rely on `--allow-remote` alone.
- Prefer environment variables over config files for secrets, and never commit `.env`.
- Pin versions in production and review `npm audit` output for the optional peers you install.
