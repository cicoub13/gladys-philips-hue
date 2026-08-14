# Changelog

All notable changes to the Philips Hue integration for Gladys Assistant.

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

[1.1.1]: https://github.com/cicoub13/gladys-philips-hue/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/cicoub13/gladys-philips-hue/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/cicoub13/gladys-philips-hue/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/cicoub13/gladys-philips-hue/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/cicoub13/gladys-philips-hue/releases/tag/v1.0.1
