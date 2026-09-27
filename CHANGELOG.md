# Changelog

All notable changes to the Philips Hue integration for Gladys Assistant.

## [Unreleased]

## [2.0.0] - 2026-09-23

### Added

- New scene action "Activate a Hue scene": recalls a scene saved on the bridge
  (every light of the room to its own color and brightness, with a synchronized
  transition), found by name and, optionally, by room or zone. When nothing or
  several scenes match, the error lists what exists.

### Changed

- Requires Gladys 5.1.0 or later (older versions reject integration scene
  actions).

## [1.2.0] - 2026-09-23

### Fixed

- The integration recovers on its own when the bridge was unreachable (for
  example after a power cut, when the bridge boots after the container): no
  more "run a scan" errors, and the connection status follows the bridge.
- Lights of a bridge paired by IP before 1.1.1 are no longer duplicated when the
  bridge is paired again; the devices already created keep working.
- `bridges.json`, which holds the bridge keys, is now readable by its owner
  only, and an interrupted write no longer leaves a temporary file behind.
- A request to an HTTPS bridge cut in the middle of the answer no longer hangs
  forever.
- The integration waits for Gladys when it starts before it, instead of
  exiting; an unexpected error is logged before the integration restarts.

## [1.1.2] - 2026-09-23

### Changed

- Maintenance release: integration SDK 0.14.0 and a smaller, hardened Docker
  image. No functional change.

## [1.1.1] - 2026-08-04

### Fixed

- Only devices confirmed to be Hue bridges are listed and offered for pairing, so
  unrelated devices on the network no longer appear as bridges.

## [1.1.0] - 2026-08-01

### Added

- Local bridge discovery as an additional way to find the bridge.

### Fixed

- Light states are now refreshed reliably by polling.
- The bridge connection recovers gracefully from errors.
- Pairing information is never lost: the data volume is always writable and a
  pairing survives a failed write.

## [1.0.3] - 2026-07-27

### Added

- Integration cover image.

### Fixed

- Corrected manifest validation errors.

## [1.0.2] - 2026-07-27

- Version bump of the initial release; no functional changes.

## [1.0.1] - 2026-07-27

### Added

- Initial release of the Philips Hue integration for Gladys Assistant:
  - Auto-discovery of Hue bridges (SSDP, mDNS, N-UPnP cloud, manual IP).
  - Press-the-link-button pairing.
  - Control of lights: on/off, brightness, color, and white temperature.
  - Light state refresh by polling.
  - Docker images for `amd64` and `arm64` (Raspberry Pi and similar).

[Unreleased]: https://github.com/cicoub13/gladys-philips-hue/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/cicoub13/gladys-philips-hue/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/cicoub13/gladys-philips-hue/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/cicoub13/gladys-philips-hue/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/cicoub13/gladys-philips-hue/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/cicoub13/gladys-philips-hue/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/cicoub13/gladys-philips-hue/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/cicoub13/gladys-philips-hue/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/cicoub13/gladys-philips-hue/releases/tag/v1.0.1
