# Philips Hue — Gladys Assistant external integration

External integration to control **Philips Hue** lights from
[Gladys Assistant](https://gladysassistant.com), built with the official
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

It runs as an isolated Docker container supervised by Gladys and talks to Gladys
over REST + WebSocket (the SDK handles the plumbing). It controls the Hue bridge
locally via its HTTP API — no Hue cloud account required.

## Features

- Auto-discovers Hue bridges on the network (N-UPnP) with a manual-IP fallback.
- Press-the-link-button pairing, from a button in the Configuration screen.
- Exposes each light with the features it supports: **on/off**, **brightness**,
  **color** (RGB ⇄ Hue xy), **white temperature** (mireds).
- Refreshes light states by polling at a configurable interval.

## Project structure

```
├─ index.js                          # SDK bootstrap + event wiring (no protocol logic)
├─ src/
│  ├─ config.js                      # config defaults + normalization
│  ├─ manager.js                     # orchestration: bridges, dispatch registry, commands
│  ├─ actions.js                     # manifest action handlers (discover / pair)
│  └─ hue/
│     ├─ discovery.js                # N-UPnP bridge discovery
│     ├─ bridge.js                   # Hue bridge REST client (fetch, v1 API)
│     ├─ mapping.js                  # Hue light <-> Gladys features (pure conversions)
│     └─ store.js                    # persistent paired-bridge credentials (/data)
├─ test/                             # node:test unit tests (mocked gladys + bridge)
├─ docs/{en,fr}.md                   # user documentation (linked from Gladys)
├─ gladys-assistant-integration.json # manifest (config schema + actions)
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs, /data volume
└─ .github/workflows/                # multi-arch build + UI-driven release
```

## Development

```bash
npm install
npm run lint
npm test
```

Run outside Docker (points the SDK at a local Gladys and a data dir):

```bash
GLADYS_HOST_API_URL=ws://localhost:1443 \
GLADYS_INTEGRATION_TOKEN=<token> \
GLADYS_INTEGRATION_SELECTOR=philips-hue \
HUE_DATA_DIR=./data \
npm start
```

## Configuration & pairing

See [`docs/en.md`](./docs/en.md) / [`docs/fr.md`](./docs/fr.md): discover the
bridge, press its link button, click **Pair bridge**.

## License

Apache-2.0
