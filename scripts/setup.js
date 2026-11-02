// Part 1: create and fund the demo wallets on Solana devnet.
//
// The money flows it creates:
//   bank   → agent                        (the payer for the demo)
//   bank   → funder 1-4 → customer A1-A4  (clean: customers funded by unrelated wallets)
//   bank   → seller B   → customer B1-B3  (dirty: seller funds its own "customers")
//   bank   → funder 5   → customer B4     (one normal-looking customer to make B less obvious)
//   every customer pays its seller once
//
// Run with:  npm run setup      (does nothing if wallets already exist)
//            npm run reset      (sweeps old wallets back to the bank and rebuilds)

const {
  getConnection,
  sol,
  fmt,
  kpToJson,
  kpFromJson,
  loadOrCreateBank,
  loadWallets,
  saveWallets,
  transfer,
  shortErr,
  sleep,
  printSummary,
  addrLink,
  Keypair,
  LAMPORTS_PER_SOL,
} = require('./common');

const AMOUNTS = {
  agent: sol(0.3), // what the agent will spend paying sellers in Part 3
  sellerB: sol(0.08), // enough for seller B to fund 3 customers plus fees
  funder: sol(0.03),
  customer: sol(0.02),
  payment: sol(0.01), // each customer's one payment to its seller
};
const MIN_BANK = sol(0.6); // total needed for one full build, with headroom

async function ensureBankFunded(connection, bank) {
  let balance = await connection.getBalance(bank.publicKey);
  console.log(`Bank wallet ${bank.publicKey.toBase58()} has ${fmt(balance)}`);
  if (balance >= MIN_BANK) return;

  console.log('Bank is low. Trying a devnet airdrop of 1 SOL...');
  try {
    const sig = await connection.requestAirdrop(bank.publicKey, LAMPORTS_PER_SOL);
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
    await sleep(1000);
    balance = await connection.getBalance(bank.publicKey);
    console.log(`Airdrop worked. Bank now has ${fmt(balance)}`);
  } catch (err) {
    console.log(`Airdrop failed: ${shortErr(err)}`);
  }

  if (balance < MIN_BANK) {
    console.log(`
The bank needs at least ${fmt(MIN_BANK)}. Fund it by hand, then run this again:
  1. Go to https://faucet.solana.com
  2. Paste this address: ${bank.publicKey.toBase58()}
  3. Choose Devnet, request 1 SOL (signing in with GitHub raises the limit)
  Bank on the explorer: ${addrLink(bank.publicKey.toBase58())}
`);
    process.exit(1);
  }
}

async function build() {
  const connection = getConnection();
  const bank = loadOrCreateBank();
  await ensureBankFunded(connection, bank);

  // Generate every wallet up front and save them BEFORE sending anything,
  // so a crash halfway through can still be swept back by `npm run reset`.
  const agent = Keypair.generate();
  const sellerA = Keypair.generate();
  const sellerB = Keypair.generate();
  const funders = Array.from({ length: 5 }, () => Keypair.generate());
  const custA = Array.from({ length: 4 }, () => Keypair.generate());
  const custB = Array.from({ length: 4 }, () => Keypair.generate());

  const state = {
    status: 'building',
    createdAt: new Date().toISOString(),
    bank: bank.publicKey.toBase58(),
    agent: kpToJson(agent),
    funders: funders.map(kpToJson),
    sellers: {
      A: { label: 'clean', ...kpToJson(sellerA), customers: custA.map(kpToJson) },
      B: { label: 'dirty', ...kpToJson(sellerB), customers: custB.map(kpToJson) },
    },
  };
  saveWallets(state);

  const A = state.sellers.A.customers;
  const B = state.sellers.B.customers;

  console.log('\n1/5  Funding the agent and seller B from the bank');
  await transfer(connection, bank, agent.publicKey, AMOUNTS.agent, 'bank → agent');
  await transfer(connection, bank, sellerB.publicKey, AMOUNTS.sellerB, 'bank → seller B');

  console.log('\n2/5  Funding 5 unrelated "funder" wallets from the bank');
  for (let i = 0; i < funders.length; i++) {
    await transfer(connection, bank, funders[i].publicKey, AMOUNTS.funder, `bank → funder ${i + 1}`);
  }
  saveWallets(state);

  console.log("\n3/5  Funding seller A's customers from unrelated funders (clean)");
  for (let i = 0; i < 4; i++) {
    A[i].fundedBy = `funder ${i + 1} (${funders[i].publicKey.toBase58()})`;
    A[i].fundedBySeller = false;
    A[i].fundingSig = await transfer(connection, funders[i], custA[i].publicKey, AMOUNTS.customer, `funder ${i + 1} → customer A${i + 1}`);
    saveWallets(state);
  }

  console.log("\n4/5  Funding seller B's customers (3 from seller B itself = dirty)");
  for (let i = 0; i < 3; i++) {
    B[i].fundedBy = `SELLER B (${sellerB.publicKey.toBase58()})`;
    B[i].fundedBySeller = true;
    B[i].fundingSig = await transfer(connection, sellerB, custB[i].publicKey, AMOUNTS.customer, `seller B → customer B${i + 1}`);
    saveWallets(state);
  }
  B[3].fundedBy = `funder 5 (${funders[4].publicKey.toBase58()})`;
  B[3].fundedBySeller = false;
  B[3].fundingSig = await transfer(connection, funders[4], custB[3].publicKey, AMOUNTS.customer, 'funder 5 → customer B4');
  saveWallets(state);

  console.log('\n5/5  Every customer pays its seller once');
  for (let i = 0; i < 4; i++) {
    A[i].paymentSig = await transfer(connection, custA[i], sellerA.publicKey, AMOUNTS.payment, `customer A${i + 1} → seller A`);
    saveWallets(state);
  }
  for (let i = 0; i < 4; i++) {
    B[i].paymentSig = await transfer(connection, custB[i], sellerB.publicKey, AMOUNTS.payment, `customer B${i + 1} → seller B`);
    saveWallets(state);
  }

  state.status = 'ready';
  saveWallets(state);
  printSummary(state);
  console.log('Done. Wallets and keys saved to wallets.json (gitignored).');
}

async function main() {
  const existing = loadWallets();
  if (existing && existing.status === 'ready') {
    console.log('Demo wallets already exist. Showing them. Run `npm run reset` to rebuild from scratch.');
    printSummary(existing);
    return;
  }
  if (existing) {
    console.log('A previous setup did not finish. Run `npm run reset` to sweep it and start over.');
    process.exit(1);
  }
  await build();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\nSetup failed:', shortErr(err));
    console.error('Progress is saved in wallets.json. Run `npm run reset` to sweep and try again.');
    process.exit(1);
  });
}

module.exports = { build };
