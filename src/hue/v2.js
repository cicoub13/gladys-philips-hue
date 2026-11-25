// -----------------------------------------------------------------------------
// Hue API v2 (CLIP v2) resources, translated to the v1 model the rest of the
// integration uses. Everything here is PURE (no I/O).
//
// From v2, the integration only takes the PUSH so far: the event stream says
// what changed, at once, instead of the next refresh. The lights are still read
// and commanded through v1, and their external_ids still come from the v1
// `uniqueid`, which v2 does not carry. A v2 resource is matched to its v1 light
// through `id_v1` ("/lights/3"):
//   - light               : on.on, dimming.brightness (0..100), color.xy,
//                           color_temperature.mirek;
//   - zigbee_connectivity : status, for every light of the device that owns it
//                           (a bulb cut at the wall is no longer `connected`).
//
// Docs: https://developers.meethue.com/develop/hue-api-v2/
// -----------------------------------------------------------------------------

const HUE_BRI_MIN = 1;
const HUE_BRI_MAX = 254;

/**
 * The v1 id of a light from its v2 `id_v1`.
 * @param {string} [idV1] - `id_v1` of a v2 resource, e.g. `/lights/3`.
 * @returns {string | undefined} `3`, or nothing when it is not a v1 light.
 */
export function v1LightId(idV1) {
  const match = /^\/lights\/(\d+)$/.exec(String(idV1 || ''));
  return match ? match[1] : undefined;
}

/**
 * Index the v2 resources an event may name by their id only.
 * @param {Array<object>} lights - `GET /clip/v2/resource/light` data.
 * @param {Array<object>} connectivities - `GET /clip/v2/resource/zigbee_connectivity` data.
 * @returns {{ lights: Map<string, string>, devices: Map<string, string[]>, connectivities: Map<string, string> }}
 * v1 light id by v2 light id, v1 light ids by device id, device id by connectivity id.
 */
export function indexResources(lights = [], connectivities = []) {
  const index = { lights: new Map(), devices: new Map(), connectivities: new Map() };
  for (const light of lights) {
    const hueId = v1LightId(light && light.id_v1);
    if (!hueId) {
      continue;
    }
    index.lights.set(light.id, hueId);
    const device = light.owner && light.owner.rid;
    if (device) {
      index.devices.set(device, [...(index.devices.get(device) || []), hueId]);
    }
  }
  for (const connectivity of connectivities) {
    if (connectivity && connectivity.owner && connectivity.owner.rid) {
      index.connectivities.set(connectivity.id, connectivity.owner.rid);
    }
  }
  return index;
}

/**
 * The v1 state change a v2 light update carries.
 * @param {object} light - Partial v2 light resource.
 * @returns {object} Partial v1 state (`on`, `bri`, `xy`, `ct`).
 */
function lightPatch(light) {
  const patch = {};
  if (light.on && typeof light.on.on === 'boolean') {
    patch.on = light.on.on;
  }
  if (light.dimming && Number.isFinite(light.dimming.brightness)) {
    const bri = Math.round((light.dimming.brightness / 100) * HUE_BRI_MAX);
    patch.bri = Math.max(HUE_BRI_MIN, Math.min(HUE_BRI_MAX, bri));
  }
  const xy = light.color && light.color.xy;
  if (xy && Number.isFinite(xy.x) && Number.isFinite(xy.y)) {
    patch.xy = [xy.x, xy.y];
  }
  // `mirek` is null while the light shows a color.
  if (light.color_temperature && Number.isFinite(light.color_temperature.mirek)) {
    patch.ct = light.color_temperature.mirek;
  }
  return patch;
}

/**
 * Turn the messages of the event stream into v1 state changes, merged per light.
 * @param {Array<object>} events - Parsed `data` of the stream: `[{ type: 'update', data: [resources] }]`.
 * @param {ReturnType<typeof indexResources>} index - Resources of the bridge.
 * @returns {Map<string, object>} Partial v1 state by v1 light id.
 */
export function lightPatches(events, index) {
  const patches = new Map();
  const merge = (hueId, patch) => {
    if (hueId && Object.keys(patch).length > 0) {
      patches.set(hueId, { ...patches.get(hueId), ...patch });
    }
  };
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.type !== 'update' || !Array.isArray(event.data)) {
      continue;
    }
    for (const resource of event.data) {
      if (!resource) {
        continue;
      }
      if (resource.type === 'light') {
        merge(index.lights.get(resource.id) || v1LightId(resource.id_v1), lightPatch(resource));
      } else if (resource.type === 'zigbee_connectivity' && typeof resource.status === 'string') {
        const device = (resource.owner && resource.owner.rid) || index.connectivities.get(resource.id);
        for (const hueId of index.devices.get(device) || []) {
          merge(hueId, { reachable: resource.status === 'connected' });
        }
      }
    }
  }
  return patches;
}
