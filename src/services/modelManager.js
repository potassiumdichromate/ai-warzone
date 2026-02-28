// ============================================================
//  src/services/modelManager.js
//
//  Loads a trained model from 0G Storage, caches it in memory,
//  and runs inference (predict action from state).
//
//  Flow:
//    1. Look up wallet in MongoDB → get fileHash (0G root hash)
//    2. Download model weights buffer from 0G Storage
//    3. Deserialise buffer back into a tf.LayersModel
//    4. Run model.predict() on the encoded state
//    5. Return decoded action object
// ============================================================

const tf = require("@tensorflow/tfjs");
const { ModelRecord } = require("../db/mongo");
const { downloadBuffer } = require("./storage0g");
const { encodeState, decodeAction, INPUT_SIZE, OUTPUT_SIZE } = require("../utils/encoder");

// In-memory model cache: wallet → tf.LayersModel
// Prevents rebuilding the model graph on every /ai/predict call
const modelCache = new Map();

// ─── Neutral fallback action (safe defaults) ─────────────────
const FALLBACK_ACTION = {
  horizontal: 0,
  vertical:   0,
  jump:       false,
  shoot:      false,
  grenade:    false
};

/**
 * Deserialise a Buffer (produced by trainer.js:modelToBuffer)
 * back into a tf.Sequential model.
 *
 * Buffer layout: [4-byte metaLen][metaJson][weight bytes...]
 */
async function bufferToModel(buffer) {
  // Read metadata length
  const metaLen  = buffer.readUInt32LE(0);
  const metaJson = JSON.parse(buffer.slice(4, 4 + metaLen).toString("utf8"));

  // Reconstruct weight tensors
  let offset = 4 + metaLen;
  const weights = [];

  for (const manifest of metaJson.weightsManifest) {
    const byteLen = manifest.size * 4;   // float32 = 4 bytes
    const slice   = buffer.slice(offset, offset + byteLen);
    const arr     = new Float32Array(
      slice.buffer,
      slice.byteOffset,
      manifest.size
    );
    weights.push(tf.tensor(arr, manifest.shape, manifest.dtype));
    offset += byteLen;
  }

  // Rebuild model from saved topology
  const model = await tf.models.modelFromJSON(metaJson.modelTopology);
  model.setWeights(weights);

  // Free intermediate tensors
  weights.forEach(w => w.dispose());

  return model;
}

/**
 * Load (or return cached) model for a wallet.
 * Returns null if no trained model exists yet.
 *
 * @param {string} wallet
 * @returns {Promise<tf.LayersModel|null>}
 */
async function loadModel(wallet) {
  // Already cached?
  if (modelCache.has(wallet)) return modelCache.get(wallet);

  // Look up DB record
  const record = await ModelRecord.findOne({ wallet, status: "ready" });
  if (!record || !record.fileHash) return null;

  // Download weights from 0G Storage
  const buffer = await downloadBuffer(record.fileHash);

  // Deserialise
  const model = await bufferToModel(buffer);
  modelCache.set(wallet, model);

  console.log(`[ModelManager] Model loaded for wallet: ${wallet}`);
  return model;
}

/**
 * Evict a wallet's cached model (call after new training finishes).
 * @param {string} wallet
 */
function evictModel(wallet) {
  if (modelCache.has(wallet)) {
    const m = modelCache.get(wallet);
    try { m.dispose(); } catch (_) {}
    modelCache.delete(wallet);
    console.log(`[ModelManager] Cache evicted for wallet: ${wallet}`);
  }
}

/**
 * Run inference: state → action.
 *
 * @param {string} wallet
 * @param {object} state  - AIStateSnapshot from Unity
 * @returns {Promise<{action: object, confidence: number}>}
 */
async function predict(wallet, state) {
  const model = await loadModel(wallet);

  if (!model) {
    // No trained model yet – return safe neutral action
    return { action: FALLBACK_ACTION, confidence: 0 };
  }

  // Encode state → tensor [1, INPUT_SIZE]
  const encoded = encodeState(state);
  const input   = tf.tensor2d([Array.from(encoded)], [1, INPUT_SIZE]);

  // Run inference
  const outputTensor = model.predict(input);
  const outputData   = await outputTensor.data();

  // Clean up tensors
  input.dispose();
  outputTensor.dispose();

  // Decode raw floats → action object
  const action = decodeAction(outputData);

  // Simple confidence: how far the continuous outputs are from 0.5 threshold
  const confidence = Math.min(
    1,
    (Math.abs(outputData[3]) + Math.abs(outputData[0])) / 2
  );

  return { action, confidence };
}

module.exports = { predict, evictModel };
