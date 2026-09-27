# AGENTS.md — Philips Hue integration

Project-specific notes. Generic rules (SDK contract, commands, kit-owned files, runtime) are in
`CLAUDE.md`; user-facing content in `README.md` and `docs/`.

## Architecture / data flow

- `index.js` only wires SDK events to `HueManager`: `onScanRequest`/`connected`/`onConfigUpdated` →
  `syncDevices()`, `onSetValue` → `setValue()`, `onPoll` → `poll()`, `onAction('discover_bridges'|'pair_bridge')`
  → `src/actions.js`, `onSceneAction('activate_scene')` → `activateScene()`. A failed initial `connect()`
  is logged, not fatal (Gladys refuses the token transiently while booting; the SDK retries).
  `unhandledRejection` exits the process on purpose.
- `src/manager.js` holds the in-memory **registry** `device external_id → { platformId, hueId, bridgeIp,
light, lastValues }`, rebuilt by `buildDiscoveredDevices()`. `setValue`/`poll` resolve through it.
- `src/hue/`: `bridge.js` (v1 REST client), `https.js` (`node:https` transport + TLS pinning),
  `identify.js` (proves a candidate is a bridge), `discovery.js`, `mapping.js` and `scenes.js` (pure),
  `store.js` (`/data/bridges.json`).
- `src/actions.js` returns `{ en, fr }` messages; pairing outcome is split into
  `paired / pending / unreachable / notABridge` so the UI says what to do next.

## Hue API (local v1, `/api/...`)

- v1 on purpose (every bridge generation). Plain HTTP by default; HTTPS only when identification
  found the bridge refuses HTTP. `scheme` and `certFingerprint` are persisted per bridge.
- **Errors come as HTTP 200** with `[{"error":{type,description}}]` → `findHueError()` turns them into
  thrown errors with `.hueErrorType`. HTTP errors carry `.httpStatus`. Neither set = network failure
  (`isUnreachable()` in manager relies on this distinction for connection status).
- Type `101` = link button not pressed (`HUE_LINK_BUTTON_NOT_PRESSED`).
- The username is a full-access key: never let it reach a log/error (`redact()`); store file is `0600`.
- Retries: 1 retry after 400 ms for network errors and 429/5xx; Hue business errors never retried.
  `createUser` has `retries: 0` (not idempotent, bridge holds ~63 users). Timeout 8 s (3.5 s when identifying).
- Identification: unauthenticated `GET /api/config`; needs `bridgeid` + (`modelid` or `apiversion`).
  Tries HTTP then HTTPS; stops if something answered but isn't a bridge. Whole action must fit the
  manifest's 20 s `timeout_seconds`.
- HTTPS trust = TOFU: first contact checks cert CN == bridge id, then SHA-256 fingerprint is pinned.
  `requestJson` exposes it as a **non-enumerable** `fingerprint` on the body. Has an overall deadline
  and a `close` handler (a mid-body disconnect used to hang forever).
- Discovery order: mediated SSDP (`hue-bridgeid` header required) → mediated mDNS `_hue._tcp`
  (TXT `bridgeid` or name matching /hue/) → N-UPnP cloud `https://discovery.meethue.com/`. Results
  cached 10 s (`SCAN_CACHE_MS`) because the core allows one mediated scan per 10 s (else 429);
  tests must call `resetDiscoveryCache()`.
- Polling only (no push/event stream). The bridge rate-limits ~10 req/s: scene refresh does one
  `getLights()`, not one call per light.

## Devices and external_ids (must stay stable)

- `gladys.externalIds('light', platformId)`, `platformId = <bridge.platformKey || bridge.id || bridge.ip>-<light.uniqueid || hueId>`.
  `bridge.id` is the lowercased bridgeid.
- Feature suffixes (`FEATURE` in `mapping.js`): `on-off`, `brightness`, `color`, `temperature`.
- `platformKey`: bridges paired by ≤1.1.0 via manual IP were stored without `id`, so their ids are
  IP-based. `store.upsert()` freezes the old IP as `platformKey` when the id is learned
  (`manager.learnBridgeId()`); never drop this fallback.
- Capabilities come from the Hue `type` string (`getCapabilities`). Conversions: `bri` 1..254 ↔ 1..100 %
  (never reports 0 %, since 0 % means "off" on commands); color RGB int ↔ `xy` (+`bri`); temperature is
  mireds passthrough clamped to `capabilities.control.ct` (default 153..500).
- `setValue` echoes the value and the implied `on-off=1`; `publishChangedStates` skips unchanged values
  (per-device `lastValues`).

## Config and `/data`

- Config keys: `bridge_ip` (validated IPv4/hostname; invalid input is moved to derived
  `bridge_ip_rejected` and shown by the actions), `poll_frequency` (ms, must be in
  `POLL_FREQUENCIES` = 10000/15000/30000/60000 — Gladys' DB enum; 1 s/2 s deliberately excluded).
  `DEFAULT_CONFIG` must match manifest defaults. `poll_frequency` is set on each published device.
- `/data/bridges.json` (override dir with `HUE_DATA_DIR`): `{ bridges: [{ id, ip, username, scheme?,
certFingerprint?, platformKey? }] }`. Atomic write via `.tmp` + rename; a failed write keeps the
  pairing in memory and sets `store.persistError` (surfaced by `pairBridgeAction`).

## Resilience behaviours (see commits 5aa8022, 19d424e, 56804b3)

- Unreachable bridges keep their old registry entries; if none is reachable, `syncDevices` does NOT
  publish (an empty list would wipe the Discovery tab).
- Single background resync while a bridge is down: backoff 5 s → 5 min with jitter, `unref()`ed,
  cleared by `stop()`. Unknown device on poll/command triggers a shared resync at most every 30 s.
- Connection status is recomputed from `unreachable` and sent only when it changes.
- Bridges are addressed by their stored `ip` (registry entries and `unreachable` hold `bridgeIp`);
  nothing re-discovers a moved bridge automatically, re-pairing updates the ip (`upsert` keyed by id).

## Tests

- `node:test`, all in `test/`. No `test/manifest.test.js`. Extra script: `npm run test:coverage`.
- `test/manager.test.js`: hand-written fake Gladys (`makeGladys()`: `externalIds` returning
  `ext:test:<type>:<platformId>`, records states/devices/status) and fake client injected via
  `manager.clientFor = () => client`; stores in `fs.mkdtemp` dirs.
- HTTP is mocked with `mock.method(global, 'fetch', ...)`; `https.test.js` uses a real local
  `http.createServer`; `index.test.js` spawns `index.js` against a `ws` WebSocketServer closing with 4000.
- Keep tests portable: a hardcoded `/proc` path once made the suite hang on Linux only (7c8f10e);
  provoke write failures by putting a file where a directory is expected.

## Misc

- Versions (package.json, manifest `version`/`docker_image`) are bumped by the release workflow; don't
  bump by hand. `CHANGELOG.md` is maintained manually and currently stops at 1.1.1.
