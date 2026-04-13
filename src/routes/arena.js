// ============================================================
//  src/routes/arena.js  –  Arena / Match endpoints
//
//  POST /arena/create  – open a new match session (player 1 only)
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

// ─── POST /arena/create ──────────────────────────────────────
router.post("/create", async (req, res) => {
  try {
    const { player1HotWallet, player1Elo, amount = 100 } = req.body;

    if (!player1HotWallet) {
      return res.status(400).json({ error: "player1HotWallet is required" });
    }

    const matchId        = uuidv4();
    const warzoneMatchId = `WZ-${Math.random().toString(36).substring(2, 11).toUpperCase()}`;
    const escrowId       = generateEscrowWallet();
    const prizeAmount    = (Number(amount) * 2).toString();

    const match = new Arena({
      _id:             matchId,
      player1HotWallet,
      player1Elo:      player1Elo ?? null,
      player2HotWallet: null,
      status:          "OPEN",
      warzoneMatchId,
      prizeAmount,
      escrowId,
      startedAt:       new Date()
    });

    await match.save();

    res.status(201).json({
      matchId,
      player1HotWallet,
      player1Elo:      match.player1Elo,
      player2HotWallet: null,
      status:          match.status,
      warzoneMatchId,
      prizeAmount,
      escrowId
    });
  } catch (err) {
    console.error("[arena/create]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /arena/matches ──────────────────────────────────────
router.get("/matches", async (req, res) => {
  try {
    const matches = await Arena.find({
      status: { $in: ["OPEN", "IN_PROGRESS"] }
    }).sort({ createdAt: -1 });

    res.json({
      total: matches.length,
      matches: matches.map(m => ({
        matchId:          m._id,
        player1HotWallet: m.player1HotWallet,
        player1Elo:       m.player1Elo,
        player2HotWallet: m.player2HotWallet,
        status:           m.status,
        warzoneMatchId:   m.warzoneMatchId,
        prizeAmount:      m.prizeAmount,
        escrowId:         m.escrowId,
        startedAt:        m.startedAt,
        createdAt:        m.createdAt
      }))
    });
  } catch (err) {
    console.error("[arena/matches]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
