// Shared helpers for setup, reset and show.
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} = require('@solana/web3.js');
const bs58 = require('bs58');

const ROOT = path.join(__dirname, '..');
const WALLETS_FILE = path.join(ROOT, 'wallets.json');
// The bank wallet holds the devnet SOL that funds everything. It survives resets,
// so you only have to use the faucet once.
const BANK_FILE = path.join(ROOT, 'bank.json');

const BASE_FEE_LAMPORTS = 5000; // fee for a one-signature transaction

// ---------- connection ----------

function getConnection() {
  const url = process.env.RPC_URL;
  if (!url) {
    console.error('Missing RPC_URL. Copy .env.example to .env and paste your devnet RPC URL.');
    process.exit(1);
  }
  if (/mainnet/i.test(url)) {
    console.error('RPC_URL looks like a MAINNET URL. This demo only runs on devnet.');
    process.exit(1);
  }
  return new Connection(url, 'confirmed');
}

// ---------- amounts ----------

const sol = (n) => Math.round(n * LAMPORTS_PER_SOL);
const fmt = (lamports) => (lamports / LAMPORTS_PER_SOL).toFixed(4) + ' SOL';

// ---------- explorer links ----------

const addrLink = (address) => `https://explorer.solana.com/address/${address}?cluster=devnet`;
const txLink = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

// ---------- keypairs ----------

const kpToJson = (kp) => ({ address: kp.publicKey.toBase58(), secretKey: Array.from(kp.secretKey) });
const kpFromJson = (obj) => Keypair.fromSecretKey(Uint8Array.from(obj.secretKey));

function loadOrCreateBank() {
  if (fs.existsSync(BANK_FILE)) {
    return kpFromJson(JSON.parse(fs.readFileSync(BANK_FILE, 'utf8')));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(BANK_FILE, JSON.stringify(kpToJson(kp), null, 2));
  console.log(`Created a new bank wallet: ${kp.publicKey.toBase58()}`);
  return kp;
}

function loadWallets() {
  if (!fs.existsSync(WALLETS_FILE)) return null;
  return JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
}

function saveWallets(state) {
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(state, null, 2));
}

// ---------- sending ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Plain SOL transfer, confirmed before returning. Devnet RPCs drop or rate-limit
// requests now and then, so this retries, but it can never pay twice:
//   - each transaction is signed once and its signature is kept
//   - before any retry we ask the chain whether that signature already landed
//   - while its blockhash is valid we only resend the SAME signed bytes
//     (the network drops duplicates of a signature it has already processed)
//   - a new transaction is built only after the old blockhash has expired
//     and the old signature is confirmed to have not landed
const SEND_TIMEOUT_MS = 3 * 60 * 1000; // give up (without resending) after this

async function transfer(connection, fromKp, toPubkey, lamports, label) {
  const to = typeof toPubkey === 'string' ? new PublicKey(toPubkey) : toPubkey;
  const name = label || 'transfer';
  const deadline = Date.now() + SEND_TIMEOUT_MS;
  let lastSig;

  for (let build = 1; build <= 3; build++) {
    const { blockhash, lastValidBlockHeight } = await rpcRetry(() => connection.getLatestBlockhash('confirmed'));
    const tx = new Transaction({ feePayer: fromKp.publicKey, blockhash, lastValidBlockHeight }).add(
      SystemProgram.transfer({ fromPubkey: fromKp.publicKey, toPubkey: to, lamports })
    );
    tx.sign(fromKp);
    const raw = tx.serialize();
    const sig = bs58.encode(tx.signature);
    lastSig = sig;

    for (let tick = 0; Date.now() < deadline; tick++) {
      // (Re)send the same signed bytes every few checks. A send error is not
      // final: the transaction may still land, so we fall through to the status check.
      if (tick % 3 === 0) {
        try {
          await connection.sendRawTransaction(raw, { maxRetries: 0 });
        } catch (err) {
          if (tick === 0) console.log(`  … ${name}: send error, checking if it landed: ${shortErr(err)}`);
        }
      }
      await sleep(2000);

      const status = await signatureStatus(connection, sig);
      if (status === 'landed') {
        if (label) console.log(`  ✓ ${label} (${fmt(lamports)})`);
        return sig;
      }
      if (status && status.failed) {
        throw new Error(`${name} failed onchain (${sig}): ${JSON.stringify(status.failed)}`);
      }

      if (await blockhashExpired(connection, lastValidBlockHeight)) {
        // Last look: expired means it can no longer land, but it may have landed just before.
        if ((await signatureStatus(connection, sig)) === 'landed') {
          if (label) console.log(`  ✓ ${label} (${fmt(lamports)})`);
          return sig;
        }
        console.log(`  … ${name}: blockhash expired without landing, building a new transaction (${build}/3)`);
        break;
      }
    }
    if (Date.now() >= deadline) break;
  }
  const err = new Error(`${name} did not confirm. Nothing was resent after it might have landed; run reset to sweep.`);
  // Hitting the deadline means the last transaction's fate is unknown: it may still land.
  // Otherwise every attempt's blockhash expired without landing, so nothing was sent.
  err.mayHaveLanded = Date.now() >= deadline;
  err.signature = lastSig;
  throw err;
}

// 'landed' (confirmed or finalized, no error), { failed: err }, or null (unknown / not seen yet).
async function signatureStatus(connection, sig) {
  try {
    const { value } = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const s = value[0];
    if (!s) return null;
    if (s.err) return { failed: s.err };
    if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return 'landed';
    return null;
  } catch {
    return null; // RPC hiccup: treat as unknown and check again
  }
}

// True only when we positively know the blockhash can no longer be used.
// If the RPC call fails we say "not expired", so we never rebuild by mistake.
async function blockhashExpired(connection, lastValidBlockHeight) {
  try {
    return (await connection.getBlockHeight('confirmed')) > lastValidBlockHeight;
  } catch {
    return false;
  }
}

async function rpcRetry(fn) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await sleep(1000 * attempt);
    }
  }
  throw lastErr;
}

// For command-line scripts: turn "A" or "B" into that demo seller's address
// (looked up in wallets.json); anything else is taken as an address.
function pickSellerAddress(arg, usage) {
  if (!arg) {
    console.log(`Usage: ${usage}`);
    process.exit(1);
  }
  const key = arg.toUpperCase();
  if (key !== 'A' && key !== 'B') return arg;
  const state = loadWallets();
  if (!state || !state.sellers) {
    console.log('No demo wallets yet, so A/B mean nothing. Run `npm run setup` or pass an address.');
    process.exit(1);
  }
  return state.sellers[key].address;
}

function shortErr(err) {
  const msg = (err && err.message) || String(err);
  return msg.split('\n')[0].slice(0, 160);
}

// ---------- printing ----------

function printSummary(state) {
  const line = '─'.repeat(70);
  console.log('\n' + line);
  console.log('DEMO WALLETS (Solana devnet)');
  console.log(line);

  console.log(`\nAgent (the payer)\n  ${state.agent.address}\n  ${addrLink(state.agent.address)}`);

  for (const key of ['A', 'B']) {
    const s = state.sellers[key];
    console.log(`\nSeller ${key} (${s.label})\n  ${s.address}\n  ${addrLink(s.address)}`);
    s.customers.forEach((c, i) => {
      const flag = c.fundedBySeller ? '  ⚠ FUNDED BY THIS SELLER' : '';
      console.log(`\n  Customer ${i + 1}${flag}`);
      console.log(`    wallet:      ${addrLink(c.address)}`);
      console.log(`    funded by:   ${c.fundedBy}`);
      if (c.fundingSig) console.log(`    funding tx:  ${txLink(c.fundingSig)}`);
      if (c.paymentSig) console.log(`    paid seller: ${txLink(c.paymentSig)}`);
    });
  }

  const dirty = state.sellers.B.customers.filter((c) => c.fundedBySeller && c.fundingSig);
  console.log('\n' + line);
  console.log("SELLER B'S FUNDING TRANSACTIONS (what the auditor should catch)");
  console.log(line);
  dirty.forEach((c, i) => console.log(`  ${i + 1}. ${txLink(c.fundingSig)}`));
  console.log('');
}

module.exports = {
  WALLETS_FILE,
  BANK_FILE,
  BASE_FEE_LAMPORTS,
  getConnection,
  sol,
  fmt,
  addrLink,
  txLink,
  kpToJson,
  kpFromJson,
  loadOrCreateBank,
  loadWallets,
  saveWallets,
  transfer,
  shortErr,
  sleep,
  printSummary,
  pickSellerAddress,
  Keypair,
  LAMPORTS_PER_SOL,
};
