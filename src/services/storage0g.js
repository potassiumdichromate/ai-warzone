// ============================================================
//  src/services/storage0g.js
//
//  Handles all interaction with 0G Storage:
//    uploadBuffer()   – upload a Buffer, returns rootHash
//    downloadBuffer() – download by rootHash, returns Buffer
//
//  The rootHash is stored in MongoDB and uniquely identifies
//  the model weights file for a given wallet.
// ============================================================

const { ZgFile, Indexer, getFlowContract } = require("@0glabs/0g-ts-sdk");
const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

// 0G MAINNET — Chain ID 16661
// Explorer: https://chainscan.0g.ai
const INDEXER_RPC  = process.env.ZERO_G_INDEXER_RPC;   // https://indexer-storage-turbo.0g.ai
const EVM_RPC      = process.env.ZERO_G_EVM_RPC;        // https://evmrpc.0g.ai
const FLOW_ADDRESS = process.env.ZERO_G_FLOW_ADDRESS;   // 0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526
const PRIVATE_KEY  = process.env.ZERO_G_PRIVATE_KEY;

// In-memory download cache: rootHash → Buffer
// Prevents re-downloading the same model file on every /ai/predict call
const downloadCache = new Map();

/**
 * Upload a Buffer to 0G Storage.
 *
 * @param {Buffer} buffer   - File content (e.g. serialised model weights)
 * @param {string} filename - Logical name (for logging)
 * @returns {Promise<string>} rootHash – the 0G file identifier
 */
async function uploadBuffer(buffer, filename = "model.bin") {
  if (!PRIVATE_KEY || PRIVATE_KEY === "your_private_key_here") {
    throw new Error("ZERO_G_PRIVATE_KEY is not set in .env");
  }

  // Write buffer to a temp file (ZgFile.fromFilePath is most reliable)
  const tmpPath = path.join(os.tmpdir(), `wz_upload_${Date.now()}_${filename}`);
  fs.writeFileSync(tmpPath, buffer);

  try {
    const provider = new ethers.JsonRpcProvider(EVM_RPC);
    const signer   = new ethers.Wallet(PRIVATE_KEY, provider);

    // Build 0G file object
    const zgFile = await ZgFile.fromFilePath(tmpPath);
    const [tree, treeErr] = await zgFile.merkleTree();
    if (treeErr) throw new Error("0G merkle tree error: " + treeErr);

    const rootHash = tree.rootHash();

    // Upload
    const indexer = new Indexer(INDEXER_RPC);
    const [txHash, uploadErr] = await indexer.upload(zgFile, EVM_RPC, signer);
    if (uploadErr) throw new Error("0G upload error: " + uploadErr);

    console.log(`✅ [0G] Uploaded '${filename}' → rootHash: ${rootHash}`);
    console.log(`   txHash: ${txHash}`);

    return rootHash;
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

/**
 * Download a file from 0G Storage by rootHash.
 * Returns a Buffer. Result is cached in-memory.
 *
 * @param {string} rootHash - The 0G Storage identifier
 * @returns {Promise<Buffer>}
 */
async function downloadBuffer(rootHash) {
  // Return cached copy if available
  if (downloadCache.has(rootHash)) {
    console.log(`[0G] Cache hit for rootHash: ${rootHash}`);
    return downloadCache.get(rootHash);
  }

  const tmpPath = path.join(os.tmpdir(), `wz_download_${rootHash.slice(0, 12)}.bin`);

  try {
    const indexer = new Indexer(INDEXER_RPC);
    const err = await indexer.downloadFile(rootHash, tmpPath, false);
    if (err) throw new Error("0G download error: " + err);

    const buf = fs.readFileSync(tmpPath);
    downloadCache.set(rootHash, buf);   // Cache it

    console.log(`✅ [0G] Downloaded rootHash: ${rootHash} (${buf.length} bytes)`);
    return buf;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

/**
 * Clear the download cache for a specific rootHash
 * (call after uploading a new model for a wallet).
 */
function invalidateCache(rootHash) {
  downloadCache.delete(rootHash);
}

module.exports = { uploadBuffer, downloadBuffer, invalidateCache };
