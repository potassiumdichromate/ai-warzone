// ============================================================
//  src/routes/behavior.js
//
//  POST /behavior/upload
//
//  Unity sends batches of gameplay samples here.
//  Stores them in MongoDB, then fires training if enough
//  samples have been accumulated for this wallet.
// ============================================================

const express  = require("express");
const router   = express.Router();
const { Sample, ModelRecord } = require("../db/mongo");
const { trainForWallet }      = require("../services/trainer");
const { evictModel }          = require("../services/modelManager");

const MIN_SAMPLES = parseInt(process.env.MIN_SAMPLES_FOR_TRAINING || "500");

router.post("/upload", async (req, res) => {
  try {
    const { wallet, sessionId, samples } = req.body;

    // ── Validate ────────────────────────────────────────────
    if (!wallet || typeof wallet !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'wallet'" });
    }
    if (!Array.isArray(samples) || samples.length === 0) {
      return res.status(400).json({ error: "No samples provided" });
    }

    console.log(`[/behavior/upload] wallet=${wallet} samples=${samples.length} session=${sessionId}`);

    // ── Insert samples ───────────────────────────────────────
    const docs = samples.map(s => ({
      wallet,
      sessionId: sessionId || "unknown",
      state:  s.state,
      action: s.action
    }));

    await Sample.insertMany(docs, { ordered: false });

    // ── Check if we should trigger training ─────────────────
    const totalSamples = await Sample.countDocuments({ wallet });
    console.log(`[/behavior/upload] total samples for ${wallet}: ${totalSamples}`);

    const modelRecord = await ModelRecord.findOne({ wallet });
    const alreadyTraining = modelRecord && modelRecord.status === "training";

    if (totalSamples >= MIN_SAMPLES && !alreadyTraining) {
      console.log(`[/behavior/upload] Threshold reached – starting training for ${wallet}`);
      // Fire-and-forget: don't await, don't block the response
      evictModel(wallet); // clear old cached model
      trainForWallet(wallet).catch(err =>
        console.error("[/behavior/upload] Training error:", err.message)
      );
    }

    res.json({
      success:      true,
      received:     samples.length,
      totalStored:  totalSamples,
      trainingFired: totalSamples >= MIN_SAMPLES && !alreadyTraining
    });

  } catch (err) {
    console.error("[/behavior/upload] Error:", err.message);
    res.status(500).json({ error: "Internal server error", detail: err.message });
  }
});

// ── GET /behavior/status/:wallet ─────────────────────────────
// Full status: samples, model, error reason, 0G link
router.get("/status/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;
    const sampleCount = await Sample.countDocuments({ wallet });
    const record      = await ModelRecord.findOne({ wallet });

    const fileHash = record?.fileHash || null;

    res.json({
      wallet,
      sampleCount,
      samplesNeeded:   Math.max(0, MIN_SAMPLES - sampleCount),
      readyToTrain:    sampleCount >= MIN_SAMPLES,
      modelStatus:     record?.status    || "none",
      trainedAt:       record?.trainedAt || null,
      fileHash,
      // Direct link to verify file on 0G Storage explorer
      zeroGExplorer:   fileHash
        ? `https://storagescan.0g.ai/file?hash=${fileHash}`
        : null,
      errorMsg:        record?.errorMsg  || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /behavior/retrain/:wallet ────────────────────────────
// Manually trigger retraining (useful after an error)
router.post("/retrain/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;

    const sampleCount = await Sample.countDocuments({ wallet });
    if (sampleCount < 10) {
      return res.status(400).json({
        error: `Not enough samples. Have ${sampleCount}, need at least 10.`
      });
    }

    const record = await ModelRecord.findOne({ wallet });
    if (record?.status === "training") {
      return res.status(409).json({ error: "Already training. Please wait." });
    }

    // Reset error state and retrain
    await ModelRecord.findOneAndUpdate(
      { wallet },
      { status: "none", errorMsg: null },
      { upsert: true }
    );

    evictModel(wallet);
    trainForWallet(wallet).catch(err =>
      console.error("[/retrain] Training error:", err.message)
    );

    res.json({
      success: true,
      message: `Retraining started for ${wallet} with ${sampleCount} samples.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
