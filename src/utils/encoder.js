// ============================================================
//  src/utils/encoder.js
//
//  Converts an AIStateSnapshot (from Unity) into a flat
//  Float32Array for TensorFlow.js input.
//
//  Input vector layout (17 values):
//    [0]  posX
//    [1]  posY
//    [2]  velX
//    [3]  velY
//    [4]  facingRight  (0 or 1)
//    [5]  isGrounded   (0 or 1)
//    [6]  hpPercent    (0..1)
//    [7]  enemy0.relX  (0 if none)
//    [8]  enemy0.relY
//    [9]  enemy1.relX
//    [10] enemy1.relY
//    [11] enemy2.relX
//    [12] enemy2.relY
//    [13] enemy3.relX
//    [14] enemy3.relY
//    [15] enemy4.relX
//    [16] enemy4.relY
//
//  Output vector layout (5 values):
//    [0]  horizontal  (-1..1)
//    [1]  vertical    (-1..1)
//    [2]  jump        (0 or 1)
//    [3]  shoot       (0 or 1)
//    [4]  grenade     (0 or 1)
// ============================================================

const INPUT_SIZE  = 17;
const OUTPUT_SIZE = 5;
const MAX_ENEMIES = 5;

/**
 * Encode a state snapshot object into a flat Float32Array.
 * @param {object} state  - AIStateSnapshot from Unity
 * @returns {Float32Array}
 */
function encodeState(state) {
  const arr = new Float32Array(INPUT_SIZE).fill(0);

  arr[0] = state.posX        || 0;
  arr[1] = state.posY        || 0;
  arr[2] = state.velX        || 0;
  arr[3] = state.velY        || 0;
  arr[4] = state.facingRight ? 1 : 0;
  arr[5] = state.isGrounded  ? 1 : 0;
  arr[6] = Math.max(0, Math.min(1, state.hpPercent || 0));

  const enemies = (state.enemies || []).slice(0, MAX_ENEMIES);
  for (let i = 0; i < MAX_ENEMIES; i++) {
    const base = 7 + i * 2;
    if (i < enemies.length) {
      arr[base]     = enemies[i].relX || 0;
      arr[base + 1] = enemies[i].relY || 0;
    }
    // else stays 0 (no enemy in this slot)
  }

  return arr;
}

/**
 * Encode an action snapshot into a flat Float32Array.
 * @param {object} action  - AIActionSnapshot from Unity
 * @returns {Float32Array}
 */
function encodeAction(action) {
  return new Float32Array([
    Math.max(-1, Math.min(1, action.horizontal || 0)),
    Math.max(-1, Math.min(1, action.vertical   || 0)),
    action.jump    ? 1 : 0,
    action.shoot   ? 1 : 0,
    action.grenade ? 1 : 0
  ]);
}

/**
 * Decode a raw output Float32Array back into an action object.
 * @param {Float32Array|number[]} output
 * @returns {object} AIActionSnapshot
 */
function decodeAction(output) {
  return {
    horizontal: Math.max(-1, Math.min(1, output[0])),
    vertical:   Math.max(-1, Math.min(1, output[1])),
    jump:       output[2] > 0.5,
    shoot:      output[3] > 0.5,
    grenade:    output[4] > 0.5
  };
}

module.exports = { encodeState, encodeAction, decodeAction, INPUT_SIZE, OUTPUT_SIZE };
