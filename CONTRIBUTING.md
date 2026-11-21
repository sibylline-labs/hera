# Contributing

Hera is open source under the [MIT License](LICENSE). You may read, use,
modify and redistribute it under that licence.

## We do not accept outside contributions

Hera is developed by its maintainers. We do not accept pull requests, patches,
issues or feature requests from outside the project. This is not a judgement of
any contribution. It keeps the project's review load and direction in one place.

## Forks are welcome

Fork Hera and change it however you like, within the terms of the licence. Keep
the `LICENSE` file with any redistribution.

## Security

Never report a vulnerability in public. Follow [SECURITY.md](SECURITY.md).

## For maintainers

- Install with `bun install`. Run all three gates before every commit:

  ```bash
  bun run typecheck
  bun run lint
  bun run test
  ```

- The plane rules, file-size cap and ast-grep guardrails are in
  [CLAUDE.md](CLAUDE.md); the layout guide is [docs/dev/LAYOUT.md](docs/dev/LAYOUT.md).
- The public tree is `git archive <ref>`. Paths that never ship are listed as
  `export-ignore` in [.gitattributes](.gitattributes). Shipped files carry no
  tracker key, private register label, private-org URL or internal product
  name (`test/hygiene/public-tree.test.ts`), and no secret-shaped string
  (the CI `secrets` job runs the default gitleaks rules with no allowlist).
  Build a test credential at run time from parts, as
  [test/fixtures/provider-tokens.ts](test/fixtures/provider-tokens.ts) does.
- Record each user-visible change in [CHANGELOG.md](CHANGELOG.md).
