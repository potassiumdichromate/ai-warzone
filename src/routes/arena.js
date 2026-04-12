// ============================================================
//  src/routes/arena.js  –  Arena / Match endpoints
//
//  POST /arena/escrow  – create a match escrow between two agents
// ============================================================

const express    = require("express");
const router     = express.Router();
const { v4: uuidv4 } = require("uuid");
const { Arena }  = require("../db/mongo");

// Generate a random Solana-style base58 escrow wallet address
function generateEscrowWallet() {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let addr = "";
  for (let i = 0; i < 44; i++) {
    addr += chars[Math.floor(Math.random() * chars.length)];
  }
  return addr;
}

// ─── POST /arena/escrow ──────────────────────────────────────
router.post("/escrow", async (req, res) => {
  try {
    const { player1HotWallet, player2HotWallet, amount = 100 } = req.body;

    if (!player1HotWallet || !player2HotWallet) {
      return res.status(400).json({ error: "player1HotWallet and player2HotWallet are required" });
    }

    const matchId        = uuidv4();
    const warzoneMatchId = `WZ-${Math.random().toString(36).substring(2, 11).toUpperCase()}`;
    const escrowId       = generateEscrowWallet();
    const prizeAmount    = (Number(amount) * 2).toString();

    const match = new Arena({
      _id:             matchId,
      player1HotWallet,
      player2HotWallet,
      status:          "IN_PROGRESS",
      warzoneMatchId,
      prizeAmount,
      escrowId,
      startedAt:       new Date()
    });

    await match.save();

    res.status(201).json({
      matchId,
      player1HotWallet,
      player2HotWallet,
      status:          match.status,
      warzoneMatchId,
      prizeAmount,
      escrowId
    });
  } catch (err) {
    console.error("[arena/escrow]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
