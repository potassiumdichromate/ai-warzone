// ============================================================
//  src/routes/zerog.js
//
//  0G Storage tracking & verification endpoints
//
//  GET  /0g/wallet           – show 0G wallet address + A0GI balance
//  GET  /0g/status/:wallet   – full 0G model info for a wallet
//  GET  /0g/all              – all wallets with ready models
//  POST /0g/verify/:wallet   – confirm file exists on 0G Indexer
//  POST /0g/push/:wallet     – push locally-stored model to 0G Storage
// ============================================================

const express  = require("express");
const router   = express.Router();
const { Indexer } = require("@0glabs/0g-ts-sdk");
const { ModelRecord, Sample } = require("../db/mongo");
const { uploadBuffer, invalidateCache, checkBalance } = require("../services/storage0g");

const INDEXER_RPC = process.env.ZERO_G_INDEXER_RPC;
const EXPLORER    = "https://storagescan.0g.ai";

// ── GET /0g/wallet ────────────────────────────────────────────
// Shows the backend's 0G wallet address and A0GI balance.
// Share this address with the team to fund it for storage uploads.
router.get("/wallet", async (_req, res) => {
  try {
    const { address, balanceEth, balanceWei } = await checkBalance();
    res.json({
      address,
      balanceEth,
      funded:     balanceWei > 0n,
      network:    "0G Mainnet (Chain ID: 16661)",
      tip:        balanceWei === 0n
        ? `⚠️  Fund this wallet with A0GI to enable 0G uploads. Bridge at: https://bridge.0g.ai`
        : `✅ Wallet is funded. Uploads to 0G Storage will succeed.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /0g/status/:wallet ────────────────────────────────────
// Shows everything about a wallet's model on 0G Storage (or local fallback)
router.get("/status/:wallet", async (req, res) => {
  try {
    const { wallet }  = req.params;
    const record      = await ModelRecord.findOne({ wallet });
    const sampleCount = await Sample.countDocuments({ wallet });

    if (!record || record.status === "none") {
      return res.json({
        wallet,
        sampleCount,
        onZeroG:     false,
        modelStatus: "none",
        message:     "No model trained yet"
      });
    }

    if (record.status === "training") {
      return res.json({
        wallet,
        sampleCount,
        onZeroG:     false,
        modelStatus: "training",
        message:     "Model is currently training…"
      });
    }

    if (record.status === "error") {
      return res.json({
        wallet,
        sampleCount,
        onZeroG:     false,
        modelStatus: "error",
        errorMsg:    record.errorMsg || null,
        message:     "Training failed. Use POST /behavior/retrain/:wallet to retry."
      });
    }

    // status === "ready"
    const onZeroG = record.storageType === "0g" && !!record.fileHash;
    const hasLocal = record.storageType === "local" && !!record.modelBuffer;

    res.json({
      wallet,
      sampleCount,
      modelStatus:   "ready",
      storageType:   record.storageType || "unknown",
      trainedAt:     record.trainedAt,
      // 0G info (only populated when storageType === "0g")
      onZeroG,
      fileHash:      record.fileHash || null,
      explorerUrl:   onZeroG ? `${EXPLORER}/file?hash=${record.fileHash}` : null,
      downloadUrl:   onZeroG ? `${EXPLORER}/api/download/${record.fileHash}` : null,
      indexerCheckUrl: onZeroG ? `${INDEXER_RPC}/file/info/${record.fileHash}` : null,
      network:       "0G Mainnet (Chain ID: 16661)",
      // Local info (only when storageType === "local")
      hasLocalBuffer: hasLocal,
      localNote:     hasLocal
        ? "Model stored in MongoDB. Fund the 0G wallet and POST /0g/push/:wallet to upload."
        : null,
      errorMsg:      record.errorMsg || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /0g/all ───────────────────────────────────────────────
// Dashboard — all wallets that have ready models (0G or local)
router.get("/all", async (req, res) => {
  try {
    const records = await ModelRecord.find({ status: "ready" })
      .sort({ trainedAt: -1 })
      .lean();

    const results = await Promise.all(records.map(async (r) => {
      const sampleCount = await Sample.countDocuments({ wallet: r.wallet });
      const onZeroG     = r.storageType === "0g" && !!r.fileHash;
      return {
        wallet:      r.wallet,
        sampleCount,
        trainedAt:   r.trainedAt,
        storageType: r.storageType || "unknown",
        fileHash:    r.fileHash || null,
        explorerUrl: onZeroG ? `${EXPLORER}/file?hash=${r.fileHash}` : null,
        onZeroG
      };
    }));

    const onChain  = results.filter(r => r.onZeroG).length;
    const onLocal  = results.filter(r => !r.onZeroG).length;

    res.json({
      totalModels: results.length,
      onZeroG:     onChain,
      localOnly:   onLocal,
      network:     "0G Mainnet",
      models:      results
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /0g/verify/:wallet ───────────────────────────────────
// Actively pings the 0G Indexer to confirm file still exists
router.post("/verify/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;
    const record     = await ModelRecord.findOne({ wallet, status: "ready" });

    if (!record?.fileHash) {
      return res.status(404).json({
        wallet,
        verified: false,
        reason:   record?.storageType === "local"
          ? "Model is stored locally (MongoDB), not on 0G yet. POST /0g/push/:wallet to upload."
          : "No fileHash found for this wallet"
      });
    }

    try {
      const indexer  = new Indexer(INDEXER_RPC);
      const fileInfo = await indexer.getFileInfo(record.fileHash);

      res.json({
        wallet,
        verified:    true,
        fileHash:    record.fileHash,
        explorerUrl: `${EXPLORER}/file?hash=${record.fileHash}`,
        network:     "0G Mainnet (Chain ID: 16661)",
        fileInfo:    fileInfo || "File confirmed on 0G Storage"
      });
    } catch (indexerErr) {
      res.json({
        wallet,
        verified:    "unknown",
        fileHash:    record.fileHash,
        explorerUrl: `${EXPLORER}/file?hash=${record.fileHash}`,
        warning:     "Indexer ping failed: " + indexerErr.message,
        tip:         "Check the explorerUrl manually to confirm"
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /0g/push/:wallet ─────────────────────────────────────
// Push a locally-stored model (in MongoDB) to 0G Storage.
// Use this after funding the backend 0G wallet with A0GI tokens.
router.post("/push/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;
    const record = await ModelRecord.findOne({ wallet });

    if (!record) {
      return res.status(404).json({ error: "No model record found for this wallet" });
    }

    if (record.status !== "ready") {
      return res.status(400).json({
        error: `Model is not ready (status: ${record.status}). Train first.`
      });
    }

    if (record.storageType === "0g" && record.fileHash) {
      return res.json({
        success:     true,
        alreadyOnZeroG: true,
        fileHash:    record.fileHash,
        explorerUrl: `${EXPLORER}/file?hash=${record.fileHash}`,
        message:     "Model is already on 0G Storage. Nothing to push."
      });
    }

    if (!record.modelBuffer) {
      return res.status(400).json({
        error: "No local model buffer found. Retrain via POST /behavior/retrain/:wallet first."
      });
    }

    // Check balance before attempting upload
    const { address, balanceEth, balanceWei } = await checkBalance();
    if (balanceWei === 0n) {
      return res.status(402).json({
        error:   "0G wallet has 0 A0GI balance. Fund it first.",
        address,
        bridge:  "https://bridge.0g.ai",
        network: "0G Mainnet (Chain ID: 16661)"
      });
    }

    console.log(`[/0g/push] Pushing local model to 0G for wallet: ${wallet}`);
    console.log(`[/0g/push] Uploading wallet balance: ${balanceEth} A0GI`);

    // Upload the buffer stored in MongoDB to 0G
    const rootHash = await uploadBuffer(
      record.modelBuffer,
      `model_${wallet.slice(0, 8)}.bin`
    );

    // Update DB record to reflect 0G storage
    await ModelRecord.findOneAndUpdate(
      { wallet },
      {
        fileHash:    rootHash,
        storageType: "0g",
        errorMsg:    null,
        modelBuffer: undefined   // clear local copy now that it's on 0G
      }
    );

    invalidateCache(rootHash);

    console.log(`✅ [/0g/push] Uploaded to 0G → ${rootHash}`);

    res.json({
      success:     true,
      wallet,
      fileHash:    rootHash,
      explorerUrl: `${EXPLORER}/file?hash=${rootHash}`,
      network:     "0G Mainnet (Chain ID: 16661)",
      message:     "Model successfully pushed to 0G Storage!"
    });

  } catch (err) {
    console.error(`[/0g/push] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
