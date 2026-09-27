# Gladys external integration

A Node.js program (ESM, Node ≥ 20) running in its own Docker container and talking to Gladys
through `@gladysassistant/integration-sdk` (REST `/api/integration/v1/*` + WebSocket). The
contract is https://gladysassistant.com/fr/docs/dev/external-integrations/: fetch it rather than
trusting memory, the SDK is still 0.x.

Sibling integrations are cloned next to this repo (`../gladys-*`, list in
`../integration-kit/repos.txt`). When one already solves a problem (timeouts, error
classification, token storage, fake Gladys test helper…), reuse its pattern.

## Layout

- `index.js`: entry point. `src/`: code. `test/`: `node --test` tests.
- `gladys-assistant-integration.json`: the manifest (`config_schema`, widgets, scene triggers and
  actions…).
- `docs/en.md` and `docs/fr.md`: user docs, keep both in sync. README screenshots go in
  `docs/images/`.

## Commands

```sh
npm test                 # also validates the manifest when test/manifest.test.js exists
npm run lint
npm run format:check     # npm run format to fix
```

All three must pass before committing: CI runs them, plus a coverage threshold when the repo has a
`coverage` script.

## Rules

- **Files owned by the integration-kit**: `.github/workflows/{ci,build,release,dependency-review}.yml`,
  `.github/dependabot.yml`, `SECURITY.md` and this `CLAUDE.md`. Never edit them here: change
  `../integration-kit/template/` and sync, or the next sync overwrites the change.
- **SDK upgrades** go through `../integration-kit/scripts/sdk-bump.sh`, not by hand.
- **Backward compatibility**: keep the same `external_id`s, config keys, manifest `config_schema`
  keys and files under `/data`. A changed `external_id` orphans every device users already
  created.
- **Runtime**: read-only root FS (only `/data` is writable), 256 MB RAM, bridge network (no
  broadcast or mDNS: use `scanNetwork()` and manifest `network_discovery`). Register handlers
  before `connect()`. Respect the SDK rate limits (`publishState(s)` 300/min, ≤100 per batch).
- **Changelog**: when the repo has a `CHANGELOG.md`, a change users can notice (fix, feature,
  behaviour, requirement) adds a line under `## [Unreleased]` in the same PR, written for users.
  Never write a version heading: the release workflow turns `[Unreleased]` into the version.
- **Dates and times** shown to users use the local timezone (`TZ` is injected), not UTC.
- **Docker image**: built by GitHub Actions, don't build it locally.
- Start from an up-to-date default branch (`git pull`); it is `main` or `master` depending on the
  repo.
