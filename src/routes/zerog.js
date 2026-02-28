// ============================================================
//  src/routes/zerog.js
//
//  0G Storage tracking & verification endpoints
//
//  GET  /0g/status/:wallet   – full 0G model info for a wallet
//  GET  /0g/all              – all wallets with models on 0G
//  POST /0g/verify/:wallet   – confirm file actually exists on 0G
// ============================================================

const express  = require("express");
const router   = express.Router();
const { Indexer } = require("@0glabs/0g-ts-sdk");
const { ModelRecord, Sample } = require("../db/mongo");

const INDEXER_RPC = process.env.ZERO_G_INDEXER_RPC;
const EXPLORER    = "https://storagescan.0g.ai";

// ── GET /0g/status/:wallet ────────────────────────────────────
// Shows everything about a wallet's model on 0G Storage
router.get("/status/:wallet", async (req, res) => {
  try {
    const { wallet }  = req.params;
    const record      = await ModelRecord.findOne({ wallet });
    const sampleCount = await Sample.countDocuments({ wallet });

    if (!record || !record.fileHash) {
      return res.json({
        wallet,
        sampleCount,
        onZeroG:       false,
        modelStatus:   record?.status || "none",
        errorMsg:      record?.errorMsg || null,
        message:       "No model uploaded to 0G Storage yet"
      });
    }

    res.json({
      wallet,
      sampleCount,
      onZeroG:         true,
      modelStatus:     record.status,
      trainedAt:       record.trainedAt,
      fileHash:        record.fileHash,
      // 0G Storage explorer links
      explorerUrl:     `${EXPLORER}/file?hash=${record.fileHash}`,
      downloadUrl:     `${EXPLORER}/api/download/${record.fileHash}`,
      // 0G Indexer API (direct check)
      indexerCheckUrl: `${INDEXER_RPC}/file/info/${record.fileHash}`,
      network:         "0G Mainnet (Chain ID: 16661)",
      errorMsg:        record.errorMsg || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /0g/all ───────────────────────────────────────────────
// Dashboard view — all wallets that have models stored on 0G
router.get("/all", async (req, res) => {
  try {
    const records = await ModelRecord.find({ status: "ready" })
      .sort({ trainedAt: -1 })
      .lean();

    const results = await Promise.all(records.map(async (r) => {
      const sampleCount = await Sample.countDocuments({ wallet: r.wallet });
      return {
        wallet:      r.wallet,
        sampleCount,
        trainedAt:   r.trainedAt,
        fileHash:    r.fileHash,
        explorerUrl: `${EXPLORER}/file?hash=${r.fileHash}`
      };
    }));

    res.json({
      totalModels: results.length,
      network:     "0G Mainnet",
      models:      results
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /0g/verify/:wallet ───────────────────────────────────
// Actively pings the 0G Indexer to confirm the file still exists
router.post("/verify/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;
    const record     = await ModelRecord.findOne({ wallet, status: "ready" });

    if (!record?.fileHash) {
      return res.status(404).json({
        wallet,
        verified: false,
        reason:   "No fileHash found in DB for this wallet"
      });
    }

    // Ping the 0G Indexer
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
      // File might still be there, indexer check just failed
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

module.exports = router;
