import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexResources, lightPatches, v1LightId } from '../src/hue/v2.js';

// What `GET /clip/v2/resource/light` and `/zigbee_connectivity` return for a
// bulb whose v1 id is 3 (trimmed).
const LIGHT = {
  id: 'e706416a-8c92-46ef-8589-3453f3235b13',
  id_v1: '/lights/3',
  owner: { rid: '3f4ac4e9-d67a-4dbd-8a16-5ea7e373f281', rtype: 'device' },
  type: 'light',
};
const CONNECTIVITY = {
  id: 'a3e1b3e8-0000-4000-8000-000000000001',
  id_v1: '/lights/3',
  owner: { rid: '3f4ac4e9-d67a-4dbd-8a16-5ea7e373f281', rtype: 'device' },
  status: 'connected',
  type: 'zigbee_connectivity',
};
const INDEX = indexResources([LIGHT], [CONNECTIVITY]);

/**
 * One message of the event stream.
 * @param {Array<object>} resources - Partial resources.
 * @param {string} [type] - Event type.
 * @returns {Array<object>} Parsed message.
 */
const update = (resources, type = 'update') => [{ creationtime: '2026-11-25T08:00:00Z', data: resources, type }];

test('v1LightId reads the v1 id of a light, and only of a light', () => {
  assert.equal(v1LightId('/lights/3'), '3');
  assert.equal(v1LightId('/groups/3'), undefined);
  assert.equal(v1LightId('/sensors/12'), undefined);
  assert.equal(v1LightId(undefined), undefined);
});

test('a v2 light is mapped back to its v1 id, which carries the external_id', () => {
  // The external_ids come from the v1 uniqueid of light 3: the event must land
  // on that light, or every device users created would stop updating.
  const patches = lightPatches(update([{ id: LIGHT.id, on: { on: true }, type: 'light' }]), INDEX);
  assert.deepEqual([...patches], [['3', { on: true }]]);
});

test('a v2 light update is translated into the v1 state', () => {
  const patches = lightPatches(
    update([
      {
        id: LIGHT.id,
        id_v1: '/lights/3',
        on: { on: false },
        dimming: { brightness: 50 },
        color: { xy: { x: 0.4573, y: 0.41 } },
        color_temperature: { mirek: 366, mirek_valid: true },
        type: 'light',
      },
    ]),
    INDEX,
  );
  assert.deepEqual(patches.get('3'), { on: false, bri: 127, xy: [0.4573, 0.41], ct: 366 });
});

test('a light showing a color reports no temperature, and the lowest brightness stays a valid one', () => {
  const patches = lightPatches(
    update([{ id: LIGHT.id, dimming: { brightness: 0.2 }, color_temperature: { mirek: null }, type: 'light' }]),
    INDEX,
  );
  assert.deepEqual(patches.get('3'), { bri: 1 });
});

test('a light unknown when the stream opened is still found by its id_v1', () => {
  const patches = lightPatches(update([{ id: 'new', id_v1: '/lights/9', on: { on: true }, type: 'light' }]), INDEX);
  assert.deepEqual([...patches.keys()], ['9']);
});

test('the connectivity of a device is reported on each of its lights', () => {
  const index = indexResources([LIGHT, { ...LIGHT, id: 'second', id_v1: '/lights/4' }], [CONNECTIVITY]);
  // The bridge names the owner in the event…
  assert.deepEqual(
    [...lightPatches(update([{ ...CONNECTIVITY, status: 'connectivity_issue' }]), index)],
    [
      ['3', { reachable: false }],
      ['4', { reachable: false }],
    ],
  );
  // … or only the id of the connectivity resource.
  assert.deepEqual(
    [...lightPatches(update([{ id: CONNECTIVITY.id, status: 'connected', type: 'zigbee_connectivity' }]), index)],
    [
      ['3', { reachable: true }],
      ['4', { reachable: true }],
    ],
  );
});

test('the changes of one message are merged per light', () => {
  const patches = lightPatches(
    update([
      { id: LIGHT.id, on: { on: true }, type: 'light' },
      { id: LIGHT.id, dimming: { brightness: 100 }, type: 'light' },
    ]),
    INDEX,
  );
  assert.deepEqual(patches.get('3'), { on: true, bri: 254 });
});

test('anything else is ignored', () => {
  const patches = lightPatches(
    [
      ...update([{ id: 'x', type: 'grouped_light', on: { on: true } }]),
      ...update([{ id: LIGHT.id, on: { on: true }, type: 'light' }], 'add'),
      ...update([{ id: 'motion', type: 'motion', motion: { motion: true } }]),
      ...update([{ id: LIGHT.id, type: 'light', owner: LIGHT.owner }]),
      { type: 'update' },
      null,
    ],
    INDEX,
  );
  assert.equal(patches.size, 0);
  assert.equal(lightPatches('not an array', INDEX).size, 0);
});
