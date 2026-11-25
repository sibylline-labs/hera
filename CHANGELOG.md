# Changelog

All notable changes to `@sibylline-labs/hera` are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While
the version is 0.x, a minor release may break the API.

## [Unreleased]

### Changed

- Rewrote `README.md` around what Hera is, why it exists, and concrete use cases; moved the full subpath exports and ambient-type tables into `docs/README.md` and refreshed `docs/ARCHITECTURE.md`.

## [0.2.1] - 2026-11-24

### Added

- `hasSqlTable` and `hasSqlTableTx` helpers on `@sibylline-labs/hera/durable-object`.
- `HeraHttp.createOnce`: idempotent create under a client-chosen identifier with read-back disambiguation on failure.
- `HeraHttp.connectionPages`: paginated GraphQL connection reader with per-page hook, page cap, and missing-cursor refusal.
- Plain-stub Durable Object doors (`runDoor`, `runDoorSync`, `HeraDurableObjectBase.runDoor`/`runDoorSync`) and `propagatingStub` (`HeraFilledStub`, `givenOptional`) for tracing raw-value DO calls under the caller's W3C `traceparent`.
- Ordered outbox enqueues (`tx.enqueueOutbox({ ordered: true, ... })`) backed by a persistent per-object SQLite sequence and `HeraOutbox.seedSequenceSql`.
- `HeraConfig.dials` and `HeraConfig.dialReaders`: JSON-object Logfire managed variable groups merged over code defaults with shared per-`(base, token)` readers.
- A failed span exports the code-shaped fields of its catalogued error as `error.field.<key>` beside `error.code`.
- `.github/workflows/release.yml` for OIDC trusted publishing of `@sibylline-labs/hera` to npm with provenance, `ci.yml` `npm-pack` verification, `docs/dev/RELEASING.md`, and the `0.x` stability policy in `README.md`.

### Changed

- `package.json` declares an explicit `files` allowlist (`src`, `docs`, `rules`, `skills`, `LICENSE`, `README.md`, `CHANGELOG.md`) and `publishConfig.access: "public"`, shrinking the published tarball to runtime source, docs, rules, and skills.

## [0.2.0] - 2026-11-11

The first public release, under the MIT License.

### Changed

- **Breaking:** `Hera.getTenantStub`'s local-workerd jurisdiction fallback
  reads `HERA_LOCAL_WORKERD`. It previously read a product-specific variable
  name; set `HERA_LOCAL_WORKERD` in `.dev.vars` instead.
- **Breaking:** `normalizeServiceSlug`, and the RPC test double built on it, no
  longer strip a product-specific service-name prefix, so a prefixed service
  name keeps the prefix in its `<slug>_unavailable` error code.
- `DEFAULT_ERIS_DOCS_BASE` points at the public eris repository.
- `SAMPLE_IDS.linearIdentifier` is `ABC-123`.
- `package.json` declares `"license": "MIT"` and the public repository.
- `bun run lint` no longer runs `eris config validate`.

### Removed

- **Breaking:** product wire contracts (and their OpenAPI operation tables)
  left the package. They live in the packages of the products that own them.

## [0.1.0]

The private baseline that consumers pinned by git SHA.
