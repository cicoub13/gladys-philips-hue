# AGENTS.md — Philips Hue integration

Project-specific notes. Generic rules (SDK contract, commands, kit-owned files, runtime) are in
`CLAUDE.md`; user-facing content in `README.md` and `docs/`.

## Architecture / data flow

- `index.js` only wires SDK events to `HueManager`: `onScanRequest`/`connected` → `syncDevices()`,
  `connected` → `startPolling()`, `disconnected` → `stopPolling()`, `onConfigUpdated` → `setConfig()`,
  `onSetValue` → `setValue()`, `onAction('discover_bridges'|'pair_bridge'|'forget_bridges')`
  → `src/actions.js`, `onSceneAction('activate_scene')` → `activateScene()`, device
  created/updated/deleted and `connected` → `forgetTransports()`. A failed initial `connect()`
  is logged, not fatal (Gladys refuses the token transiently while booting; the SDK retries).
  `unhandledRejection` exits the process on purpose.
- `src/manager.js` holds the in-memory **registry** `device external_id → { platformId, hueId, bridgeIp,
light, commandSeq }`, rebuilt by `buildDiscoveredDevices()`. `setValue` resolves through it.
- No `onPoll`: Gladys only polls devices with `should_poll`, never set on the lights and never updated on
  devices already created. The manager refreshes on its own `setTimeout` chain (`startPolling` /
  `armPoll` / `runPoll`, never two runs at once, re-armed by `setConfig` when `poll_frequency` changes):
  one `getLights()` per bridge through `refreshLights()`, only for lights in `gladys.devices` (created).
  `refreshLights` skips a light whose `commandSeq` (set after an accepted command, a scene recall or a
  pushed change) is newer than the read, so a stale read never flips Gladys back after the echo.
- Push (v2 event stream): `startPolling` / `stopPolling` / `syncDevices` call `syncStreams()`, which keeps
  one `EventStream` (`src/hue/eventstream.js`) per stored bridge while connected to Gladys (closed for
  a forgotten or moved bridge). `openEventStream(bridge)`: `client.switchToHttps()` (a bridge stored as
  `http` is moved to HTTPS proactively, same proof and persistence as the 403 switch), `isV2()`
  (unauthenticated `GET /clip/v2/resource` → 403, like aiohue's `is_v2_bridge`), `getResources('light')` +
  `('zigbee_connectivity')` for the index, then `GET /eventstream/clip/v2` (`openStream` in `https.js`:
  same certificate check, TCP keepalive 30 s, not queued). Wrong certificate (`tlsRefused`, `wrongBridge`,
  at any of these steps) or no v2 (any status but 403 and 429/5xx) → `permanent`: `withoutPush` (WeakMap
  bridge → the ip that attempt used), polled only until restart or until it moves. An attempt that ends
  after `stop()` is ignored. Anything else, `ECONNREFUSED` included (round bridge, but also a booting
  one), reconnects with backoff (1 s → 1 min, started over only after a connection that lasted 30 s); a refresh that gets no answer calls `stream.reconnect()` (`markBridge`); each (re)connection
  re-reads the created lights (`refreshSoon`). Events → `lightPatches` (`src/hue/v2.js`, pure: v2 light by
  rid or `id_v1` → v1 hue id, zigbee_connectivity → `reachable` of every light of its device) →
  `queuePatches` (first at once, then merged, at most one batch per bridge per 1 s, `EVENT_THROTTLE_MS`;
  held back, still merged, while the pushes used their 200 states of the last minute, `pushBudget`, all
  bridges together, counted from the `count` publishChangedStates returns: Gladys takes 300; dropped when
  the stream opens again, since its catch-up read is newer) → `applyPatches` (cache, `commandSeq`,
  `debounceUnreachable` with `reports` only for a patch carrying `reachable`, one `publishChangedStates`
  per batch, created lights only, transports). The refresh
  loop keeps running beside the streams, as a safety net and for the round bridge.
- `src/hue/`: `bridge.js` (REST client: v1, plus the v2 calls of the push), `queue.js` (per-bridge request
  pacing), `eventstream.js` (SSE + reconnection), `v2.js` (pure: v2 events → v1 state), `https.js` (`node:https` transport + TLS pinning),
  `identify.js` (proves a candidate is a bridge), `discovery.js`, `mapping.js` and `scenes.js` (pure),
  `store.js` (`/data/bridges.json`).
- `src/actions.js` returns `{ en, fr }` messages; pairing outcome is split into
  `paired / pending / unreachable / notABridge` so the UI says what to do next.

## Hue API (local v1, `/api/...`; v2 for the push only)

- v1 on purpose for reads and commands (every bridge generation), and the external_ids come from the
  v1 `uniqueid`, which v2 does not carry: v2 resources are matched to v1 lights by `id_v1`
  (`/lights/<n>`). v2 is HTTPS only, the key goes in the `hue-application-key` header. New pairings use HTTPS when the bridge serves it, HTTP
  otherwise (BSB001). A bridge stored as `http` that answers 403 / refuses port 80 (firmware 1.78+) is
  switched once per client (`upgradeToHttps`): unauthenticated `/api/config` probe, cert CN must equal
  the announced (and stored) id, then `onHttpsUpgrade` persists it. `scheme` and `certFingerprint`
  are persisted per bridge; `BridgeStore.persist()` serializes writes.
- **Errors come as HTTP 200** with `[{"error":{type,description}}]` → `findHueError()` turns them into
  thrown errors with `.hueErrorType`. HTTP errors carry `.httpStatus`. Neither set = network failure
  (`isUnreachable()` in manager relies on this distinction for connection status).
- Type `101` = link button not pressed (`HUE_LINK_BUTTON_NOT_PRESSED`).
- The username is a full-access key: never let it reach a log/error (`redact()`); store file is `0600`.
- Every request of a stored bridge goes through its `RequestQueue` (`manager.queueOf(bridge)`, shared
  by all its clients): at most 3 in flight, one start per 100 ms (the bridge takes ~10 req/s). A request
  must be sent within 20 s of the `request()` call (4 s for `setLightState`), every attempt and pause
  included: past that it is dropped with `queueTimeout` (a timer per waiting job, so on time even when
  every slot hangs; or a retry is not made), never retried. Behind a bridge that stopped answering, a
  command must not land after Gladys gave up on it. `queueTimeout` carries no information on the bridge:
  `callBridge` records nothing for it, `buildDiscoveredDevices` leaves its silence alone, and
  `isUnreachable` is false for it. Forget and `confirmGone` probe with a queue of
  their own (`clientFor(bridge, { queue })`): requests stuck on a dead bridge would eat their timeout.
  `setValue` never fails on its echo (a Gladys 429): the bridge applied the command.
- Retries: 1 retry after 400 ms for a request that got no answer; up to 3 for a busy answer (429/5xx),
  after 250/500/1000 ms, each attempt queued again (a command must answer within Gladys' 5 s). Hue
  business errors never retried. `retries: 0` disables both: `createUser` (not idempotent, bridge
  holds ~63 users) and identification. Timeout 8 s (3.5 s when identifying).
- Identification: unauthenticated `GET /api/config`; needs `bridgeid` + (`modelid` or `apiversion`).
  Tries HTTPS then HTTP; stops if something answered but isn't a bridge. Over HTTPS the cert CN
  must equal the announced `bridgeid`, else it falls back to HTTP. Whole action must fit the
  manifest's 20 s `timeout_seconds`.
- HTTPS trust = TOFU: first contact checks cert CN == bridge id, then SHA-256 fingerprint is pinned.
  The check runs in `createConnection` right after the handshake, before the request (and the
  username in its path) is written. `requestJson` exposes **non-enumerable** `fingerprint` and
  `commonName` on the body; a refused certificate sets `error.tlsRefused`. Has an overall deadline
  and a `close` handler (a mid-body disconnect used to hang forever).
- Discovery: mediated mDNS `_hue._tcp` (TXT `bridgeid` or name matching /hue/) THEN mediated SSDP
  (`hue-bridgeid` header required), both always, one after the other (the core runs one scan per
  integration at a time), 3 s each, merged by bridge id (`mergeBridges`, mDNS wins); N-UPnP cloud
  `https://discovery.meethue.com/` (5 s) only when both found nothing, and never with
  `{ cloud: false }` (background search). A scan in progress is shared (`scanning`: the core refuses a
  second one), LAN results cached 10 s (`SCAN_CACHE_MS`) unless a scan failed; tests must call
  `resetDiscoveryCache()` (`makeManager` does). Scans + cloud + identification must fit the 20 s of the actions.
- Moved bridge (§4.7 of #48): `followMovedBridges(identified)` (under `exclusive`) gives a stored
  bridge with an id that is in `unreachable` the address identification found it at, same username.
  Over HTTPS the found certificate must equal the pinned one (`keepsPin`: the bridge id is public); a
  bridge paired over HTTP has no proof of identity, so its username only goes to its stored address: it
  is never followed, and Pair at a new address goes through the link button. `replaceBridge` drops the
  registry entries of the key it hands over (their Hue ids are the old bridge's) and lets the next
  command resync at once (`lastRefreshAt`). The Pair message names the `pending` bridges even when
  others were paired (an already-paired one answers with its stored username).
  Runs after every identification (`identifiedBridges`: Discover and Pair) and in `resync()`
  (`searchMovedBridges`, LAN only, at most once a minute, when a stored bridge with an id is in
  `unreachable`). `callBridge` puts in `unreachable` a bridge whose answer `isGone()` too (reset, another
  device at its address), without counting it silent: a refused command (Hue error 201…) does not.
- Pairing (`pairIdentified`, under `exclusive`): (1) a stored bridge whose username still works
  (`keyWorks`, behind `keepsPin`) is stored again without `createUser` (no orphan user); (2) otherwise
  `createUser`, then `previousOwnerOf`: a stored bridge in `unreachable`, or a forgotten one, at least
  half of whose created lights (by `uniqueid` in the external_id) the new bridge holds. A stored one must
  pass `confirmGone`: read again right now (3.5 s, no retry), it answers gone, or still nothing after
  being silent; any other answer (busy included) keeps it. Then
  `replaceBridge` → `store.replace(previous, { ...credentials, platformKey: platformKeyOf(previous) })`:
  the new bridge takes the old key, so the external_ids are kept, and the old key's `unreachable` and
  `silentSince` are cleared; `result.replaced` feeds the message.
  The username of a stored bridge is NEVER tried on a new one, although a Bridge Pro migration moves the
  app keys (HA does try it): only the id it announces, which anyone can claim, says who it is.
  `store.upsert` gives a new entry whose key is taken (`withFreeKey`: a replaced bridge paired again on
  its own) the key `<key>-<n>`, so two stored bridges never share a key.
- The bridge rate-limits ~10 req/s: the refresh loop and the scene refresh do one `getLights()` per
  bridge, not one call per light.

## Devices and external_ids (must stay stable)

- `gladys.externalIds('light', platformId)`, `platformId = <bridge.platformKey || bridge.id || bridge.ip>-<light.uniqueid || hueId>`.
  `bridge.id` is the lowercased bridgeid.
- Feature suffixes (`FEATURE` in `mapping.js`): `on-off`, `brightness`, `color`, `temperature`.
- `platformKey`: bridges paired by ≤1.1.0 via manual IP were stored without `id`, so their ids are
  IP-based. `store.upsert()` freezes the old IP as `platformKey` when the id is learned
  (`manager.learnBridgeId()`); never drop this fallback.
- Capabilities come from the Hue `type` string (`getCapabilities`). Conversions: `bri` 1..254 ↔ 1..100 %
  (never reports 0 %, since 0 % means "off" on commands); color RGB int ↔ `xy` (read at full luminance, `Y = 1`, so dimming does not darken it); temperature is
  mireds passthrough clamped to `capabilities.control.ct` (default 153..500).
- `setValue` echoes the value and the implied `on-off=1`, except the on/off of a light whose cached
  state says `reachable: false` (it then re-reads that light 1 s later, `refreshSoon`: one read per
  bridge for all the commands sent meanwhile); the SDK's `gladys.publishChangedStates` skips
  unchanged values (it remembers what Gladys accepted and forgets a device the user creates, updates or
  deletes).

## Config and `/data`

- Config keys: `bridge_ip` (validated IPv4/hostname; invalid input is moved to derived
  `bridge_ip_rejected` and shown by the actions), `poll_frequency` (ms, must be in
  `POLL_FREQUENCIES` = 10000/15000/30000/60000; nothing below 10 s for the bridge rate limit).
  `DEFAULT_CONFIG` must match manifest defaults. `poll_frequency` is the interval of the manager's own
  refresh loop; it is NOT set on the published devices (Gladys never polled them).
- `/data/bridges.json` (override dir with `HUE_DATA_DIR`): `{ bridges: [{ id, ip, username, scheme?,
certFingerprint?, platformKey? }], forgotten?: [{ id?, ip, platformKey? }] }` (`forgotten`: see
  `store.remove()` below). Atomic write via `.tmp` + rename; a failed write keeps the
  pairing in memory and sets `store.persistError` (surfaced by `pairBridgeAction`).

## Resilience behaviours (see commits 5aa8022, 19d424e, 56804b3)

- Unreachable bridges keep their old registry entries, and their lights stay in the published list; if
  none is reachable, `syncDevices` does NOT publish (an empty list would wipe the Discovery tab), unless
  `force` (after a Forget). Even with `force`, it does not publish while a stored bridge that does not
  answer has no known light (`unknown`: none read since the start), which would drop them from the tab.
- Single background resync while a bridge is down: backoff 5 s → 5 min with jitter, `unref()`ed,
  cleared by `stop()`. Unknown device on command triggers a shared resync at most every 30 s.
- Connection status is recomputed from `unreachable` and sent only when it changes.
- Bridges are addressed by their stored `ip`, but tracked by `platformKeyOf(bridge)` (`unreachable`,
  `silentSince`): two stored bridges may share an IP (a dead bridge and its replacement). A moved
  bridge is followed (`followMovedBridges`, see above), re-pairing updates the ip too (`upsert` keyed by id). A light
  is attributed to its bridge by external_id (`ownerOf`: longest `platformKey || id || ip` + `-`
  prefix), not by `entry.bridgeIp`; `callBridge`/`markBridge` take the bridge object, and so do the
  scene candidates (`activateScene`).
- A light with `state.reachable: false` on two reports in a row (cut at the wall; one may be a mesh
  blip, `debounceUnreachable`, `entry.cutShown`; a report is a read or a pushed connectivity change) is
  published off, with the `unreachable` transport badge
  (`publishLightTransports`, created devices only, only on change, cache in `manager.transports`).
  `forgetUnreachableBridges()` (button `forget_bridges`) drops a stored bridge when its read gets an
  answer that `isGone()` (Hue error 1, any HTTP status but 429/5xx), or no answer after
  `SILENT_FORGET_MS` (5 min) of none (`manager.silentSince`, keyed by `platformKeyOf`, on the monotonic
  `performance.now()`: an NTP step must not age it; a 429/5xx answer only puts it in `unreachable`). A
  failed switch to HTTPS (`error.httpsSwitchFailed`, set by `upgradeFailure`) counts as no answer,
  not as gone, though it carries the bridge's 403. The probe is recorded like any read (`markBridge`). Forget and the
  store part of pairing share a lock (`manager.exclusive`), so no bridge is re-paired during the probe,
  and the resync after it reuses the probe reads (30 s action timeout). `store.remove()` keeps every forgotten bridge in `forgotten` (with the
  `platformKey` of IP-keyed ones); `upsert` matches it by id first, then an id-less one by IP. Results of calls to a bridge no longer
  stored are ignored (`markBridge`, end of `buildDiscoveredDevices`). Transports go through
  `queueTransports` (one call at a time, cache written before the request, cleared on failure; failed
  entries wait in `pendingTransports` and go out with the next call, at the latest at the end of
  `pollLights`).
  A bridge that does not answer, or is forgotten, gets the `unreachable` badge on its created lights,
  found in `gladys.devices` by external_id prefix (`createdLightsOf`), not in the registry. `resolve`
  says when a device's bridge is no longer stored.

## Tests

- `node:test`, all in `test/`. No `test/manifest.test.js`. Extra script: `npm run test:coverage`.
- Gladys is the SDK's `createFakeGladys()` (`@gladysassistant/integration-sdk/testing`): assert on
  `gladys.fake.states` / `discoveredDevices` / `connectionStatus`, feed scans with `scanResults`, make a
  call fail with `t.mock.method(gladys, ...)`. `test/manager.test.js` uses selector `test`
  (`ext:test:<type>:<platformId>`) and a fake client injected via `manager.clientFor = () => client`; stores in `fs.mkdtemp` dirs. Refresh loop tests use
  `t.mock.timers.enable({ apis: ['setTimeout'] })` then `settle()` (one `setImmediate`).
- HTTP is mocked with `mock.method(global, 'fetch', ...)`; `https.test.js` uses a real local
  `http.createServer`; `index.test.js` spawns `index.js` against a `ws` WebSocketServer closing with 4000.
- Keep tests portable: a hardcoded `/proc` path once made the suite hang on Linux only (7c8f10e);
  provoke write failures by putting a file where a directory is expected.

## Misc

- Versions (package.json, manifest `version`/`docker_image`) are bumped by the release workflow; don't
  bump by hand. `CHANGELOG.md` is maintained manually and currently stops at 1.1.1.
