// ============================================================
//  src/routes/agent.js  –  AI Arena Agent endpoints
//
//  POST /agent/create   – register a new AI agent
//  POST /agent/fund     – add currency to an agent by hotWalletAddress
// ============================================================

const express = require("express");
const router  = express.Router();
const { Agent } = require("../db/mongo");

// Generate a random Solana-style base58 wallet address (44 chars)
function generateSolanaWallet() {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let addr = "";
  for (let i = 0; i < 44; i++) {
    addr += chars[Math.floor(Math.random() * chars.length)];
  }
  return addr;
}

// ─── GET /agent?walletAddress=0x... ─────────────────────────
router.get("/", async (req, res) => {
  try {
    const { walletAddress } = req.query;

    if (!walletAddress) {
      return res.status(400).json({ error: "walletAddress query param is required" });
    }

    const agent = await Agent.findOne({ ownerWallet: walletAddress.toLowerCase() });

    if (!agent) {
      return res.status(404).json({
        found: false,
        message: "No agent found for this wallet address. Please create an agent first."
      });
    }

    res.json({ found: true, agent });
  } catch (err) {
    console.error("[agent/get]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /agent/create ──────────────────────────────────────
router.post("/create", async (req, res) => {
  try {
    const { id, walletAddress, name, description } = req.body;

    if (!id || !walletAddress || !name) {
      return res.status(400).json({ error: "id, walletAddress, and name are required" });
    }

    const onChainId        = Math.floor(Math.random() * 10_000_000).toString();
    const hotWalletAddress = generateSolanaWallet();

    const agent = new Agent({
      _id:             id,
      name,
      description:     description || "",
      ownerWallet:     walletAddress.toLowerCase(),
      hotWalletAddress,
      onChainId,
    });

    await agent.save();

    res.status(201).json(agent);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: "Agent with this ID already exists" });
    }
    console.error("[agent/create]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /agent/fund ────────────────────────────────────────
router.post("/fund", async (req, res) => {
  try {
    const { hotWalletAddress, amount } = req.body;

    if (!hotWalletAddress || amount == null) {
      return res.status(400).json({ error: "hotWalletAddress and amount are required" });
    }

    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: "amount must be a positive number" });
    }

    const agent = await Agent.findOne({ hotWalletAddress });
    if (!agent) {
      return res.status(404).json({ error: "No agent found with that hotWalletAddress" });
    }

    agent.currency += numAmount;
    await agent.save();

    res.json({
      success:         true,
      agentId:         agent._id,
      hotWalletAddress: agent.hotWalletAddress,
      funded:          numAmount,
      newBalance:      agent.currency
    });
  } catch (err) {
    console.error("[agent/fund]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
