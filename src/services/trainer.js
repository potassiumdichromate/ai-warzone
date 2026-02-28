// ============================================================
//  src/services/trainer.js
//
//  Behavioral Cloning trainer using TensorFlow.js (Node.js)
//
//  Model architecture:
//    Input  17  →  Dense 64 (relu)  →  Dense 64 (relu)
//           →  Dense 32 (relu)  →  Dense 5  (tanh)
//
//  Input  (17 floats): posX, posY, velX, velY, facingRight,
//                      isGrounded, hpPercent, +5 enemies×relX/relY
//  Output (5  floats): horizontal, vertical, jump, shoot, grenade
//
//  After training, serialises weights to a Buffer and
//  uploads to 0G Storage → stores rootHash in MongoDB.
// ============================================================

const tf       = require("@tensorflow/tfjs");
const { Sample, ModelRecord } = require("../db/mongo");
const { encodeState, encodeAction, INPUT_SIZE, OUTPUT_SIZE } = require("../utils/encoder");
const { uploadBuffer, invalidateCache } = require("./storage0g");

/**
 * Build the behavioral-cloning neural network.
 */
function buildModel() {
  const model = tf.sequential();

  model.add(tf.layers.dense({
    inputShape: [INPUT_SIZE],
    units: 64,
    activation: "relu",
    kernelInitializer: "glorotUniform"
  }));

  model.add(tf.layers.dense({ units: 64, activation: "relu" }));
  model.add(tf.layers.dense({ units: 32, activation: "relu" }));

  // tanh output: squashes all outputs to -1..1
  // For jump/shoot/grenade we threshold at 0 during inference
  model.add(tf.layers.dense({ units: OUTPUT_SIZE, activation: "tanh" }));

  model.compile({
    optimizer: tf.train.adam(0.001),
    loss: "meanSquaredError"
  });

  return model;
}

/**
 * Serialise a trained tf.Sequential model to a raw Buffer.
 * We save it as a TF.js binary artifacts bundle (JSON + weights).
 */
async function modelToBuffer(model) {
  // Collect model weights as a single flat Float32Array
  const weights = model.getWeights();
  const arrays  = await Promise.all(weights.map(w => w.data()));

  const meta = {
    modelTopology: model.toJSON(),
    weightsManifest: weights.map((w, i) => ({
      name:  w.name,
      shape: w.shape,
      dtype: w.dtype,
      size:  arrays[i].length
    }))
  };

  const metaJson = Buffer.from(JSON.stringify(meta), "utf8");
  const metaLen  = Buffer.alloc(4);
  metaLen.writeUInt32LE(metaJson.length, 0);

  // Concatenate: [4-byte metaLen][metaJson][weight bytes...]
  const weightBuffers = arrays.map(a => Buffer.from(a.buffer));
  return Buffer.concat([metaLen, metaJson, ...weightBuffers]);
}

/**
 * Trigger training for a wallet.
 * Runs asynchronously – does NOT block the HTTP response.
 *
 * @param {string} wallet
 */
async function trainForWallet(wallet) {
  console.log(`[Trainer] Starting training for wallet: ${wallet}`);

  // Mark as training
  await ModelRecord.findOneAndUpdate(
    { wallet },
    { status: "training" },
    { upsert: true }
  );

  try {
    // ── 1. Load all samples for this wallet ──────────────────
    const samples = await Sample.find({ wallet }).lean();
    console.log(`[Trainer] Loaded ${samples.length} samples`);

    if (samples.length < 10) {
      throw new Error("Not enough samples to train (need ≥ 10)");
    }

    // ── 2. Encode into tensors ────────────────────────────────
    const stateArrays  = [];
    const actionArrays = [];

    for (const s of samples) {
      if (!s.state || !s.action) continue;
      stateArrays.push(encodeState(s.state));
      actionArrays.push(encodeAction(s.action));
    }

    const N = stateArrays.length;
    const xs = tf.tensor2d(stateArrays,  [N, INPUT_SIZE],  "float32");
    const ys = tf.tensor2d(actionArrays, [N, OUTPUT_SIZE], "float32");

    // ── 3. Build & train ─────────────────────────────────────
    const model = buildModel();
    console.log(`[Trainer] Training on ${N} samples…`);

    await model.fit(xs, ys, {
      epochs:          50,
      batchSize:       32,
      validationSplit: 0.1,
      shuffle:         true,
      callbacks: {
        onEpochEnd: (epoch, logs) => {
          if ((epoch + 1) % 10 === 0) {
            console.log(`[Trainer] Epoch ${epoch + 1}/50 – loss: ${logs.loss.toFixed(5)}`);
          }
        }
      }
    });

    // Clean up tensors
    xs.dispose();
    ys.dispose();

    // ── 4. Serialise model → Buffer ───────────────────────────
    const modelBuffer = await modelToBuffer(model);
    model.dispose();
    console.log(`[Trainer] Model serialised (${modelBuffer.length} bytes)`);

    // ── 5. Upload to 0G Storage ───────────────────────────────
    const rootHash = await uploadBuffer(modelBuffer, `model_${wallet.slice(0, 8)}.bin`);

    // ── 6. Update MongoDB record ──────────────────────────────
    const record = await ModelRecord.findOneAndUpdate(
      { wallet },
      {
        fileHash:    rootHash,
        sampleCount: N,
        trainedAt:   new Date(),
        status:      "ready",
        errorMsg:    null
      },
      { upsert: true, new: true }
    );

    // Invalidate the download cache so next predict fetches the new model
    invalidateCache(rootHash);

    console.log(`✅ [Trainer] Training complete for ${wallet} → 0G hash: ${rootHash}`);
    return record;

  } catch (err) {
    console.error(`❌ [Trainer] Training failed for ${wallet}:`, err.message);
    await ModelRecord.findOneAndUpdate(
      { wallet },
      { status: "error", errorMsg: err.message },
      { upsert: true }
    );
    throw err;
  }
}

module.exports = { trainForWallet };
