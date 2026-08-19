# Contributing

Thanks for helping. The short version: keep it small, keep it tested, keep it dependency-light.

## Setup

```bash
git clone https://github.com/rthomas24/web-vector && cd webvector
npm install && npm run build
npm test            # offline unit tests (~5 s)
npm run test:live   # real network + local model; provider tests auto-skip without their key
npm run lint && npm run typecheck
```

Node ≥ 22.12. The repo is npm workspaces: `packages/core` (`webvector`), `packages/mcp`, `packages/cli`, `examples/`.

## Where things live

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — it maps every directory and the five pipeline stages. Config options: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Adding a provider

1. Implement the interface from `packages/core/src/types.ts` in one file under `search/`, `embeddings/`, `stores/` or `rerankers/`.
2. Register it in that directory's `index.ts` and add its env var(s) to `config/env.ts`.
3. Heavy dependency? Load it lazily with `importOptional()` and add it to `peerDependencies` (optional) — never to `dependencies`.
4. Add a unit test with mocked HTTP (`msw`) next to the others in `packages/core/test/`, and a live conformance entry in `e2e.live.test.ts` gated on the env var.
5. Document it in `docs/PROVIDERS.md`.

## Rules of the road

- Per-page problems become `failures[]`; only config/auth/provider errors throw. Every thrown error is a `WebVectorError` with a `code` and a `remediation`.
- No new runtime dependencies without a discussion — the zero-key, ~12 MB install is a feature.
- Biome formats and lints; TypeScript strict; tests must pass offline.
- Use [changesets](https://github.com/changesets/changesets): `npx changeset` in your PR describes the user-visible change.

## Reporting security issues

See [SECURITY.md](SECURITY.md) — private advisory, not a public issue.

## Retrieval eval

Ranking and extraction changes must not regress the offline eval (`npm run eval`, see
[`eval/README.md`](eval/README.md)). It replays recorded HTTP fixtures, so it needs no network and
runs in CI. If a change intentionally moves the numbers, run `npm run eval -- --update-baseline` and
commit `eval/baseline.json` in the same PR with a note on why.
