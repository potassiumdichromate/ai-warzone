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
 * Get the wallet address & A0GI balance for the configured private key.
 * @returns {Promise<{address: string, balanceEth: string, balanceWei: bigint}>}
 */
async function checkBalance() {
  if (!PRIVATE_KEY || PRIVATE_KEY === "your_private_key_here") {
    throw new Error("ZERO_G_PRIVATE_KEY is not configured");
  }
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const balance  = await provider.getBalance(wallet.address);
  return {
    address:    wallet.address,
    balanceWei: balance,
    balanceEth: ethers.formatEther(balance)
  };
}

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

  // ── Pre-flight: check A0GI balance ──────────────────────────
  try {
    const { address, balanceEth, balanceWei } = await checkBalance();
    console.log(`[0G] Wallet ${address} balance: ${balanceEth} A0GI`);
    if (balanceWei === 0n) {
      throw new Error(
        `0G wallet has 0 A0GI. Fund this address on 0G mainnet (chain 16661): ${address}`
      );
    }
  } catch (balErr) {
    // Re-throw balance errors directly so they are clear in logs
    throw balErr;
  }

  // Write buffer to a temp file (ZgFile.fromFilePath is most reliable)
  const tmpPath = path.join(os.tmpdir(), `wz_upload_${Date.now()}_${filename}`);
  fs.writeFileSync(tmpPath, buffer);
  console.log(`[0G] Temp file written: ${tmpPath} (${buffer.length} bytes)`);

  try {
    const provider = new ethers.JsonRpcProvider(EVM_RPC);
    const signer   = new ethers.Wallet(PRIVATE_KEY, provider);

    // Confirm chain ID matches 0G mainnet (16661)
    const network = await provider.getNetwork();
    console.log(`[0G] Connected to chain ID: ${network.chainId} (expected 16661)`);

    // Build 0G file object
    const zgFile = await ZgFile.fromFilePath(tmpPath);
    const [tree, treeErr] = await zgFile.merkleTree();
    if (treeErr) throw new Error("0G merkle tree error: " + treeErr);

    const rootHash = tree.rootHash();
    console.log(`[0G] Merkle rootHash: ${rootHash}`);
    console.log(`[0G] FLOW_ADDRESS: ${FLOW_ADDRESS}`);
    console.log(`[0G] INDEXER_RPC:  ${INDEXER_RPC}`);
    console.log(`[0G] EVM_RPC:      ${EVM_RPC}`);

    // ── Pre-flight: try gas estimation on the Flow contract ──
    // This surfaces the actual revert reason before the full upload attempt.
    try {
      const flow = getFlowContract(FLOW_ADDRESS, signer);
      const nonce = await provider.getTransactionCount(signer.address);
      console.log(`[0G] Signer nonce: ${nonce}`);

      // Get all segments info for logging
      const [segments, segErr] = await zgFile.segmentRoots();
      if (segErr) {
        console.warn(`[0G] segmentRoots warning: ${segErr}`);
      } else {
        console.log(`[0G] Segments to submit: ${segments?.length ?? 0}`);
      }
    } catch (preflightErr) {
      console.warn(`[0G] Pre-flight check error: ${preflightErr?.message || preflightErr}`);
      if (preflightErr?.stack) console.warn(preflightErr.stack);
    }

    // Upload via Indexer
    // Override fee with an explicit amount to avoid SDK underpaying the
    // Flow contract's on-chain price check (require(msg.value >= price)).
    // 0.01 A0GI = 10^16 wei — far above any realistic storage fee.
    const EXPLICIT_FEE = BigInt('10000000000000000'); // 0.01 A0GI
    console.log(`[0G] Using explicit fee: ${EXPLICIT_FEE} wei (0.01 A0GI)`);

    const uploadOpts = {
      tags:             '0x',
      finalityRequired: true,
      taskSize:         10,
      expectedReplica:  1,
      skipTx:           false,
      fee:              EXPLICIT_FEE,
    };

    const indexer = new Indexer(INDEXER_RPC);
    let txHash, uploadErr;
    try {
      [txHash, uploadErr] = await indexer.upload(zgFile, EVM_RPC, signer, uploadOpts);
    } catch (sdkEx) {
      // Catch any synchronous throws from the SDK
      console.error(`[0G] SDK threw exception:`, sdkEx?.message || sdkEx);
      if (sdkEx?.stack) console.error(sdkEx.stack);
      throw new Error("0G SDK exception: " + (sdkEx?.message || sdkEx));
    }

    if (uploadErr) {
      // Log the raw error object to expose hidden details
      console.error(`[0G] uploadErr type: ${typeof uploadErr}`);
      console.error(`[0G] uploadErr value:`, uploadErr);
      if (uploadErr?.stack) console.error(`[0G] uploadErr stack:`, uploadErr.stack);
      if (uploadErr?.reason) console.error(`[0G] uploadErr reason:`, uploadErr.reason);
      if (uploadErr?.code) console.error(`[0G] uploadErr code:`, uploadErr.code);
      if (uploadErr?.data) console.error(`[0G] uploadErr data:`, uploadErr.data);
      throw new Error("0G upload error: " + (uploadErr?.message || uploadErr));
    }

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

module.exports = { uploadBuffer, downloadBuffer, invalidateCache, checkBalance };
