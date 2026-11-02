// Check on devnet that the wallets from setup really have the money trail we expect.
// This checks Part 1 (it reads wallets.json to know what to look for). It is NOT
// the auditor: the auditor in auditor.js reads only the blockchain.
//
// Run with:  npm run verify

const { PublicKey } = require('@solana/web3.js');
const { getConnection, loadWallets, txLink, sleep } = require('./common');

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

const conn = getConnection();
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

// All SOL system transfers touching `addr`, from chain history.
async function transfers(addr) {
  const sigs = await conn.getSignaturesForAddress(new PublicKey(addr), { limit: 1000 });
  const out = [];
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    for (const ix of tx.transaction.message.instructions) {
      if (ix.program === 'system' && ix.parsed && ix.parsed.type === 'transfer') {
        const { source, destination, lamports } = ix.parsed.info;
        out.push({ sig: s.signature, source, destination, lamports, slot: s.slot });
      }
    }
    await sleep(50);
  }
  return out;
}

async function sellerReport(state, key) {
  const seller = state.sellers[key].address;
  const incoming = (await transfers(seller)).filter((t) => t.destination === seller && t.source !== state.bank);
  const payers = [...new Set(incoming.map((t) => t.source))];
  const fundedBySeller = [];
  for (const c of payers) {
    const inc = (await transfers(c)).filter((t) => t.destination === c).sort((a, b) => a.slot - b.slot);
    const funding = inc[0];
    if (funding && funding.source === seller) fundedBySeller.push({ customer: c, sig: funding.sig });
  }
  return { seller, incoming, payers, fundedBySeller };
}

async function main() {
  const state = loadWallets();
  if (!state || state.status !== 'ready') {
    console.log('No finished demo wallets. Run `npm run setup` (or `npm run reset`) first.');
    process.exit(1);
  }

  const gh = await conn.getGenesisHash();
  check(gh === DEVNET_GENESIS, `RPC is devnet (genesis ${gh})`);

  const A = await sellerReport(state, 'A');
  check(A.incoming.length === 4, `Seller A has ${A.incoming.length} incoming payments (want 4)`);
  check(A.payers.length === 4, `Seller A has ${A.payers.length} distinct paying customers (want 4)`);
  check(A.fundedBySeller.length === 0, `Seller A funded ${A.fundedBySeller.length} of its customers (want 0)`);

  const B = await sellerReport(state, 'B');
  check(B.incoming.length === 4, `Seller B has ${B.incoming.length} incoming payments (want 4)`);
  check(B.payers.length === 4, `Seller B has ${B.payers.length} distinct paying customers (want 4)`);
  check(B.fundedBySeller.length === 3, `Seller B directly funded ${B.fundedBySeller.length} of its customers (want 3)`);

  const sigs = [];
  for (const k of ['A', 'B']) for (const c of state.sellers[k].customers) sigs.push(c.fundingSig, c.paymentSig);
  const { value } = await conn.getSignatureStatuses(sigs, { searchTransactionHistory: true });
  const bad = value.filter((v) => !v || v.err || !['confirmed', 'finalized'].includes(v.confirmationStatus));
  check(sigs.every(Boolean) && bad.length === 0, `${sigs.length - bad.length}/${sigs.length} signatures in wallets.json exist and are confirmed`);

  const listed = state.sellers.B.customers.filter((c) => c.fundedBySeller).map((c) => c.fundingSig).sort();
  const found = B.fundedBySeller.map((f) => f.sig).sort();
  check(JSON.stringify(listed) === JSON.stringify(found), 'Seller B funding sigs found on chain match wallets.json');

  console.log('\nSeller B funding transactions (from chain):');
  B.fundedBySeller.forEach((f) => console.log(`  ${txLink(f.sig)}`));
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('verify error:', e.message.replace(/api-key=[^&\s]*/g, 'api-key=<redacted>'));
  process.exit(2);
});
