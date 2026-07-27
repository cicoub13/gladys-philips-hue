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

States are refreshed by polling at the interval you choose (default: 60 s).

## Setup

1. Make sure your Hue bridge is powered on and connected to the same local
   network as your Gladys server.
2. Open the integration **Configuration** screen and click **Discover bridges**.
   The IP address of your bridge should appear. If auto-discovery fails, type
   the bridge IP address in the **Bridge IP address** field.
3. **Press the round link button** on top of the Hue bridge.
4. Within 30 seconds, click **Pair bridge**. On success, your lights appear in
   the **Discovery** tab, ready to be created as devices.

## Notes

- The pairing credentials (the bridge _username_) are stored in the integration
  data volume (`/data`) and survive restarts. You only pair once.
- This integration uses the local Hue API only; it never talks to the Hue cloud.
- The container must be able to reach the bridge on your LAN (HTTP, port 80).
