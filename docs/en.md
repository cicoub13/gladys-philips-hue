# Philips Hue integration for Gladys Assistant

## Overview

Control your Philips Hue lights from Gladys, directly over your local network
(no Hue cloud account required).

### What you get

Each Hue light is exposed as a Gladys device with the features it supports:

| Hue light type          | On/Off | Brightness | Color | White temperature |
| ----------------------- | :----: | :--------: | :---: | :---------------: |
| On/Off light            |   ✅   |            |       |                   |
| Dimmable light          |   ✅   |     ✅     |       |                   |
| Color temperature light |   ✅   |     ✅     |       |        ✅         |
| Color light             |   ✅   |     ✅     |  ✅   |                   |
| Extended color light    |   ✅   |     ✅     |  ✅   |        ✅         |

The integration reads your bridge at the interval you choose in **Refresh
interval** (default: every minute): changes made outside Gladys — Hue app, wall
switch, dimmer, Hue automations — show up in Gladys within that interval.
Changes made from Gladys show up right away.

### Hue scenes in Gladys scenes

> **Requires Gladys 5.1 or later.**

The **Activate a Hue scene** action of the Gladys scene editor recalls a scene
created in the Hue app: all its lights take their color and brightness at once,
with the bridge's transition.

- **Scene**: the name shown in the Hue app, for example `Relax`. Case and
  surrounding spaces are ignored.
- **Room or zone** (optional): only needed when several rooms have a scene with
  that name, for example `Living room`.

When the name matches no scene, or several, the action fails and the scene logs
list the scenes (or the rooms) available. The rest of the Gladys scene keeps
running.

## Prerequisites

- **Gladys 5.1 or later.**
- A Philips Hue bridge, with your lights already added to it.
- Physical access to the bridge: pairing asks you to press its round link
  button.
- No Hue cloud account is needed.
- The container must be able to reach the bridge on your LAN (HTTP on port 80,
  or HTTPS if your bridge no longer accepts plain HTTP).

## Configuration

1. Make sure your Hue bridge is powered on and connected to the same local
   network as your Gladys server.
2. Open the integration **Configuration** screen and click **Discover bridges**.
   The IP address of your bridge should appear. If auto-discovery fails, type
   the bridge IP address in the **Bridge IP address** field (a plain address or
   hostname, for example `192.168.1.42` — anything else is ignored and the
   button tells you so).
3. **Press the round link button** on top of the Hue bridge.
4. Within 30 seconds, click **Pair bridge**. On success, your lights appear in
   the **Discovery** tab, ready to be created as devices.

## How the bridge is found

Three methods are tried, in order, and the first one that finds a bridge wins:

1. **SSDP** on your local network, performed by Gladys on the integration's
   behalf;
2. **mDNS** (`_hue._tcp`), same mechanism;
3. Philips' **N-UPnP** endpoint (`discovery.meethue.com`) as a last resort. This
   one is a Philips _cloud_ service: it needs Internet access and only returns
   bridges seen from the same public IP address. It is only used when the two
   local methods find nothing.

Whichever method finds it, every device is **verified** before being offered to
you: the integration asks it for its Hue identity card (`/api/config`). Devices
that do not answer like a Philips Hue bridge — a printer, a NAS, a speaker — are
discarded, and the message tells you how many were.

## Notes

- The pairing credentials (the bridge _username_) are stored in the integration
  data volume (`/data`) and survive restarts. You only pair once.
- Controlling your lights is always **100 % local**: commands and state reads go
  straight to the bridge over your LAN. Only the last-resort discovery step
  above may contact a Philips server, and only while you look for your bridge.
- **HTTPS security**: a Hue bridge serves a certificate issued by Philips rather
  than by a public authority. On first contact the integration checks that this
  certificate carries the bridge's own identifier, then remembers its
  fingerprint. On later connections any different fingerprint is refused, so a
  device impersonating your bridge is blocked.

## Troubleshooting

The integration logs are available in Gladys, from the **Configuration** tab of
the integration, alongside the supervision controls (start, stop, restart…).

**"No Hue bridge found"** while the bridge is powered on: check that it sits on
the same network as Gladys (a guest network or a separate VLAN makes it
invisible). If the message says other devices answered but none is a Hue bridge,
discovery did see your network but not the bridge: type its address in **Bridge
IP address**. You will find it in the Hue app, under **Settings → My devices →
Bridge**.

**"The link button was not pressed"**: the bridge was found, only the pairing is
missing. Press the round button on top of the bridge, then click **Pair bridge**
again within the next 30 seconds.

**Lights stopped responding**: check that the bridge did not change IP address
(reserve it in your router), then run a discovery again.

**"Hue bridge unreachable. Check that it is powered on and on the same network
as Gladys."** in the connection status: the paired bridge no longer answers.
While it is away, a command may fail with `Hue bridge unreachable: light … will be
available again as soon as the bridge answers`. The integration keeps trying in
the background, and the lights come back on their own once the bridge answers.

**"A Hue bridge was found but could not be paired"**: the bridge answered
discovery, then failed during pairing. Check that it stays reachable from
Gladys, then click **Pair bridge** again. The integration logs give the reason
(`Pairing with … failed: …`).

**"… but the credentials could NOT be saved"**: pairing worked, but the
integration could not write to its data volume (`/data`). Your lights work
until the next restart, after which you will have to pair again. Check that the
integration data volume is writable.

**`Bridge … is no longer paired, pair it again from the Configuration screen`**
when you control a light, or **"No Hue bridge paired yet"**: run **Discover
bridges** and **Pair bridge** again (see "Configuration").
