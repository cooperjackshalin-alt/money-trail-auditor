// Part 3: pay or block.
//
// pay(sellerAddress) runs the auditor first, every time (no caching). Only a PASS
// sends money: one fixed payment from the agent wallet to the seller. A BLOCK, or
// any safety limit below, means nothing is sent.
//
// The agent's key comes from wallets.json: it is the payer's own wallet, not an
// input to the verdict. The verdict comes only from audit() in auditor.js, which
// reads only the blockchain.
//
// Run with:  npm run pay -- A        (or B, or any seller address)

const { audit } = require('./auditor');
const {
  BASE_FEE_LAMPORTS,
  getConnection,
  sol,
  fmt,
  addrLink,
  txLink,
  kpFromJson,
  loadWallets,
  transfer,
  shortErr,
  pickSellerAddress,
} = require('./common');

// ---------- safety limits ----------

const PAYMENT_LAMPORTS = sol(0.01); // what the agent pays a seller that passes
const MAX_PAYMENT_LAMPORTS = sol(0.05); // refuse to send more than this in one payment
const MIN_AGENT_BALANCE_LAMPORTS = sol(0.05); // refuse if paying would leave the agent below this

let connection;

async function pay(sellerAddress) {
  const auditResult = await audit(sellerAddress);
  const notPaid = (reason) => ({ paid: false, reason, audit: auditResult });
  if (auditResult.verdict !== 'PASS') return notPaid(auditResult.reason);

  // Safety limits. Nothing has been sent yet, so any failure here sends nothing.
  let agent;
  try {
    if (!Number.isInteger(PAYMENT_LAMPORTS) || PAYMENT_LAMPORTS <= 0) {
      return notPaid('Not paid: the payment amount is not valid. Nothing was sent.');
    }
    if (PAYMENT_LAMPORTS > MAX_PAYMENT_LAMPORTS) {
      return notPaid(`Not paid: ${fmt(PAYMENT_LAMPORTS)} is above the ${fmt(MAX_PAYMENT_LAMPORTS)} limit per payment. Nothing was sent.`);
    }
    const state = loadWallets();
    if (!state || state.status !== 'ready' || !state.agent) {
      return notPaid("Not paid: the agent wallet isn't set up. Run `npm run reset`. Nothing was sent.");
    }
    agent = kpFromJson(state.agent);
    if (agent.publicKey.toBase58() === auditResult.seller) {
      return notPaid("Not paid: the agent can't pay itself. Nothing was sent.");
    }
    connection = connection || getConnection();
    const balance = await connection.getBalance(agent.publicKey);
    if (balance - PAYMENT_LAMPORTS - BASE_FEE_LAMPORTS < MIN_AGENT_BALANCE_LAMPORTS) {
      return notPaid(`Not paid: the agent has ${fmt(balance)}, and paying would leave it below the ${fmt(MIN_AGENT_BALANCE_LAMPORTS)} floor. Nothing was sent.`);
    }
  } catch (err) {
    return notPaid(`Not paid: ${redact(shortErr(err))}. Nothing was sent.`);
  }

  // Send. transfer() never sends twice; see common.js.
  try {
    const signature = await transfer(connection, agent, auditResult.seller, PAYMENT_LAMPORTS);
    return { paid: true, signature, explorerUrl: txLink(signature), lamports: PAYMENT_LAMPORTS, audit: auditResult };
  } catch (err) {
    if (err.mayHaveLanded) {
      return notPaid(`Payment didn't confirm in time and may still land. Don't pay again until you've checked: ${txLink(err.signature)}`);
    }
    if (err.mayHaveLanded === false) {
      return notPaid('Not paid: the network never confirmed the payment, and it can no longer land. Nothing was sent.');
    }
    return notPaid(`Payment failed and nothing was sent: ${redact(shortErr(err))}`);
  }
}

const redact = (msg) => String(msg).replace(/api-key=[^&\s"]*/g, 'api-key=<redacted>');

// ---------- command line ----------

async function main() {
  const address = pickSellerAddress(process.argv[2], 'npm run pay -- <seller address>   (or A / B for the demo sellers)');
  const state = loadWallets();
  const agentPk = state && state.agent ? kpFromJson(state.agent).publicKey : null;
  const conn = getConnection();
  const before = agentPk ? await conn.getBalance(agentPk) : null;

  console.log(`\nAgent wants to pay ${fmt(PAYMENT_LAMPORTS)} to seller ${address}\n  ${addrLink(address)}\n`);
  const result = await pay(address);

  const a = result.audit;
  console.log(`Audit: ${a.verdict === 'PASS' ? '✅ PASS' : '⛔ BLOCK'}`);
  console.log(`  ${a.reason}`);
  if (a.detail) console.log(`  (why: ${a.detail})`);
  a.flaggedSigs.forEach((sig, i) => console.log(`  ${i + 1}. ${txLink(sig)}`));

  if (result.paid) {
    console.log(`\n💸 PAID ${fmt(result.lamports)} to the seller.`);
    console.log(`  ${result.explorerUrl}`);
  } else {
    console.log('\n🛑 NOT PAID');
    console.log(`  ${result.reason === a.reason ? 'The auditor blocked it. Nothing was sent.' : result.reason}`);
  }

  if (agentPk) {
    const after = await conn.getBalance(agentPk);
    const exact = (l) => `${fmt(l)} (${l.toLocaleString('en-US')} lamports)`;
    console.log(`\nAgent balance: ${exact(before)} before → ${exact(after)} after\n`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\nPay failed:', redact(shortErr(err)));
    process.exit(1);
  });
}

module.exports = { pay, PAYMENT_LAMPORTS, MAX_PAYMENT_LAMPORTS, MIN_AGENT_BALANCE_LAMPORTS };
