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

// ─── POST /arena/join ────────────────────────────────────────
router.post("/join", async (req, res) => {
  try {
    const { matchId, player2HotWallet, player2Elo } = req.body;

    if (!matchId || !player2HotWallet) {
      return res.status(400).json({ error: "matchId and player2HotWallet are required" });
    }

    const match = await Arena.findById(matchId);

    if (!match) {
      return res.status(404).json({ error: "Match not found" });
    }

    if (match.status !== "OPEN") {
      return res.status(409).json({ error: `Match is not open for joining (current status: ${match.status})` });
    }

    if (match.player1HotWallet === player2HotWallet) {
      return res.status(400).json({ error: "Player 2 cannot be the same as Player 1" });
    }

    match.player2HotWallet = player2HotWallet;
    match.player2Elo       = player2Elo ?? null;
    match.status           = "IN_PROGRESS";
    await match.save();

    res.json({
      matchId:          match._id,
      player1HotWallet: match.player1HotWallet,
      player1Elo:       match.player1Elo,
      player2HotWallet: match.player2HotWallet,
      player2Elo:       match.player2Elo,
      status:           match.status,
      warzoneMatchId:   match.warzoneMatchId,
      prizeAmount:      match.prizeAmount,
      escrowId:         match.escrowId,
      startedAt:        match.startedAt,
      createdAt:        match.createdAt
    });
  } catch (err) {
    console.error("[arena/join]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /arena/match?matchId=... ───────────────────────────
router.get("/match", async (req, res) => {
  try {
    const { matchId } = req.query;

    if (!matchId) {
      return res.status(400).json({ error: "matchId query param is required" });
    }

    const match = await Arena.findById(matchId);

    if (!match) {
      return res.status(404).json({ error: "Match not found" });
    }

    res.json(match);
  } catch (err) {
    console.error("[arena/match]", err);
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
