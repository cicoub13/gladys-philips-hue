// -----------------------------------------------------------------------------
// Resolution of the `activate_scene` scene action: from the names a user typed
// in the Gladys scene editor (scene, optional room) to the scene id and group id
// the bridge expects.
//
// Everything here is PURE (no I/O). Names are the only handle a user has: the
// manifest fields are static, they cannot list the scenes of a bridge. So
// matching is forgiving on case and surrounding spaces, and every failure says
// what exists instead, since the message ends up in the Gladys scene logs.
//
// Hue v1 has two kinds of scenes:
//   - `GroupScene`: tied to a room or a zone (`group`), what the Hue app creates;
//   - `LightScene`: a bare list of lights, recalled on group `0` (all lights).
// Scenes flagged `recycle` are temporary ones other apps may delete at any time:
// they are left out, and would otherwise make real names look ambiguous.
// -----------------------------------------------------------------------------

// Group recalling a scene that belongs to no room: every light of the bridge.
const ALL_LIGHTS_GROUP = '0';

// Names listed in an error message, at most: a scene log is not a catalog.
const MAX_LISTED_NAMES = 20;

/**
 * @typedef {object} SceneCandidate
 * @property {string} bridgeIp - Bridge holding the scene.
 * @property {string} sceneId - Scene id on the bridge.
 * @property {string} sceneName - Scene name, as shown in the Hue app.
 * @property {string} groupId - Group to recall the scene on.
 * @property {string} [roomName] - Room or zone name, absent for a scene tied to no room.
 * @property {string[]} lights - Hue ids of the lights the scene sets.
 */

/**
 * Normalize a name for comparison: trimmed and case-insensitive.
 * @param {string} [name] - Name as typed or as stored on the bridge.
 * @returns {string} Comparable name.
 */
function normalize(name) {
  return String(name ?? '')
    .trim()
    .toLocaleLowerCase();
}

/**
 * List names for an error message: unique, sorted, capped.
 * @param {string[]} names - Names to list.
 * @returns {string} Comma-separated names, or "none".
 */
function listNames(names) {
  const unique = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  if (unique.length === 0) {
    return 'none';
  }
  const shown = unique.slice(0, MAX_LISTED_NAMES).join(', ');
  return unique.length > MAX_LISTED_NAMES ? `${shown}…` : shown;
}

/**
 * Flatten the scenes of one bridge into recallable candidates.
 * @param {string} bridgeIp - Bridge address.
 * @param {Record<string, object>} groups - `GET /groups` answer.
 * @param {Record<string, object>} scenes - `GET /scenes` answer.
 * @returns {SceneCandidate[]} Candidates of this bridge.
 */
export function listSceneCandidates(bridgeIp, groups, scenes) {
  const candidates = [];
  for (const [sceneId, scene] of Object.entries(scenes || {})) {
    if (!scene || scene.recycle || !scene.name) {
      continue;
    }
    const candidate = { bridgeIp, sceneId, sceneName: scene.name, lights: scene.lights || [] };
    if (scene.type === 'GroupScene') {
      const group = groups?.[scene.group];
      // The room was deleted: the bridge would refuse to recall the scene.
      if (!group) {
        continue;
      }
      candidate.groupId = scene.group;
      candidate.roomName = group.name;
    } else {
      candidate.groupId = ALL_LIGHTS_GROUP;
    }
    candidates.push(candidate);
  }
  return candidates;
}

/**
 * Pick the one scene matching the names typed by the user.
 * @param {SceneCandidate[]} candidates - Scenes of every reachable bridge.
 * @param {string} sceneName - Scene name (required).
 * @param {string} [roomName] - Room or zone name, to tell apart scenes sharing a name.
 * @returns {SceneCandidate} The matching scene.
 * @throws {Error} When no scene, or more than one, matches.
 */
export function findScene(candidates, sceneName, roomName) {
  const wantedScene = normalize(sceneName);
  const wantedRoom = normalize(roomName);
  if (!wantedScene) {
    throw new Error('No Hue scene name given');
  }

  let pool = candidates;
  if (wantedRoom) {
    pool = candidates.filter((candidate) => normalize(candidate.roomName) === wantedRoom);
    if (pool.length === 0) {
      const rooms = candidates.map((candidate) => candidate.roomName).filter(Boolean);
      throw new Error(`No Hue scene in room "${roomName}". Rooms with scenes: ${listNames(rooms)}`);
    }
  }

  const matches = pool.filter((candidate) => normalize(candidate.sceneName) === wantedScene);
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length === 0) {
    const where = wantedRoom ? ` in room "${roomName}"` : '';
    const names = pool.map((candidate) => candidate.sceneName);
    throw new Error(`Hue scene "${sceneName}" not found${where}. Available scenes: ${listNames(names)}`);
  }
  const rooms = listNames(matches.map((candidate) => candidate.roomName || 'no room'));
  const hint = wantedRoom ? '' : ': fill in the Room field to pick one';
  throw new Error(`Several Hue scenes are named "${sceneName}" (rooms: ${rooms})${hint}`);
}
