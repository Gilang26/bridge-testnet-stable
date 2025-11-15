/**
 * AUTO-SCAN SIMPLE WORKER (for LayerZero Testnet)
 * by mas ❤
 *
 * Features:
 *  - Scan all LayerZero messages by wallet owner address
 *  - Detect pending executor messages (Executor = WAITING)
 *  - Fetch sender32 + payload automatically
 *  - Execute lzReceive() with your worker private key
 */

const fetch = require("node-fetch");
const { ethers } = require("ethers");
require("dotenv").config();

const LOG = (...a) => console.log(new Date().toISOString(), ...a);

/* ========= ENV CONFIG ========= */

const OWNER = process.env.OWNER;  // wallet mas sing kirim bridge
const EXECUTOR_PK = process.env.EXECUTOR_PRIVATE_KEY;
const EXECUTOR = process.env.EXECUTOR_ADDRESS; // executor contract address
const RPC = process.env.RPC_SEPOLIA;
const DST_EID = parseInt(process.env.DST_EID || "40374", 10);
const INTERVAL = parseInt(process.env.POLL_INTERVAL || "60000", 10);

if (!OWNER) { console.log("ERROR: OWNER (wallet mas) is missing in .env"); process.exit(1); }
if (!EXECUTOR_PK) { console.log("ERROR: EXECUTOR_PRIVATE_KEY missing"); process.exit(1); }
if (!RPC) { console.log("ERROR: RPC_SEPOLIA missing"); process.exit(1); }

const provider = new ethers.providers.JsonRpcProvider(RPC);
const signer = new ethers.Wallet(EXECUTOR_PK, provider);

const EXECUTOR_ABI = [
  "function lzReceive(uint32,bytes32,bytes,address) external"
];
const executorContract = new ethers.Contract(EXECUTOR, EXECUTOR_ABI, signer);

/* ========= Helper extract HEX ========= */
function extractHexes(text){
  const all = text.match(/0x[0-9a-fA-F]{64,}/g) || [];
  const unique = [...new Set(all)];

  const sender32 = unique.find(h => h.length === 66) || null;
  const payload = unique.find(h => h.length > 66 && h.length % 2 === 0) || null;

  return { sender32, payload };
}

/* ========= Fetch LayerZero messages by OWNER ========= */
async function loadMessages() {
  const url = `https://api.testnet.layerzeroscan.com/messages?address=${OWNER}&page=1&limit=20`;
  LOG("Fetching messages:", url);

  try {
    const r = await fetch(url);
    const json = await r.json();

    if (!json || !json.messages) return [];

    return json.messages;
  } catch (err) {
    LOG("API error:", err.message);
    return [];
  }
}

/* ========= Fetch tx page to extract payload ========= */
async function fetchPayload(txHash) {
  const url = `https://testnet.layerzeroscan.com/tx/${txHash}`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "simple-worker-auto" } });
    const html = await r.text();

    const { sender32, payload } = extractHexes(html);
    return { sender32, payload };
  } catch (e) {
    LOG("fetchPayload error:", e.message);
    return null;
  }
}

/* ========= Execute pending messages ========= */
async function executeMessage(msg) {
  const txHash = msg.srcTxHash;
  LOG("=== EXECUTING message from tx:", txHash);

  const data = await fetchPayload(txHash);
  if (!data || !data.sender32 || !data.payload) {
    LOG("❌ Cannot extract payload/sender for", txHash);
    return;
  }

  LOG(" sender32:", data.sender32);
  LOG(" payload length:", (data.payload.length - 2) / 2, "bytes");

  try {
    const gas = { gasLimit: 1000000 };
    const tx = await executorContract.lzReceive(
      DST_EID,
      data.sender32,
      data.payload,
      EXECUTOR,
      gas
    );
    LOG("⏳ lzReceive sent:", tx.hash);

    const rc = await tx.wait();
    LOG("✅ EXECUTED at block", rc.blockNumber);
  } catch (err) {
    LOG("❌ Execution error:", err.message);
  }
}

/* ========= Main Loop ========= */
async function loop() {
  LOG("Worker autoscan started for owner:", OWNER);

  while (true) {
    const messages = await loadMessages();

    if (messages.length === 0) {
      LOG("No messages found");
    } else {
      LOG("Found", messages.length, "messages.");
    }

    for (const msg of messages) {
      if (!msg.executorResult || msg.executorResult.status !== "WAITING") continue;

      LOG("🔵 Pending executor message found:", msg.srcTxHash);
      await executeMessage(msg);
    }

    LOG("Sleep", INTERVAL, "ms...");
    await new Promise(res => setTimeout(res, INTERVAL));
  }
}

loop().catch(err => {
  LOG("Fatal error:", err.message);
  process.exit(1);
});
