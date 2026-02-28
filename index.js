// ============================================================
//  index.js  –  Warzone AI Backend Entry Point
//
//  Endpoints exposed:
//    POST /behavior/upload  – Unity sends gameplay samples
//    POST /ai/predict       – Unity requests AI action
//    GET  /health           – sanity check
// ============================================================

require("dotenv").config();

const express  = require("express");
const cors     = require("cors");
const mongoose = require("mongoose");

const behaviorRoutes = require("./src/routes/behavior");
const predictRoutes  = require("./src/routes/predict");

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
  res.json({ status: "ok", time: new Date().toISOString() });
});

// ─── Routes ──────────────────────────────────────────────────
app.use("/behavior", behaviorRoutes);
app.use("/ai",       predictRoutes);

// ─── MongoDB connect then start ──────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ MongoDB connected:", process.env.MONGODB_URI);
    app.listen(PORT, () => {
      console.log(`🚀 Warzone AI backend running on port ${PORT}`);
      console.log(`   POST /behavior/upload`);
      console.log(`   POST /ai/predict`);
      console.log(`   GET  /health`);
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  });
