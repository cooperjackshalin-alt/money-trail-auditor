// Sweep every old demo wallet back to the bank, delete wallets.json, and rebuild.
// The bank wallet is kept, so you don't need the faucet again.
//
// Run with:  npm run reset

const fs = require('fs');
const {
  WALLETS_FILE,
  BASE_FEE_LAMPORTS,
  getConnection,
  kpFromJson,
  loadOrCreateBank,
  loadWallets,
  transfer,
  shortErr,
  fmt,
} = require('./common');
const { build } = require('./setup');

function allKeypairs(state) {
  const list = [];
  if (state.agent) list.push(['agent', state.agent]);
  (state.funders || []).forEach((f, i) => list.push([`funder ${i + 1}`, f]));
  for (const key of ['A', 'B']) {
    const s = state.sellers && state.sellers[key];
    if (!s) continue;
    list.push([`seller ${key}`, s]);
    (s.customers || []).forEach((c, i) => list.push([`customer ${key}${i + 1}`, c]));
  }
  return list;
}

async function sweep(connection, bank, state) {
  console.log('Sweeping old demo wallets back to the bank...');
  let recovered = 0;
  for (const [name, obj] of allKeypairs(state)) {
    try {
      const kp = kpFromJson(obj);
      const balance = await connection.getBalance(kp.publicKey);
      const amount = balance - BASE_FEE_LAMPORTS; // send everything, leaving exactly 0
      if (amount <= 0) continue;
      await transfer(connection, kp, bank.publicKey, amount, `${name} → bank`);
      recovered += amount;
    } catch (err) {
      console.log(`  skipped ${name}: ${shortErr(err)}`);
    }
  }
  console.log(`Recovered ${fmt(recovered)}.\n`);
}

async function main() {
  const connection = getConnection();
  const bank = loadOrCreateBank();
  const old = loadWallets();
  if (old) {
    await sweep(connection, bank, old);
    fs.unlinkSync(WALLETS_FILE);
  }
  await build();
}

main().catch((err) => {
  console.error('\nReset failed:', shortErr(err));
  console.error('Run `npm run reset` again. Progress is saved in wallets.json.');
  process.exit(1);
});
