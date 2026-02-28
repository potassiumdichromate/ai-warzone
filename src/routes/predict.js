// ============================================================
//  src/routes/predict.js
//
//  POST /ai/predict
//
//  Unity sends current player state every ~150ms when autopilot
//  is active.  We load the trained model for this wallet from
//  0G Storage (cached in memory after first load) and return
//  a predicted action.
//
//  If no model is trained yet, returns a safe neutral action
//  so Unity doesn't crash.
// ============================================================

const express = require("express");
const router  = express.Router();
const { predict } = require("../services/modelManager");

router.post("/predict", async (req, res) => {
  try {
    const { wallet, state } = req.body;

    // ── Validate ────────────────────────────────────────────
    if (!wallet || typeof wallet !== "string") {
      return res.status(400).json({ error: "Missing 'wallet'" });
    }
    if (!state || typeof state !== "object") {
      return res.status(400).json({ error: "Missing 'state'" });
    }

    // ── Run inference ────────────────────────────────────────
    const { action, confidence } = await predict(wallet, state);

    res.json({ action, confidence });

  } catch (err) {
    console.error("[/ai/predict] Error:", err.message);

    // Return safe fallback so Unity autopilot doesn't freeze
    res.json({
      action: {
        horizontal: 0,
        vertical:   0,
        jump:       false,
        shoot:      false,
        grenade:    false
      },
      confidence: 0
    });
  }
});

module.exports = router;
