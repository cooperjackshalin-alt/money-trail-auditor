// Run the auditor on one seller and print the result in plain English.
//
//   npm run audit -- <seller address>
//   npm run audit -- A        (or B)
//
// "A" and "B" are a typing shortcut only: they look up that demo seller's ADDRESS
// in wallets.json. The verdict comes from audit() in auditor.js, which is given
// just the address and reads only the blockchain.

const { audit } = require('./auditor');
const { pickSellerAddress, addrLink, txLink } = require('./common');

async function main() {
  const address = pickSellerAddress(process.argv[2], 'npm run audit -- <seller address>   (or A / B for the demo sellers)');
  console.log(`\nAuditing seller ${address}\n  ${addrLink(address)}\n`);

  const started = Date.now();
  const result = await audit(address);
  const seconds = ((Date.now() - started) / 1000).toFixed(2);

  console.log(`${result.verdict === 'PASS' ? '✅ PASS' : '⛔ BLOCK'}`);
  console.log(result.reason);
  if (result.detail) console.log(`  (why: ${result.detail})`);

  if (result.customers.length) {
    console.log(`\nCustomers (${result.customers.length}), and where each got its first SOL:`);
    result.customers.forEach((c, i) => {
      const from = c.fundedBySeller ? '⚠ THE SELLER ITSELF' : c.funder;
      console.log(`  ${i + 1}. ${c.address}`);
      console.log(`     first funds from: ${from}`);
      console.log(`     ${txLink(c.fundingSig)}`);
    });
  }

  if (result.flaggedSigs.length) {
    console.log('\nTransactions behind this verdict:');
    result.flaggedSigs.forEach((sig, i) => console.log(`  ${i + 1}. ${txLink(sig)}`));
  }

  console.log(`\nChecked in ${seconds}s, reading only the blockchain.\n`);
}

main();
