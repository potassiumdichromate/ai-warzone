# Warzone Warrior — Player AI Agent: Full Infrastructure Documentation

> **Audience:** Developers picking up this codebase from scratch.
> **Backend repo:** https://github.com/potassiumdichromate/ai-warzone
> **Live backend:** https://ai-warzone.onrender.com
> **Stack:** Node.js · Express · MongoDB · TensorFlow.js · 0G Storage (Chain 16661)

---

## Table of Contents

1. [System Architecture Overview](#1-system-architecture-overview)
2. [Tech Stack](#2-tech-stack)
3. [Directory Structure](#3-directory-structure)
4. [Environment Variables](#4-environment-variables)
5. [MongoDB Schemas](#5-mongodb-schemas)
6. [API Endpoints — Complete Reference](#6-api-endpoints--complete-reference)
7. [Stage 1 — Data Collection (Unity → Backend)](#7-stage-1--data-collection-unity--backend)
8. [Stage 2 — Encoding (State + Action → Tensors)](#8-stage-2--encoding-state--action--tensors)
9. [Stage 3 — Model Training (TensorFlow.js)](#9-stage-3--model-training-tensorflowjs)
10. [Stage 4 — Model Serialisation (Buffer Format)](#10-stage-4--model-serialisation-buffer-format)
11. [Stage 5 — 0G Storage Upload](#11-stage-5--0g-storage-upload)
12. [Stage 6 — Inference (Predict → Unity)](#12-stage-6--inference-predict--unity)
13. [0G Storage Deep Dive](#13-0g-storage-deep-dive)
14. [The ABI Mismatch Bug & Fix](#14-the-abi-mismatch-bug--fix)
15. [Model Manager & Caching](#15-model-manager--caching)
16. [Data Flow: End-to-End Diagram](#16-data-flow-end-to-end-diagram)
17. [Deployment on Render](#17-deployment-on-render)
18. [Troubleshooting Reference](#18-troubleshooting-reference)

---

## 1. System Architecture Overview

The system turns a human player's in-game behaviour into a trained AI agent
that can autopilot the player's character. It works in 6 stages:

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │                         UNITY WEBGL GAME                           │
 │  Player plays → AIRecorder captures (state, action) every frame    │
 │  Enough samples? → POST /behavior/upload → autopilot mode          │
 │  AI active?     → POST /ai/predict every 150ms                     │
 └───────────────────────────┬─────────────────────┬──────────────────┘
                             │                     │
                    [upload samples]        [request action]
                             │                     │
 ┌───────────────────────────▼─────────────────────▼──────────────────┐
 │                       NODE.JS BACKEND                              │
 │                     (Express on Render)                            │
 │                                                                    │
 │   /behavior/upload  ──→  MongoDB (samples collection)             │
 │                            └─ count >= 500? ──→ trainForWallet()  │
 │                                                        │           │
 │                                              TensorFlow.js train  │
 │                                                        │           │
 │                                              modelToBuffer()       │
 │                                                        │           │
 │                                         ┌──────────────┘           │
 │                                         │                          │
 │                              Try: uploadBuffer() ──→ 0G Storage   │
 │                              Fail: store in MongoDB (modelBuffer)  │
 │                                                                    │
 │   /ai/predict  ──→  modelManager.predict()                        │
 │                         └─ loadModel() ──→ 0G or MongoDB          │
 │                         └─ tf.predict() ──→ action                │
 └────────────────────────────────────────────────────────────────────┘
                                    │
                        ┌───────────▼────────────┐
                        │     0G STORAGE         │
                        │  (Blockchain, Chain     │
                        │   ID 16661)            │
                        │                        │
                        │  Flow contract stores  │
                        │  Merkle tree of file   │
                        │  Storage nodes hold    │
                        │  actual file chunks    │
                        └────────────────────────┘
```

Each wallet address = one unique player = one trained AI agent.

---

## 2. Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Game client | Unity WebGL + C# | Records gameplay, drives AI agent |
| HTTP API | Express.js (Node 18) | All backend routes |
| ML framework | `@tensorflow/tfjs` (Node) | Train + run inference |
| Primary database | MongoDB Atlas | Samples, model metadata, fallback weights |
| ODM | Mongoose | Schema definition and queries |
| Decentralised storage | 0G Storage (Chain 16661) | Permanent on-chain model weights |
| 0G SDK | `@0glabs/0g-ts-sdk@^0.3.3` | File upload/download to 0G network |
| EVM library | `ethers@^6` | Sign 0G Flow contract transactions |
| Hosting | Render.com (free tier) | Auto-deploy from GitHub main branch |

---

## 3. Directory Structure

```
ai-backend/
├── src/
│   ├── db/
│   │   └── mongo.js              # Mongoose schemas (Sample, ModelRecord)
│   ├── routes/
│   │   ├── behavior.js           # POST /behavior/upload, GET /behavior/status
│   │   ├── predict.js            # POST /ai/predict
│   │   └── zerog.js              # GET/POST /0g/* endpoints
│   ├── services/
│   │   ├── trainer.js            # TensorFlow.js training pipeline
│   │   ├── modelManager.js       # Load model, cache, run inference
│   │   └── storage0g.js          # 0G Storage upload/download
│   └── utils/
│       └── encoder.js            # State/action ↔ Float32Array conversion
├── package.json
├── AI_Infrastructure.md          # This document
└── .env                          # (never committed) — see §4
```

---

## 4. Environment Variables

Create a `.env` file in `ai-backend/` root:

```env
# MongoDB
MONGO_URI=mongodb+srv://<user>:<pass>@cluster.mongodb.net/warzone

# 0G Storage — Chain ID 16661 (0G Mainnet)
ZERO_G_EVM_RPC=https://evmrpc-testnet.0g.ai
ZERO_G_INDEXER_RPC=https://indexer-storage-testnet-standard.0g.ai
ZERO_G_PRIVATE_KEY=0x<backend_wallet_private_key>

# Training threshold: how many samples before training fires
MIN_SAMPLES_FOR_TRAINING=500

# Server
PORT=3001
```

> ⚠️ The `ZERO_G_PRIVATE_KEY` wallet must be funded with **A0GI tokens**
> (0G's native gas token). Get them at https://bridge.0g.ai.
> The wallet address can be checked via `GET /0g/wallet`.

---

## 5. MongoDB Schemas

### `samples` collection — one document per gameplay frame recorded

```javascript
{
  wallet:    String,    // Player's ETH wallet address (primary key per player)
  sessionId: String,    // UUID per play session (groups samples into sessions)
  createdAt: Date,

  state: {              // What the game looked like at this moment
    timestamp:   Number,
    posX:        Number,   // Player world position X
    posY:        Number,   // Player world position Y
    velX:        Number,   // Player velocity X
    velY:        Number,   // Player velocity Y
    facingRight: Boolean,
    isGrounded:  Boolean,
    hpPercent:   Number,   // 0.0 to 1.0
    playerState: String,   // "idle", "running", "jumping", etc.
    isFiring:    Boolean,
    enemyCount:  Number,
    enemies: [{            // Up to 5 nearest enemies
      relX:      Number,   // Enemy position relative to player
      relY:      Number,
      distance:  Number,
      state:     String,
      hpPercent: Number
    }]
  },

  action: {             // What the player DID at this moment (the label)
    horizontal: Number,  // -1 (left) to 1 (right)
    vertical:   Number,  // -1 (down) to 1 (up)
    jump:       Boolean,
    shoot:      Boolean,
    grenade:    Boolean
  }
}
```

### `modelrecords` collection — one document per wallet (player AI)

```javascript
{
  wallet:      String,   // Unique per player

  // Training state
  status:      "none" | "training" | "ready" | "error",
  sampleCount: Number,   // How many samples were used for last training
  trainedAt:   Date,
  errorMsg:    String,   // Set when status === "error"

  // Where model weights live
  storageType: "none" | "0g" | "local",

  // storageType === "0g": weights are on blockchain
  fileHash:    String,   // 0G Merkle rootHash (bytes32 hex)

  // storageType === "local": weights stored in this document (fallback)
  modelBuffer: Buffer    // Binary blob: [4-byte JSON length][JSON][float32 weights...]
}
```

---

## 6. API Endpoints — Complete Reference

### Behaviour / Training

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/behavior/upload` | Unity sends batch of `(state, action)` samples. Triggers training when `totalSamples >= MIN_SAMPLES`. |
| `GET`  | `/behavior/status/:wallet` | Returns sample count, model status, fileHash, 0G explorer link. |
| `POST` | `/behavior/retrain/:wallet` | Manually re-trigger training (resets error state first). |

#### `POST /behavior/upload` — request body

```json
{
  "wallet": "0x4A530e70A3843F11D56D6aCB828bbC58Ec528d02",
  "sessionId": "uuid-v4-string",
  "samples": [
    {
      "state":  { "posX": 12.5, "posY": 0.0, "velX": 3.2, "..." : "..." },
      "action": { "horizontal": 1, "vertical": 0, "jump": false, "shoot": true, "grenade": false }
    }
  ]
}
```

#### `POST /behavior/upload` — response

```json
{
  "success": true,
  "received": 50,
  "totalStored": 550,
  "trainingFired": true
}
```

### Inference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/ai/predict` | Unity sends current game state; returns predicted action every ~150ms. |

#### `POST /ai/predict` — request body

```json
{
  "wallet": "0x4A530...",
  "state": {
    "posX": 12.5, "posY": 0.0,
    "velX": 3.2,  "velY": -1.1,
    "facingRight": true,
    "isGrounded":  true,
    "hpPercent":   0.8,
    "enemies": [
      { "relX": 5.0,  "relY": 0.3 },
      { "relX": -8.2, "relY": 1.1 }
    ]
  }
}
```

#### `POST /ai/predict` — response

```json
{
  "action": {
    "horizontal": 0.87,
    "vertical":   0.0,
    "jump":       false,
    "shoot":      true,
    "grenade":    false
  },
  "confidence": 0.72
}
```

> If no model is trained yet, returns all-zero fallback so Unity does not crash.

### 0G Storage Management

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/0g/wallet`          | Show backend 0G wallet address + A0GI balance. |
| `GET`  | `/0g/status/:wallet`  | Full 0G info for a wallet's model. |
| `GET`  | `/0g/all`             | Dashboard — all wallets with ready models. |
| `POST` | `/0g/verify/:wallet`  | Ping 0G Indexer to confirm file still exists. |
| `POST` | `/0g/push/:wallet`    | Migrate local (MongoDB) model to 0G Storage. |

---

## 7. Stage 1 — Data Collection (Unity → Backend)

Unity records a `(state, action)` pair on every frame the player acts
(approximately every 50ms when moving/shooting). When a configurable
buffer of samples is full, it POSTs a batch to `/behavior/upload`.

```
Frame tick
  │
  ├─ AIStateSnapshot.Capture() ──→ { posX, posY, velX, velY, ... }
  ├─ InputSnapshot.Capture()   ──→ { horizontal, vertical, jump, shoot, grenade }
  │
  └─ Append to local ring buffer (size 50)
       │
       └─ Buffer full? ──→ POST /behavior/upload { wallet, sessionId, samples[] }
```

On the backend `behavior.js` route:

```javascript
// 1. Bulk insert into MongoDB
await Sample.insertMany(docs, { ordered: false });

// 2. Count total samples for this wallet
const totalSamples = await Sample.countDocuments({ wallet });

// 3. If threshold reached AND model not already training → fire training
if (totalSamples >= MIN_SAMPLES && !alreadyTraining) {
  evictModel(wallet);
  trainForWallet(wallet).catch(console.error);   // fire-and-forget
}
```

`trainForWallet()` is **not awaited** — the HTTP response returns immediately
(`{"success":true}`) while training runs in the background.

---

## 8. Stage 2 — Encoding (State + Action → Tensors)

File: `src/utils/encoder.js`

Before feeding data into TensorFlow, each rich state object must be
flattened into a fixed-size `Float32Array`.

### Input Vector — 17 values

```
Index  Field           Notes
──────────────────────────────────────────────────
  0    posX            World X position
  1    posY            World Y position
  2    velX            Velocity X (pixels/sec)
  3    velY            Velocity Y
  4    facingRight     1.0 or 0.0
  5    isGrounded      1.0 or 0.0
  6    hpPercent       Clamped 0.0–1.0
  7    enemy[0].relX   Relative X of nearest enemy (0 if none)
  8    enemy[0].relY
  9    enemy[1].relX
 10    enemy[1].relY
 11    enemy[2].relX
 12    enemy[2].relY
 13    enemy[3].relX
 14    enemy[3].relY
 15    enemy[4].relX
 16    enemy[4].relY   (up to 5 enemies)
```

### Output Vector — 5 values

```
Index  Field       Range   Notes
────────────────────────────────────────────────────
  0    horizontal  -1..1   Continuous (left/right)
  1    vertical    -1..1   Continuous (up/down)
  2    jump        0 or 1  Boolean encoded as float
  3    shoot       0 or 1
  4    grenade     0 or 1
```

During inference, continuous outputs are returned as-is; boolean outputs
use a **0.5 threshold** (`output > 0.5 → true`).

---

## 9. Stage 3 — Model Training (TensorFlow.js)

File: `src/services/trainer.js`

### Neural Network Architecture

```
Input Layer:  17 nodes  (game state vector)
                │
Dense Layer 1: 64 nodes, activation = ReLU, init = glorotUniform
                │
Dense Layer 2: 64 nodes, activation = ReLU
                │
Dense Layer 3: 32 nodes, activation = ReLU
                │
Output Layer:   5 nodes, activation = tanh   (squashes outputs to -1..1)
```

**Why tanh on output?**
All 5 outputs (including the boolean ones) are trained as continuous
`-1..1` values. `tanh` ensures the model can express confidence
(strong positive/negative) while booleans are snapped to true/false
at inference time using the 0.5 threshold.

### Training Configuration

```javascript
await model.fit(xs, ys, {
  epochs:          50,
  batchSize:       32,
  validationSplit: 0.1,   // 10% held out for validation loss
  shuffle:         true,
  optimizer:       tf.train.adam(0.001),
  loss:            "meanSquaredError"
});
```

**Behavioural Cloning** means we are doing supervised learning:
- Input  `X` = encoded game state
- Label  `Y` = what the real player did in that state
- Loss     = MSE between predicted action and actual action

The model learns to imitate the player's decisions.

### Training Data Assembly

```javascript
// Load every sample for this wallet from MongoDB
const samples = await Sample.find({ wallet }).lean();

// Encode into two 2D tensors
const xs = tf.tensor2d(stateArrays,  [N, 17], "float32");   // N × 17
const ys = tf.tensor2d(actionArrays, [N,  5], "float32");   // N × 5
```

---

## 10. Stage 4 — Model Serialisation (Buffer Format)

File: `src/services/trainer.js` → `modelToBuffer()`
Reverse: `src/services/modelManager.js` → `bufferToModel()`

After training, the model is packed into a single `Buffer` for storage.
This avoids relying on TF.js's built-in multi-file save format.

### Binary Format

```
Byte offset  Content
──────────────────────────────────────────────────────────
 0 – 3       UInt32LE: length of the JSON metadata block
 4 – (4+L)   UTF-8 JSON: { modelTopology, weightsManifest }
 (4+L) –     Raw float32 weight data, layer by layer
```

### The JSON metadata section (`weightsManifest`) example

```json
{
  "modelTopology": { "...": "full TF.js model JSON" },
  "weightsManifest": [
    { "name": "dense_Dense1/kernel", "shape": [17, 64], "dtype": "float32", "size": 1088 },
    { "name": "dense_Dense1/bias",   "shape": [64],     "dtype": "float32", "size": 64   },
    { "name": "dense_Dense2/kernel", "shape": [64, 64], "dtype": "float32", "size": 4096 },
    { "name": "dense_Dense2/bias",   "shape": [64],     "dtype": "float32", "size": 64   },
    { "name": "dense_Dense3/kernel", "shape": [64, 32], "dtype": "float32", "size": 2048 },
    { "name": "dense_Dense3/bias",   "shape": [32],     "dtype": "float32", "size": 32   },
    { "name": "dense_Dense4/kernel", "shape": [32, 5],  "dtype": "float32", "size": 160  },
    { "name": "dense_Dense4/bias",   "shape": [5],      "dtype": "float32", "size": 5    }
  ]
}
```

**Total weight values:** 1088 + 64 + 4096 + 64 + 2048 + 32 + 160 + 5 = **7557 float32s**
**Total weight bytes:** 7557 × 4 = **~30 KB**
**Typical full buffer size:** ~32 KB (very small for a blockchain upload)

---

## 11. Stage 5 — 0G Storage Upload

File: `src/services/storage0g.js`

### What is 0G Storage?

0G is a decentralised data availability and storage network.
Files are split into 256 KB segments → each segment gets a Merkle tree →
the root hash is submitted to an EVM smart contract (the **Flow contract**).
Storage nodes then store the actual bytes. Anyone with the root hash can
download the file from any storage node.

**Why use it?** Model weights become immutable, publicly verifiable,
and not dependent on a centralised server. The rootHash stored in MongoDB
is the permanent on-chain identifier of the trained model.

### Upload Flow

```
1. Write buffer to OS temp file   (/tmp/wz_upload_<timestamp>.bin)

2. ZgFile.fromFilePath(tmpPath)   → parses file into 256 KB segments

3. zgFile.merkleTree()            → builds Merkle tree over all segments
                                  → rootHash = bytes32 fingerprint of file

4. indexer.selectNodes(1)         → asks indexer RPC which storage nodes
                                     are available to receive this file

5. clients[0].getStatus()         → gets the node's reported Flow contract
                                     address on-chain

6. new ethers.Contract(flowAddr,  → instantiate Flow contract with the
     CORRECT_FLOW_ABI, signer)      correct ABI (see §14 — the big fix)

7. ZeroGUploader.uploadFile()     → internally calls:
     a. zgFile.createSubmission() → builds SubmissionData{length, tags, nodes[]}
     b. submitTransaction()       → wraps in Submission{data, submitter}
                                  → calls flow.submit({...}, {value: fee})
                                  → EVM transaction on chain 16661
     c. processLogs()             → reads submissionIndex from receipt log
     d. Segment upload loop       → POSTs each 256 KB segment to storage node

8. Returns rootHash               → stored as ModelRecord.fileHash in MongoDB

9. Delete temp file
```

### Fee Calculation

The Flow contract charges per storage sector (1024 bytes = 1 sector).
The fee is calculated as:

```
fee = pricePerSector × Σ(2 ^ node.height)   for each Merkle node in the submission
```

For a ~32 KB model:
- `pricePerSector` ≈ 30,733,644,962 wei
- A single segment node has height 10 (= 1024 sectors = 2^10)
- Fee ≈ 30,733,644,962 × 1024 ≈ **0.0000315 A0GI**

We pass `fee = 0.01 A0GI` as a safe explicit override.

---

## 12. Stage 6 — Inference (Predict → Unity)

File: `src/services/modelManager.js`

### `POST /ai/predict` flow

```
Unity sends { wallet, state }
                │
                ▼
predict(wallet, state)
                │
                ▼
loadModel(wallet)
   ├── Is model in in-memory cache?  ──YES──→ return cached tf.LayersModel
   │
   └── NO: query MongoDB for ModelRecord
              │
              ├── storageType === "0g"    → downloadBuffer(fileHash)
              │                               (cached in storage0g.js)
              │
              └── storageType === "local" → record.modelBuffer (direct from Mongo)
                                              │
                                              ▼
                                        bufferToModel(buffer)
                                          1. Read 4-byte metaLen
                                          2. Parse JSON topology
                                          3. Slice float32 weight arrays
                                          4. tf.models.modelFromJSON(topology)
                                          5. model.setWeights(tensors)
                                          6. Store in modelCache Map
                │
                ▼
encodeState(state)          → Float32Array[17]
                │
                ▼
tf.tensor2d([encoded], [1, 17])  → shape [1, 17] input tensor
                │
                ▼
model.predict(inputTensor)  → shape [1, 5] output tensor
                │
                ▼
decodeAction(outputData)    → { horizontal, vertical, jump, shoot, grenade }
                │
                ▼
res.json({ action, confidence })
                │
                ▼
Unity reads action → moves character
```

### Two-level Caching

| Level | What is cached | Key | Invalidated when |
|-------|---------------|-----|-----------------|
| `storage0g.js` `downloadCache` | Raw `Buffer` from 0G network | `rootHash` | `invalidateCache(rootHash)` called after re-train |
| `modelManager.js` `modelCache` | Loaded `tf.LayersModel` object | `wallet` | `evictModel(wallet)` called before re-train |

This means after the first `/ai/predict` for a wallet, subsequent calls
are **pure in-memory computation** — no network or disk I/O at all.

---

## 13. 0G Storage Deep Dive

### Network Configuration

```
Chain ID:     16661  (0G Mainnet)
EVM RPC:      https://evmrpc-testnet.0g.ai
Indexer RPC:  https://indexer-storage-testnet-standard.0g.ai
Explorer:     https://storagescan.0g.ai
Bridge:       https://bridge.0g.ai
```

### Contract Architecture

The 0G storage system uses three contracts:

```
Flow Contract  (BeaconProxy)
0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526
    │
    └── Beacon: 0x0c4504591d90432d559ecc51d1231ef2994e1738
            └── Implementation: 0xbb42168305b227430d289a928bb1a4d2d4c9e721

Market Contract  (referenced by Flow.market())
0xF574ff1fD8602F0131bAaB74f9F7CF24993321dE
    └── pricePerSector() → 30,733,644,962 wei
```

The Flow contract is a **Beacon Proxy** — a 295-byte proxy contract that
delegates all calls to the current implementation via a beacon.
This allows the implementation to be upgraded without changing the proxy address.

### What Happens On-Chain When You Upload

1. `flow.submit(submission, {value: fee})` is called
2. Contract verifies fee ≥ required
3. Emits `Submit(sender, identity, submissionIndex, startPos, length, submission)`
4. Returns `(submissionIndex, startPos, length, removedCount)`
5. Backend then POSTs actual file bytes to the selected storage node
6. Storage node verifies file matches the Merkle root and stores it

---

## 14. The ABI Mismatch Bug & Fix

> This was the hardest bug in the project. Understanding it prevents
> anyone picking up this code from hitting it again.

### The Problem

All versions of `@0glabs/0g-ts-sdk` (0.2.x and 0.3.x) bundle an internal
ABI for the Flow contract that defines `submit()` as:

```solidity
// What the SDK thinks the function signature is:
function submit(SubmissionData memory) payable

// Where SubmissionData = {uint256 length, bytes tags, SubmissionNode[] nodes}

// → ABI-encoded function selector:
// keccak256("submit((uint256,bytes,(bytes32,uint256)[]))") = 0xef3e12dc
```

But the **actual deployed contract implementation** (`0xbb42168305...`) has:

```solidity
// What the contract actually expects:
function submit(Submission memory) payable

// Where Submission     = {SubmissionData data, address submitter}
// and   SubmissionData = {uint256 length, bytes tags, SubmissionNode[] nodes}

// → Real function selector:
// keccak256("submit(((uint256,bytes,(bytes32,uint256)[]),address))") = 0xbc8c11f8
```

The SDK sends selector `0xef3e12dc`. The contract has no function with
that selector. The EVM reverts with empty revert data (`data="0x"`),
which manifests as `require(false)` — a completely opaque error with
no message.

### How We Found It

```bash
# 1. Get implementation address from beacon proxy
cast call 0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526 "implementation()" \
  --rpc-url https://evmrpc-testnet.0g.ai
# → 0xbb42168305b227430d289a928bb1a4d2d4c9e721

# 2. Get bytecode and scan for PUSH4 (selector registration pattern)
cast code 0xbb421683... --rpc-url ...
# 18,463 bytes — scan all PUSH4 values
# Found:     0xbc8c11f8  ✓  (the real submit selector)
# NOT found: 0xef3e12dc  ✗  (what the SDK sends)

# 3. Verify with eth_call using correct struct
cast call <flow_address> \
  "submit(((uint256,bytes,(bytes32,uint256)[]),address))" \
  "((1,0x,[(<root>,<height>)]),<signer>)" \
  --rpc-url ... --value 10000000000000000
# Returns: submissionIndex=56143  ← SUCCESS
```

### The Fix — `ZeroGUploader` class

```javascript
// src/services/storage0g.js

// 1. Define the CORRECT ABI matching the actual deployed contract
const CORRECT_FLOW_ABI = [
  {
    name: "submit",
    type: "function",
    inputs: [{
      name: "submission",
      type: "tuple",
      components: [
        {
          name: "data",
          type: "tuple",
          components: [
            { name: "length", type: "uint256" },
            { name: "tags",   type: "bytes"   },
            { name: "nodes",  type: "tuple[]",
              components: [
                { name: "root",   type: "bytes32" },
                { name: "height", type: "uint256" }
              ]
            }
          ]
        },
        { name: "submitter", type: "address" }   // ← THE MISSING FIELD
      ]
    }],
    stateMutability: "payable"
  },
  "function market() view returns (address)"
];

// 2. Extend SDK Uploader, override only submitTransaction()
class ZeroGUploader extends Uploader {
  async submitTransaction(subData, opts) {
    const signerAddress = await this._signer.getAddress();

    // SDK gives us SubmissionData {length, tags, nodes}
    // We wrap it into the full Submission {data, submitter}
    const submission = {
      data:      subData,          // ← SubmissionData as inner "data" field
      submitter: signerAddress     // ← Add our wallet address
    };

    const resp    = await this.flow.submit(submission, { value: fee, gasPrice });
    const receipt = await resp.wait();
    return [receipt, null];
  }

  async processLogs(receipt) {
    // Parse submissionIndex directly from raw log bytes
    // (robust against future ABI changes)
    for (const log of receipt.logs) {
      if (log.topics[0] === NEW_SUBMIT_TOPIC || log.topics[0] === OLD_SUBMIT_TOPIC) {
        const submissionIndex = BigInt("0x" + log.data.slice(2, 66));
        txSeqs.push(Number(submissionIndex));
      }
    }
    return txSeqs;
  }
}
```

### Submit Event Topic Hashes

The Submit event signature also changed with the new Submission struct.
We handle both to be safe:

```javascript
// New struct (with submitter field) — current mainnet
const NEW_SUBMIT_TOPIC = "0x76a9190ee05fc3d0a2b2ebad5664a657e17a830c48e432bdd2ce0b5201b266fb";

// Old struct (without submitter field) — legacy
const OLD_SUBMIT_TOPIC = "0x167ce04d2aa1981994d3a31695da0d785373335b1078cec239a1a3a2c7675555";
```

### SDK Version Notes

| SDK Version | `submit()` ABI | Download API | Status |
|-------------|---------------|-------------|--------|
| `0.2.x`     | Flat `SubmissionData` (wrong) | `downloadFile()` | ❌ ABI mismatch on mainnet |
| `0.3.x`     | Flat `SubmissionData` (wrong) | `download()` | ❌ ABI mismatch on mainnet |
| Our fix     | Wraps in `{data, submitter}` | `download()` | ✅ Works |

> **Note for future maintainers:** If `@0glabs/0g-ts-sdk` is updated
> and starts working without the `ZeroGUploader` workaround, you can
> switch back to `indexer.upload()` directly. Verify by checking that
> selector `0xbc8c11f8` is what the new SDK sends.

---

## 15. Model Manager & Caching

File: `src/services/modelManager.js`

### Load Priority

```javascript
async function loadModel(wallet) {
  // Level 1: In-process RAM cache (Map<wallet, tf.LayersModel>)
  if (modelCache.has(wallet)) return modelCache.get(wallet);

  const record = await ModelRecord.findOne({ wallet, status: "ready" });

  if (record.storageType === "0g") {
    // Level 2: 0G network (storage0g.js also caches the Buffer in RAM)
    buffer = await downloadBuffer(record.fileHash);
  } else {
    // Level 3: MongoDB modelBuffer field (local fallback)
    buffer = record.modelBuffer;
  }

  const model = await bufferToModel(buffer);
  modelCache.set(wallet, model);
  return model;
}
```

### Cache Invalidation

When training completes for a wallet, the old model must be evicted
so the next `/ai/predict` loads the freshly trained weights:

```javascript
// In behavior.js and zerog.js before triggering training:
evictModel(wallet);        // clears modelCache entry
invalidateCache(rootHash); // clears downloadCache entry in storage0g.js
trainForWallet(wallet);
```

---

## 16. Data Flow: End-to-End Diagram

```
PHASE 1 — RECORDING
═══════════════════════════════════════════════════════════════
 Unity Game
   │  Player presses keys → AIRecorder.OnFrameTick()
   │  Captures: { posX, posY, velX, velY, hp, enemies[], input }
   │  Batches 50 frames → POST /behavior/upload
   ▼
 behavior.js route
   │  Sample.insertMany(docs)
   │  totalSamples = countDocuments({wallet})
   │  totalSamples >= 500? → fire trainForWallet() (async, no await)
   ▼
 MongoDB → samples collection
   Wallet A: 550 documents
   Wallet B:  42 documents  (not enough yet)


PHASE 2 — TRAINING  (runs in background, ~10-30 seconds)
═══════════════════════════════════════════════════════════════
 trainForWallet(wallet)
   │
   ├─ ModelRecord.update({status: "training"})
   │
   ├─ Load 550 samples → encode → tf.tensor2d [550, 17] and [550, 5]
   │
   ├─ buildModel() → Sequential: 17→64→64→32→5
   │
   ├─ model.fit(xs, ys, {epochs:50, batchSize:32})
   │    Epoch 10/50 – loss: 0.04312
   │    Epoch 20/50 – loss: 0.02871
   │    ...
   │    Epoch 50/50 – loss: 0.01204
   │
   ├─ modelToBuffer(model)
   │    → [4 bytes][JSON topology + manifest][30KB float32 weights]
   │    Total: ~32 KB
   │
   ├─ uploadBuffer(buffer) ──→ 0G Storage (or fallback to MongoDB)
   │       │
   │       ├─ Write to /tmp/wz_upload_<ts>.bin
   │       ├─ ZgFile.fromFilePath() → parse segments
   │       ├─ merkleTree() → rootHash = "0xabc123..."
   │       ├─ indexer.selectNodes(1) → storage node client
   │       ├─ flow.submit({data, submitter}) → EVM TX on chain 16661
   │       │    value = 0.01 A0GI (fee for storage)
   │       │    selector = 0xbc8c11f8 (correct!)
   │       ├─ TX confirmed → log: submissionIndex=56143
   │       ├─ Upload 256KB segments to storage node
   │       └─ return rootHash
   │
   └─ ModelRecord.update({
         status: "ready",
         storageType: "0g",
         fileHash: "0xabc123...",
         modelBuffer: undefined
      })


PHASE 3 — INFERENCE  (runs every ~150ms during autopilot)
═══════════════════════════════════════════════════════════════
 Unity Autopilot
   │  POST /ai/predict { wallet, state: {...} }
   ▼
 predict.js route
   ▼
 modelManager.predict(wallet, state)
   │
   ├─ modelCache.has(wallet)?
   │      YES → skip to inference  (after first load, always this path)
   │      NO  →
   │           MongoDB.findOne({wallet}) → {storageType:"0g", fileHash:"0xabc123..."}
   │           downloadBuffer("0xabc123...") → Buffer (or from downloadCache)
   │           bufferToModel(buffer) → tf.Sequential
   │           modelCache.set(wallet, model)
   │
   ├─ encodeState(state) → Float32Array[17]
   │
   ├─ model.predict(tf.tensor2d([encoded],[1,17]))
   │    → Float32Array[5]:  [0.87, 0.0, -0.1, 0.92, -0.8]
   │
   ├─ decodeAction([0.87, 0.0, -0.1, 0.92, -0.8])
   │    → { horizontal:0.87, vertical:0.0, jump:false, shoot:true, grenade:false }
   │
   └─ res.json({ action, confidence: 0.72 })
         ▼
      Unity moves character → fire weapon → AI is playing!
```

---

## 17. Deployment on Render

The backend auto-deploys to Render on every push to `main`.

### Render Configuration

```
Service type:  Web Service
Runtime:       Node 18
Build command: npm install
Start command: node src/server.js
```

### Environment Variables on Render

Set all variables from §4 in the Render dashboard under
`Environment → Environment Variables`.

### Deployment Trigger

```bash
git add .
git commit -m "your message"
git push origin main
# Render detects push → rebuilds → restarts in ~2 minutes
```

### Check Deploy Status

```bash
# Hit the health endpoint
curl https://ai-warzone.onrender.com/health
```

---

## 18. Troubleshooting Reference

### 0G Upload: `require(false)` / empty revert data `0x`

**Cause:** SDK sends selector `0xef3e12dc`, contract expects `0xbc8c11f8`.
**Fix:** Already fixed via `ZeroGUploader` in `storage0g.js`. If it recurs
after an SDK update, re-verify the selector mismatch as described in §14.

### 0G Upload: `Error: 0G wallet has 0 A0GI`

**Fix:**
1. `GET /0g/wallet` to get the backend wallet address
2. Bridge A0GI tokens at https://bridge.0g.ai to that address on chain 16661
3. Retry: `POST /0g/push/:wallet`

### Model stuck in `status: "training"` forever

The training process died mid-run (Render restarted, OOM, etc.).
**Fix:**
```
POST /behavior/retrain/:wallet
```
This resets status to `"none"` and re-fires training.

### `POST /ai/predict` always returns zeros

The model is not trained yet, or training errored.
**Check:**
```
GET /behavior/status/:wallet
→ look at: modelStatus, errorMsg
```

### `zgFile.segmentRoots is not a function`

SDK version mismatch. This method was removed in 0.3.x.
**Fix:** Remove any pre-flight calls to `zgFile.segmentRoots()`.
The current `storage0g.js` does not use it.

### `indexer.downloadFile is not a function`

Old code using 0.2.x API. In 0.3.3, the method was renamed.
**Fix:** Use `indexer.download(rootHash, tmpPath, false)` (already fixed).

### High `/ai/predict` latency on first call

The model is not yet in cache. First call triggers:
MongoDB lookup → 0G download → `bufferToModel()` → cache.
Subsequent calls are pure RAM (~1ms). This is expected behaviour.

---

## Key Constants Quick Reference

```
Chain ID:               16661
EVM RPC:                https://evmrpc-testnet.0g.ai
Indexer RPC:            https://indexer-storage-testnet-standard.0g.ai
Flow Contract:          0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526
Flow Implementation:    0xbb42168305b227430d289a928bb1a4d2d4c9e721
Market Contract:        0xF574ff1fD8602F0131bAaB74f9F7CF24993321dE
submit() selector:      0xbc8c11f8   (correct, with submitter field)
Submit event topic:     0x76a9190ee05fc3d0a2b2ebad5664a657e17a830c48e432bdd2ce0b5201b266fb
pricePerSector:         ~30,733,644,962 wei
MIN_SAMPLES default:    500
Model input size:       17 floats
Model output size:      5 floats
Buffer format:          [4-byte metaLen][JSON][float32 weights]
```
