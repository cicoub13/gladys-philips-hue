import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findScene, listSceneCandidates } from '../src/hue/scenes.js';

const GROUPS = {
  1: { name: 'Salon', type: 'Room' },
  2: { name: 'Chambre', type: 'Room' },
};

const SCENES = {
  a: { name: 'Détente', type: 'GroupScene', group: '1', lights: ['1', '2'] },
  b: { name: 'Détente', type: 'GroupScene', group: '2', lights: ['3'] },
  c: { name: 'Lecture', type: 'GroupScene', group: '1', lights: ['1'] },
  d: { name: 'Tout rouge', type: 'LightScene', lights: ['1', '3'] },
  e: { name: 'Lecture', type: 'GroupScene', group: '1', lights: ['1'], recycle: true },
  f: { name: 'Orpheline', type: 'GroupScene', group: '9', lights: ['4'] },
};

const candidates = () => listSceneCandidates('192.168.1.10', GROUPS, SCENES);

test('listSceneCandidates maps room scenes to their group and light scenes to all lights', () => {
  const byId = Object.fromEntries(candidates().map((candidate) => [candidate.sceneId, candidate]));
  assert.deepEqual(byId.a, {
    bridgeIp: '192.168.1.10',
    sceneId: 'a',
    sceneName: 'Détente',
    groupId: '1',
    roomName: 'Salon',
    lights: ['1', '2'],
  });
  assert.equal(byId.d.groupId, '0');
  assert.equal(byId.d.roomName, undefined);
});

test('listSceneCandidates leaves out temporary scenes and scenes of a deleted room', () => {
  const ids = candidates().map((candidate) => candidate.sceneId);
  // `e` would make "Lecture" ambiguous; `f` cannot be recalled without its room.
  assert.deepEqual(ids.sort(), ['a', 'b', 'c', 'd']);
});

test('listSceneCandidates tolerates a bridge with no scene', () => {
  assert.deepEqual(listSceneCandidates('192.168.1.10', {}, undefined), []);
});

test('findScene matches a unique name whatever the case and spaces', () => {
  assert.equal(findScene(candidates(), '  lecture ').sceneId, 'c');
  assert.equal(findScene(candidates(), 'TOUT ROUGE').sceneId, 'd');
});

test('findScene uses the room to tell apart scenes sharing a name', () => {
  assert.equal(findScene(candidates(), 'Détente', 'chambre').sceneId, 'b');
});

test('findScene refuses to guess between scenes sharing a name', () => {
  assert.throws(
    () => findScene(candidates(), 'Détente'),
    /Several Hue scenes are named "Détente" \(rooms: Chambre, Salon\): fill in the Room field/,
  );
});

test('findScene lists the available scenes when the name is unknown', () => {
  assert.throws(
    () => findScene(candidates(), 'Cinéma'),
    /Hue scene "Cinéma" not found\. Available scenes: Détente, Lecture, Tout rouge/,
  );
  assert.throws(
    () => findScene(candidates(), 'Cinéma', 'Salon'),
    /not found in room "Salon"\. Available scenes: Détente, Lecture$/,
  );
});

test('findScene lists the rooms when the room is unknown', () => {
  assert.throws(
    () => findScene(candidates(), 'Détente', 'Cuisine'),
    /No Hue scene in room "Cuisine"\. Rooms with scenes: Chambre, Salon/,
  );
});

test('findScene requires a scene name', () => {
  assert.throws(() => findScene(candidates(), '  '), /No Hue scene name given/);
});

test('findScene says so when the bridges hold no scene at all', () => {
  assert.throws(() => findScene([], 'Détente'), /Available scenes: none/);
});

test('findScene caps the names it lists', () => {
  const many = Array.from({ length: 25 }, (_, index) => ({
    sceneId: String(index),
    sceneName: `Scene ${String(index).padStart(2, '0')}`,
  }));
  assert.throws(
    () => findScene(many, 'Nope'),
    (error) => error.message.endsWith('Scene 19…'),
  );
});
