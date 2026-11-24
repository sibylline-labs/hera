# Releasing `@sibylline-labs/hera`

A release is a git tag on the public repository (`sibylline-labs/hera`). Pushing
`vMAJOR.MINOR.PATCH` (or `vMAJOR.MINOR.PATCH-prerelease`) runs
[`.github/workflows/release.yml`](../../.github/workflows/release.yml), which verifies
the tree, creates or updates the GitHub release, and publishes `@sibylline-labs/hera`
to npm with provenance through GitHub Actions trusted publishing (OIDC).

## 0.x stability policy

While `@sibylline-labs/hera` is on `0.x`:

- **Breaking changes come with a minor bump (`0.x.0`).** Every breaking change is
  recorded under `### Changed` or `### Removed` in [CHANGELOG.md](../../CHANGELOG.md).
- **Bug fixes and backwards-compatible additive changes ship in patch releases
  (`0.x.y`).**
- Pre-release tags (`v0.3.0-rc.1`) publish under the npm `next` dist-tag and are marked
  pre-release on GitHub, so `latest` never resolves to one.

## Cutting a release

From a clean checkout of `sibylline-labs/hera` on `main`:

```bash
git tag v0.2.1 && git push origin v0.2.1
```

A tag must match `^v[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$`.
The `plan` job refuses any other tag before running verification.

To publish a pre-release from a ref without pushing a tag first, or to re-run an existing
release, dispatch the workflow:

```bash
gh workflow run release.yml --repo sibylline-labs/hera --ref main -f tag=v0.3.0-rc.1 -f prerelease=true
```

Dispatching over a tag that already exists is refused unless the dispatched ref is that
tag's commit (`--ref <tag>`), so one tag can never publish two different trees.

## What `release.yml` does

1. **`plan`** runs only when the repository is public (`!github.event.repository.private`),
   validates the tag grammar and existing-tag commit binding, and resolves `prerelease`.
2. **`verify`** checks out the commit, installs Bun `1.4.4`, Node `24`, and pinned
   `ast-grep` + `gitleaks` binaries (verified by SHA-256), then runs
   `bun install --frozen-lockfile`, `bun run typecheck`, `bun run lint`, `bun run test`,
   and `gitleaks dir` over `git archive HEAD`. Any failure blocks release and publish.
3. **`publish`** is the only job with `contents: write`. It runs no repository code and
   creates or updates the GitHub release for `$TAG`.
4. **`npm`** waits on `plan`, `verify`, and `publish`. It is the only job with
   `id-token: write`, runs on `ubuntu-latest` with Node `24` (npm `>= 11.5.1`), checks
   whether `@sibylline-labs/hera@<version>` is already on npm (making re-runs idempotent),
   stamps `${TAG#v}` into `package.json` with `--no-git-tag-version --ignore-scripts --allow-same-version`,
   runs `npm publish --dry-run --ignore-scripts --tag <dist>`, and publishes with
   `npm publish --access public --ignore-scripts --tag <dist>`.

Every action in `.github/workflows/*.yml` is pinned to a 40-hex commit SHA, no job reads
any secret, and no step in `npm` runs `bun`, `node`, `npx`, or npm lifecycle scripts
(`test/hygiene/workflows.test.ts`).

## The npm package

`@sibylline-labs/hera` ships TypeScript source directly under `exports` (`./src/...`).
`package.json` `"files"` is the explicit allow-list (`src`, `docs`, `rules`, `skills`,
`LICENSE`, `README.md`, `CHANGELOG.md`):

- `test/hygiene/package.test.ts` runs `npm pack --dry-run --json --ignore-scripts --offline`
  and fails if any `exports` target or required doc/rule/skill is missing, or if tests,
  workflows, lockfiles, or maintainer configs leak into the tarball.
- `.github/workflows/ci.yml`'s `npm-pack` job packs the tarball on every pull request,
  dry-run publishes it under a synthetic `0.0.0-ci-dry-run` version, installs the tarball
  into an isolated consumer directory, and verifies subpath resolution.
- `package.json` keeps `repository.url` in npm's normalized form
  (`git+https://github.com/sibylline-labs/hera.git`), because npm rejects OIDC trusted
  publishing when `repository.url` disagrees with the publishing repository.

## Trusted publishing setup and verification

The `npm` job holds no `NPM_TOKEN`. It uses
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers), which exchanges the
job's GitHub OIDC token for a short-lived publish credential and attaches a SLSA
provenance attestation automatically (no `--provenance` flag needed).

One-time setup on npmjs.com:

1. **Bootstrap publish** the package once by hand (only needed to create the package
   record before configuring trusted publishing).
2. **Configure Trusted Publisher** at npmjs.com -> `@sibylline-labs/hera` -> Settings ->
   Trusted publishing -> GitHub Actions:
   - Organization / user: `sibylline-labs`
   - Repository: `hera`
   - Workflow filename: `release.yml`
   - Environment: *(empty)*
   - Allowed actions: allow `npm publish`.
3. **Validate within 48 hours:** trigger the first OIDC publish by pushing a release tag
   within two days of saving the trusted-publisher configuration.
4. **Lock down publishing access:** once the first trusted publish succeeds, set Settings
   -> Publishing access to "Require two-factor authentication and disallow tokens".

Verify a published release and its provenance attestation:

```bash
npm view @sibylline-labs/hera version
npm view @sibylline-labs/hera dist --json
```

`dist.attestations.provenance.predicateType` should report
`https://slsa.dev/provenance/v1`.
