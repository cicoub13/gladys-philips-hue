# Philips Hue integration for Gladys Assistant

Control your Philips Hue lights from Gladys, directly over your local network
(no Hue cloud account required).

## What you get

Each Hue light is exposed as a Gladys device with the features it supports:

| Hue light type          | On/Off | Brightness | Color | White temperature |
| ----------------------- | :----: | :--------: | :---: | :---------------: |
| On/Off light            |   ✅   |            |       |                   |
| Dimmable light          |   ✅   |     ✅     |       |                   |
| Color temperature light |   ✅   |     ✅     |       |        ✅         |
| Color light             |   ✅   |     ✅     |  ✅   |                   |
| Extended color light    |   ✅   |     ✅     |  ✅   |        ✅         |

States are refreshed by polling at the interval you choose in **Refresh
interval** (default: every minute).

## Setup

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

## Troubleshooting

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

## Notes

- The pairing credentials (the bridge _username_) are stored in the integration
  data volume (`/data`) and survive restarts. You only pair once.
- Controlling your lights is always **100 % local**: commands and state reads go
  straight to the bridge over your LAN. Only the last-resort discovery step
  above may contact a Philips server, and only while you look for your bridge.
- The container must be able to reach the bridge on your LAN (HTTP on port 80,
  or HTTPS if your bridge no longer accepts plain HTTP).
- **HTTPS security**: a Hue bridge serves a certificate issued by Philips rather
  than by a public authority. On first contact the integration checks that this
  certificate carries the bridge's own identifier, then remembers its
  fingerprint. On later connections any different fingerprint is refused, so a
  device impersonating your bridge is blocked.
