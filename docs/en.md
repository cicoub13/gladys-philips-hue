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

## Notes

- The pairing credentials (the bridge _username_) are stored in the integration
  data volume (`/data`) and survive restarts. You only pair once.
- Controlling your lights is always **100 % local**: commands and state reads go
  straight to the bridge over your LAN. Only the last-resort discovery step
  above may contact a Philips server, and only while you look for your bridge.
- The container must be able to reach the bridge on your LAN (HTTP, port 80).
