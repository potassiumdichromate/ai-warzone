// ============================================================
//  index.js  –  Warzone AI Backend Entry Point
//
//  Endpoints exposed:
//    POST /behavior/upload        – Unity sends gameplay samples
//    GET  /behavior/status/:wallet – sample + model status
//    POST /behavior/retrain/:wallet – manually retrigger training
//    POST /ai/predict             – Unity requests AI action
//    GET  /0g/status/:wallet      – full 0G Storage info for a wallet
//    GET  /0g/all                 – all wallets with models on 0G
//    POST /0g/verify/:wallet      – ping 0G Indexer to confirm file exists
//    GET  /health                 – sanity check
// ============================================================

require("dotenv").config();

const express  = require("express");
const cors     = require("cors");
const mongoose = require("mongoose");

const behaviorRoutes = require("./src/routes/behavior");
const predictRoutes  = require("./src/routes/predict");
const zerogRoutes    = require("./src/routes/zerog");

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ──────────────────────────────────────────────
app.use(cors({
  origin: "*",   // tighten to your domain in production
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-Wallet", "X-Session"]
}));

app.use(express.json({ limit: "5mb" }));  // batches can be large

// ─── Health check ────────────────────────────────────────────
app.get("/health", (_req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbStates = { 0: "disconnected", 1: "connected", 2: "connecting", 3: "disconnecting" };
  res.json({
    status:       "ok",
    time:         new Date().toISOString(),
    db:           {
      state:      dbStates[dbState] || "unknown",
      name:       mongoose.connection.db?.databaseName || "not connected",
      host:       mongoose.connection.host || "unknown"
    }
  });
});

// ─── Routes ──────────────────────────────────────────────────
app.use("/behavior", behaviorRoutes);
app.use("/ai",       predictRoutes);
app.use("/0g",       zerogRoutes);

// ─── MongoDB connect then start ──────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ MongoDB connected:", process.env.MONGODB_URI);
    app.listen(PORT, () => {
      console.log(`🚀 Warzone AI backend running on port ${PORT}`);
      console.log(`   POST /behavior/upload`);
      console.log(`   GET  /behavior/status/:wallet`);
      console.log(`   POST /behavior/retrain/:wallet`);
      console.log(`   POST /ai/predict`);
      console.log(`   GET  /0g/wallet`);
      console.log(`   GET  /0g/status/:wallet`);
      console.log(`   GET  /0g/all`);
      console.log(`   POST /0g/verify/:wallet`);
      console.log(`   POST /0g/push/:wallet`);
      console.log(`   GET  /health`);
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  });
