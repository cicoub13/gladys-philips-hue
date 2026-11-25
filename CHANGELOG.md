# Changelog

All notable changes to the Philips Hue integration for Gladys Assistant.

## [Unreleased]

### Added

- Changes made outside Gladys (Hue app, dimmer, wall switch, Hue automations)
  show up in Gladys at once with a square bridge (firmware 1.48 or later) or a
  Hue Bridge Pro, instead of at the next refresh. The **Refresh interval** stays
  as a safety net, and for the round bridge. A bridge paired over plain HTTP is
  moved to HTTPS on its own to get them, with no new pairing.

- A bridge that changed IP address is found again on its own, with no new
  pairing: the integration looks for it on your network in the background, and
  **Discover bridges** follows it right away. A bridge still paired over plain
  HTTP, such as the round bridge, must be paired again.
- After a migration to a Hue Bridge Pro, or a bridge replacement, **Pair bridge**
  recognizes the new bridge: the lights already created in Gladys keep working,
  with their rooms, scenes and history, instead of coming back as new devices.
- **Pair bridge** on a bridge already paired reuses its access, without the link
  button, instead of creating another user on the bridge.

### Fixed

- **Discover bridges** now finds every bridge of the network, a Hue Bridge Pro
  next to a square bridge included: it uses mDNS first, then SSDP, and merges
  what both find. Until now it stopped at the first method that found a bridge.

- A Gladys scene acting on many lights at once no longer loses commands: the
  requests to a bridge are now spaced out, and retried a few times when the
  bridge says it is busy.
- With two bridges at the same IP address (an old bridge and its replacement),
  the connection status no longer flips between connected and unreachable, and
  a Hue scene is recalled on the bridge that holds it.
- **Forget unreachable bridges** no longer forgets, on the first click, a
  bridge that blocks plain HTTP and could not be switched to HTTPS: like a
  bridge that does not answer, it must have been failing for 5 minutes.
- A clock set late after boot (a Raspberry Pi without a battery-backed clock)
  no longer lets **Forget unreachable bridges** drop a bridge that has only just
  stopped answering.

## [2.1.0] - 2026-11-24

### Added

- **Forget unreachable bridges** button in the Configuration screen: after
  replacing a bridge or migrating to a Hue Bridge Pro, it forgets the old one,
  which was otherwise reported unreachable forever.

### Fixed

- Lights keep working after the bridge installs firmware 1.78 or later, which
  blocks plain HTTP: a bridge paired over HTTP now switches to HTTPS on its own,
  without pressing the link button or pairing again. Until now, every command
  failed and the bridge was reported unreachable.
- New pairings use HTTPS whenever the bridge supports it, and plain HTTP only
  for the round v1 bridge.
- A light powered off at the wall now shows as off in Gladys, with an
  **unreachable** badge on the Devices page. Until now it stayed on, so scene
  conditions such as "if the light is on" were wrong.
- Every light created in Gladys now shows a **local** badge on the Devices page
  while its bridge answers.
- When a bridge stops answering, its lights get the **unreachable** badge until
  it answers again. Until now they kept looking available.
- The lights of a bridge that does not answer stay in the **Discovery** tab.
  Until now they disappeared from it until the bridge answered again.
- The color reported by a light no longer darkens as you dim it: a warm white at
  low brightness used to show up as brown in the color picker.
- The troubleshooting docs now explain that a bridge whose IP address changed
  must be paired again: **Discover bridges** alone does not update it.

## [2.0.3] - 2026-10-29

### Changed

- Maintenance release: dependency and build updates, no functional change.

## [2.0.2] - 2026-10-13

### Changed

- Maintenance release: dependency and build updates, no functional change.

## [2.0.1] - 2026-10-13

### Fixed

- Changes made outside Gladys (Hue app, wall switch, dimmer, Hue automations)
  now show up in Gladys within the configured **Refresh interval**, for the
  lights already created too: until now, light states were only updated after a
  command or a scene sent from Gladys.
- **Discover bridges** now finds your bridge on the local network through SSDP,
  and through mDNS even when the bridge's network name does not contain "Hue".
  Until now SSDP never found a bridge, and mDNS only found the ones named "Hue",
  so discovery often fell back to the Philips cloud service or to typing the IP.
- A light deleted then created again in Gladys gets its state at the next
  refresh, instead of staying empty until something changed on the light.

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

[Unreleased]: https://github.com/cicoub13/gladys-philips-hue/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/cicoub13/gladys-philips-hue/compare/v2.0.3...v2.1.0
[2.0.3]: https://github.com/cicoub13/gladys-philips-hue/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/cicoub13/gladys-philips-hue/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/cicoub13/gladys-philips-hue/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/cicoub13/gladys-philips-hue/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/cicoub13/gladys-philips-hue/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/cicoub13/gladys-philips-hue/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/cicoub13/gladys-philips-hue/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/cicoub13/gladys-philips-hue/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/cicoub13/gladys-philips-hue/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/cicoub13/gladys-philips-hue/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/cicoub13/gladys-philips-hue/releases/tag/v1.0.1
