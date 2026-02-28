// ============================================================
//  src/db/mongo.js  –  Mongoose schemas
//
//  Collections:
//    samples   – raw gameplay recordings per wallet+session
//    models    – trained model metadata + 0G Storage hash
// ============================================================

const mongoose = require("mongoose");

// ─── Enemy sub-document ──────────────────────────────────────
const EnemySchema = new mongoose.Schema({
  relX:     Number,
  relY:     Number,
  distance: Number,
  state:    String,
  hpPercent: Number
}, { _id: false });

// ─── State snapshot ──────────────────────────────────────────
const StateSchema = new mongoose.Schema({
  timestamp:   Number,
  posX:        Number,
  posY:        Number,
  velX:        Number,
  velY:        Number,
  facingRight: Boolean,
  isGrounded:  Boolean,
  hpPercent:   Number,
  playerState: String,
  isFiring:    Boolean,
  enemyCount:  Number,
  enemies:     [EnemySchema]
}, { _id: false });

// ─── Action snapshot ─────────────────────────────────────────
const ActionSchema = new mongoose.Schema({
  horizontal: Number,
  vertical:   Number,
  jump:       Boolean,
  shoot:      Boolean,
  grenade:    Boolean
}, { _id: false });

// ─── One training sample ─────────────────────────────────────
const SampleSchema = new mongoose.Schema({
  wallet:    { type: String, required: true, index: true },
  sessionId: { type: String, required: true },
  state:     StateSchema,
  action:    ActionSchema,
  createdAt: { type: Date, default: Date.now }
});

// ─── Trained model record ────────────────────────────────────
const ModelRecordSchema = new mongoose.Schema({
  wallet:       { type: String, required: true, unique: true },
  fileHash:     { type: String },          // 0G Storage root hash (set when storageType="0g")
  sampleCount:  { type: Number, default: 0 },
  trainedAt:    { type: Date },
  status:       {
    type: String,
    enum: ["none", "training", "ready", "error"],
    default: "none"
  },
  // Where the model weights are stored:
  //   "0g"    – uploaded to 0G Storage, use fileHash to fetch
  //   "local" – saved in modelBuffer below (0G upload failed / not funded yet)
  //   "none"  – not trained yet
  storageType:  { type: String, enum: ["none", "0g", "local"], default: "none" },
  modelBuffer:  { type: Buffer },          // raw weights blob (fallback when 0G unavailable)
  errorMsg:     { type: String }
});

const Sample     = mongoose.model("Sample",      SampleSchema);
const ModelRecord = mongoose.model("ModelRecord", ModelRecordSchema);

module.exports = { Sample, ModelRecord };
