# Changelog

All notable changes to `@sibylline-labs/hera` are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While
the version is 0.x, a minor release may break the API.

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
