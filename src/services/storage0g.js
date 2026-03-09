// ============================================================
//  src/services/storage0g.js
//
//  Handles all interaction with 0G Storage:
//    uploadBuffer()   – upload a Buffer, returns rootHash
//    downloadBuffer() – download by rootHash, returns Buffer
//
//  ROOT CAUSE FIX (2025-03):
//  The deployed 0G mainnet Flow contract uses a DIFFERENT Submission
//  struct than the one bundled in all SDK versions (0.2.x and 0.3.x):
//
//    SDK expects:  submit({length, tags, nodes})           ← selector 0xef3e12dc
//    Contract has: submit({data:{length,tags,nodes}, submitter}) ← selector 0xbc8c11f8
//
//  ZeroGUploader extends the SDK's Uploader and overrides
//  submitTransaction() to wrap SubmissionData in the real struct.
// ============================================================

const { ZgFile, Indexer, Uploader } = require("@0glabs/0g-ts-sdk");
const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

// 0G MAINNET — Chain ID 16661
const INDEXER_RPC  = process.env.ZERO_G_INDEXER_RPC;
const EVM_RPC      = process.env.ZERO_G_EVM_RPC;
const PRIVATE_KEY  = process.env.ZERO_G_PRIVATE_KEY;

// ── Correct ABI for the deployed Flow contract ────────────────────────────
// The Submission struct on-chain is {SubmissionData data, address submitter}
// where SubmissionData = {uint256 length, bytes tags, SubmissionNode[] nodes}.
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
            {
              name: "nodes",
              type: "tuple[]",
              components: [
                { name: "root",   type: "bytes32" },
                { name: "height", type: "uint256" }
              ]
            }
          ]
        },
        { name: "submitter", type: "address" }
      ]
    }],
    outputs: [
      { name: "", type: "uint256" },
      { name: "", type: "bytes32" },
      { name: "", type: "uint256" },
      { name: "", type: "uint256" }
    ],
    stateMutability: "payable"
  },
  // Submit event — topic 0x76a9190ee05fc3d0a2b2ebad5664a657e17a830c48e432bdd2ce0b5201b266fb
  {
    name: "Submit",
    type: "event",
    anonymous: false,
    inputs: [
      { indexed: true,  name: "sender",          type: "address"  },
      { indexed: true,  name: "identity",         type: "bytes32"  },
      { indexed: false, name: "submissionIndex",  type: "uint256"  },
      { indexed: false, name: "startPos",         type: "uint256"  },
      { indexed: false, name: "length",           type: "uint256"  },
      {
        indexed: false,
        name: "submission",
        type: "tuple",
        components: [
          {
            name: "data",
            type: "tuple",
            components: [
              { name: "length", type: "uint256"  },
              { name: "tags",   type: "bytes"    },
              {
                name: "nodes",
                type: "tuple[]",
                components: [
                  { name: "root",   type: "bytes32" },
                  { name: "height", type: "uint256" }
                ]
              }
            ]
          },
          { name: "submitter", type: "address" }
        ]
      }
    ]
  },
  "function market() view returns (address)"
];

// Pre-computed Submit event topic hashes (both struct versions, for robust log parsing)
const NEW_SUBMIT_TOPIC = "0x76a9190ee05fc3d0a2b2ebad5664a657e17a830c48e432bdd2ce0b5201b266fb";
const OLD_SUBMIT_TOPIC = "0x167ce04d2aa1981994d3a31695da0d785373335b1078cec239a1a3a2c7675555";

// ── ZeroGUploader ─────────────────────────────────────────────────────────
// Extends the SDK Uploader to use the correct on-chain Submission struct.
class ZeroGUploader extends Uploader {
  constructor(nodes, providerRpc, correctFlow, signer, gasPrice = 0n, gasLimit = 0n) {
    super(nodes, providerRpc, correctFlow, gasPrice, gasLimit);
    this._signer = signer;
  }

  // Wrap SubmissionData → full Submission{data, submitter} before sending.
  async submitTransaction(subData, opts, retryOpts) {
    const signerAddress = await this._signer.getAddress();
    const submission    = { data: subData, submitter: signerAddress };

    // Use explicit fee override (0.01 A0GI) or calculate from price × sectors
    let fee = 0n;
    if (opts.fee && BigInt(opts.fee) > 0n) {
      fee = BigInt(opts.fee);
    } else {
      const marketAddr     = await this.flow.market();
      const market         = new ethers.Contract(
        marketAddr,
        ["function pricePerSector() view returns (uint256)"],
        this.provider
      );
      const pricePerSector = await market.pricePerSector();
      for (const node of subData.nodes) {
        fee += pricePerSector * (2n ** BigInt(node.height));
      }
    }

    const feeData  = await this.provider.getFeeData();
    const gasPrice = this.gasPrice > 0n ? this.gasPrice : feeData.gasPrice;

    console.log(`[0G] submit({data, submitter=${signerAddress}}) fee=${fee}wei`);

    try {
      const resp    = await this.flow.submit(submission, { value: fee, gasPrice });
      const receipt = await resp.wait();
      if (!receipt || receipt.status === 0) {
        return [null, new Error("Transaction reverted on-chain")];
      }
      console.log(`[0G] Transaction confirmed: ${receipt.hash}`);
      return [receipt, null];
    } catch (e) {
      console.error("[0G] submitTransaction error:", e.message);
      if (e.data)   console.error("[0G] error data:", e.data);
      if (e.reason) console.error("[0G] error reason:", e.reason);
      return [null, e];
    }
  }

  // Decode submissionIndex directly from raw log data, robust against ABI changes.
  async processLogs(receipt) {
    const contractAddress = (await this.flow.getAddress()).toLowerCase();
    const txSeqs = [];

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== contractAddress) continue;
      if (!log.topics[0]) continue;
      // Match either new (with submitter) or old Submit event topic hash
      if (log.topics[0] !== NEW_SUBMIT_TOPIC && log.topics[0] !== OLD_SUBMIT_TOPIC) continue;
      // Non-indexed data layout: [submissionIndex][startPos][length][offset→submission][...]
      // submissionIndex is always the first uint256 (bytes 0–31 of log.data)
      if (log.data.length < 66) continue;
      try {
        const submissionIndex = BigInt("0x" + log.data.slice(2, 66));
        txSeqs.push(Number(submissionIndex));
        console.log(`[0G] Parsed submissionIndex: ${submissionIndex}`);
      } catch (_) { /* skip malformed log */ }
    }
    return txSeqs;
  }
}

// ── In-memory download cache ──────────────────────────────────────────────
const downloadCache = new Map();

// ── checkBalance ──────────────────────────────────────────────────────────
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

// ── uploadBuffer ──────────────────────────────────────────────────────────
/**
 * Upload a Buffer to 0G Storage.
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {Promise<string>} rootHash
 */
async function uploadBuffer(buffer, filename = "model.bin") {
  if (!PRIVATE_KEY || PRIVATE_KEY === "your_private_key_here") {
    throw new Error("ZERO_G_PRIVATE_KEY is not set in .env");
  }

  // Pre-flight balance check
  const { address, balanceEth, balanceWei } = await checkBalance();
  console.log(`[0G] Wallet ${address} balance: ${balanceEth} A0GI`);
  if (balanceWei === 0n) {
    throw new Error(
      `0G wallet has 0 A0GI. Fund this address on 0G mainnet (chain 16661): ${address}`
    );
  }

  // Write buffer to temp file
  const tmpPath = path.join(os.tmpdir(), `wz_upload_${Date.now()}_${filename}`);
  fs.writeFileSync(tmpPath, buffer);
  console.log(`[0G] Temp file written: ${tmpPath} (${buffer.length} bytes)`);

  try {
    const provider = new ethers.JsonRpcProvider(EVM_RPC);
    const signer   = new ethers.Wallet(PRIVATE_KEY, provider);

    const network = await provider.getNetwork();
    console.log(`[0G] Connected to chain ID: ${network.chainId} (expected 16661)`);

    // Build ZgFile and compute merkle root
    const zgFile = await ZgFile.fromFilePath(tmpPath);
    const [tree, treeErr] = await zgFile.merkleTree();
    if (treeErr) throw new Error("0G merkle tree error: " + treeErr);

    const rootHash = tree.rootHash();
    console.log(`[0G] Merkle rootHash: ${rootHash}`);
    console.log(`[0G] File: numSegments=${zgFile.numSegments()} numChunks=${zgFile.numChunks()}`);

    // Select storage nodes via indexer
    const indexer = new Indexer(INDEXER_RPC);
    const [clients, selectErr] = await indexer.selectNodes(1);
    if (selectErr) throw new Error("0G node selection failed: " + selectErr.message);
    console.log(`[0G] Selected ${clients.length} storage nodes`);

    // Get flow address from the first node's reported status
    const nodeStatus = await clients[0].getStatus();
    const flowAddr   = nodeStatus.networkIdentity.flowAddress;
    console.log(`[0G] Flow address (from node): ${flowAddr}`);

    // Create flow contract with the CORRECT on-chain ABI
    const correctFlow = new ethers.Contract(flowAddr, CORRECT_FLOW_ABI, signer);

    // Create custom uploader and run upload
    const EXPLICIT_FEE = BigInt("10000000000000000"); // 0.01 A0GI
    const uploader     = new ZeroGUploader(clients, EVM_RPC, correctFlow, signer);

    const uploadOpts = {
      tags:             "0x",
      finalityRequired: true,
      taskSize:         10,
      expectedReplica:  1,
      skipTx:           false,
      fee:              EXPLICIT_FEE,
    };

    let result, uploadErr;
    try {
      [result, uploadErr] = await uploader.uploadFile(zgFile, uploadOpts);
    } catch (sdkEx) {
      console.error("[0G] SDK exception:", sdkEx?.message || sdkEx);
      throw new Error("0G SDK exception: " + (sdkEx?.message || sdkEx));
    }

    if (uploadErr) {
      console.error("[0G] uploadErr:", uploadErr?.message || uploadErr);
      throw new Error("0G upload error: " + (uploadErr?.message || uploadErr));
    }

    console.log(`✅ [0G] Uploaded '${filename}' → rootHash: ${rootHash}`);
    console.log(`   txHash: ${result?.txHash}`);

    return rootHash;

  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

// ── downloadBuffer ────────────────────────────────────────────────────────
/**
 * Download a file from 0G Storage by rootHash. Result is cached in-memory.
 * @param {string} rootHash
 * @returns {Promise<Buffer>}
 */
async function downloadBuffer(rootHash) {
  if (downloadCache.has(rootHash)) {
    console.log(`[0G] Cache hit for rootHash: ${rootHash}`);
    return downloadCache.get(rootHash);
  }

  const tmpPath = path.join(os.tmpdir(), `wz_download_${rootHash.slice(0, 12)}.bin`);

  try {
    const indexer = new Indexer(INDEXER_RPC);
    const err = await indexer.download(rootHash, tmpPath, false);
    if (err) throw new Error("0G download error: " + err);

    const buf = fs.readFileSync(tmpPath);
    downloadCache.set(rootHash, buf);

    console.log(`✅ [0G] Downloaded rootHash: ${rootHash} (${buf.length} bytes)`);
    return buf;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

// ── invalidateCache ───────────────────────────────────────────────────────
function invalidateCache(rootHash) {
  downloadCache.delete(rootHash);
}

module.exports = { uploadBuffer, downloadBuffer, invalidateCache, checkBalance };
