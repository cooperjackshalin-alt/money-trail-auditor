// Part 2: the auditor.
//
// Input: one seller address. Output: PASS or BLOCK, the reason, and the
// transactions behind it. It reads ONLY the blockchain (through the RPC). It never
// reads wallets.json, bank.json or any other local file, so it knows nothing about
// how the demo was built.
//
// How it decides:
//   1. Look at the seller's latest transactions. Every wallet that sent it SOL is a
//      customer. If the seller sent SOL to itself, that is self-payment.
//   2. For each customer, find where it got its first SOL (its oldest incoming
//      transfer). That wallet is the customer's funder.
//   3. If the funder is the seller itself, that customer is flagged.
//   4. BLOCK if enough customers are flagged (see the rule below) or on any
//      self-payment. Otherwise PASS.
//   5. Fail closed: if anything can't be read, the verdict is BLOCK. Never PASS by default.

const { PublicKey } = require('@solana/web3.js');
const { getConnection } = require('./common');

// ---------- the rule ----------

// BLOCK when this many customers (or more) got their first SOL from the seller's
// own wallet. 1 means "any". Self-payment always blocks.
const BLOCK_AT_SELLER_FUNDED_CUSTOMERS = 1;

// ---------- limits ----------

const SELLER_HISTORY = 25; // latest seller transactions to look at
const CUSTOMER_PAGES = 3; // pages of 1000 signatures to walk back to a customer's oldest one
const OLDEST_TO_CHECK = 5; // oldest customer transactions to search for its first incoming SOL
const PARALLEL_CUSTOMERS = 5; // customers looked up at once (stays under RPC rate limits)
const AUDIT_TIMEOUT_MS = 8000; // no answer by then means BLOCK

const COULD_NOT_VERIFY = "Blocked: couldn't verify this seller.";

let connection;

async function audit(sellerAddress) {
  connection = connection || getConnection();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer from the RPC within ${AUDIT_TIMEOUT_MS / 1000}s`)), AUDIT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([runAudit(connection, sellerAddress), timeout]);
  } catch (err) {
    return couldNotVerify(sellerAddress, err.message);
  } finally {
    clearTimeout(timer);
  }
}

async function runAudit(conn, sellerAddress) {
  let seller;
  try {
    seller = new PublicKey(String(sellerAddress).trim());
  } catch {
    return couldNotVerify(sellerAddress, 'not a valid Solana address');
  }
  const sellerStr = seller.toBase58();

  // 1. Who sent the seller SOL?
  const sigInfos = (await conn.getSignaturesForAddress(seller, { limit: SELLER_HISTORY })).filter((s) => !s.err);
  if (sigInfos.length === 0) return couldNotVerify(sellerStr, 'no transaction history');
  const txs = await conn.getParsedTransactions(
    sigInfos.map((s) => s.signature),
    { maxSupportedTransactionVersion: 0 }
  );
  if (txs.some((tx) => !tx)) return couldNotVerify(sellerStr, 'some seller transactions could not be read');

  const customerAddrs = [];
  const selfPaymentSigs = [];
  txs.forEach((tx, i) => {
    for (const t of solTransfers(tx)) {
      if (t.to !== sellerStr) continue;
      if (t.from === sellerStr) selfPaymentSigs.push(sigInfos[i].signature);
      else if (!customerAddrs.includes(t.from)) customerAddrs.push(t.from);
    }
  });
  if (customerAddrs.length === 0 && selfPaymentSigs.length === 0) {
    return couldNotVerify(sellerStr, 'no wallet has sent this seller SOL');
  }

  // 2 and 3. Where did each customer get its first SOL?
  const customers = await mapLimit(customerAddrs, PARALLEL_CUSTOMERS, async (address) => {
    const { funder, fundingSig } = await firstFunding(conn, address);
    return { address, funder, fundingSig, fundedBySeller: funder === sellerStr };
  });

  // 4. Verdict.
  const flagged = customers.filter((c) => c.fundedBySeller);
  const flaggedSigs = [...flagged.map((c) => c.fundingSig), ...selfPaymentSigs];
  const total = customers.length;
  const tooMany = flagged.length >= BLOCK_AT_SELLER_FUNDED_CUSTOMERS;

  const problems = [];
  if (tooMany) {
    problems.push(`${flagged.length} of this seller's customers got their first funds from the seller's own wallet`);
  }
  if (selfPaymentSigs.length) problems.push('the seller sent money to itself');

  if (problems.length) {
    return { verdict: 'BLOCK', reason: `Blocked: ${problems.join(', and ')}.`, seller: sellerStr, customers, flaggedSigs };
  }
  const reason = flagged.length === 0
    ? `Passed: none of this seller's ${total} customers got their first funds from the seller's own wallet.`
    : `Passed: ${flagged.length} of this seller's ${total} customers got their first funds from the seller, below the limit of ${BLOCK_AT_SELLER_FUNDED_CUSTOMERS}.`;
  return { verdict: 'PASS', reason, seller: sellerStr, customers, flaggedSigs };
}

// The customer's oldest incoming SOL transfer: who sent it, and in which transaction.
async function firstFunding(conn, address) {
  const pk = new PublicKey(address);

  // Walk back to the start of the customer's history.
  let oldestPage = [];
  let before;
  let reachedStart = false;
  for (let i = 0; i < CUSTOMER_PAGES; i++) {
    const page = await conn.getSignaturesForAddress(pk, { limit: 1000, before });
    if (page.length) oldestPage = page;
    if (page.length < 1000) {
      reachedStart = true;
      break;
    }
    before = page[page.length - 1].signature;
  }
  if (!reachedStart) throw new Error(`history of customer ${address} is too long to reach its first transaction`);

  const oldest = oldestPage.filter((s) => !s.err).reverse().slice(0, OLDEST_TO_CHECK);
  const txs = await conn.getParsedTransactions(
    oldest.map((s) => s.signature),
    { maxSupportedTransactionVersion: 0 }
  );
  for (let i = 0; i < oldest.length; i++) {
    if (!txs[i]) throw new Error(`could not read a transaction of customer ${address}`);
    const incoming = solTransfers(txs[i]).find((t) => t.to === address && t.from !== address);
    if (incoming) return { funder: incoming.from, fundingSig: oldest[i].signature };
  }
  throw new Error(`could not find where customer ${address} got its first SOL`);
}

// Every SOL movement made by the System Program in a successful transaction,
// including ones made inside other programs' instructions.
function solTransfers(tx) {
  if (!tx || !tx.meta || tx.meta.err) return [];
  const instructions = [
    ...tx.transaction.message.instructions,
    ...(tx.meta.innerInstructions || []).flatMap((inner) => inner.instructions),
  ];
  const out = [];
  for (const ix of instructions) {
    if (ix.program !== 'system' || !ix.parsed) continue;
    const { type, info } = ix.parsed;
    if (type === 'transfer' || type === 'transferWithSeed') {
      out.push({ from: info.source, to: info.destination, lamports: info.lamports });
    } else if (type === 'createAccount' || type === 'createAccountWithSeed') {
      out.push({ from: info.source, to: info.newAccount, lamports: info.lamports });
    }
  }
  return out.filter((t) => t.lamports > 0);
}

function couldNotVerify(seller, detail) {
  return {
    verdict: 'BLOCK',
    reason: COULD_NOT_VERIFY,
    seller: String(seller),
    customers: [],
    flaggedSigs: [],
    detail: String(detail).replace(/api-key=[^&\s"]*/g, 'api-key=<redacted>'),
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

module.exports = { audit, BLOCK_AT_SELLER_FUNDED_CUSTOMERS };
