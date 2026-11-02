// Print the current demo wallets and explorer links without touching the network.
// Run with:  npm run show

const { loadWallets, printSummary } = require('./common');

const state = loadWallets();
if (!state) {
  console.log('No demo wallets yet. Run `npm run setup` first.');
  process.exit(1);
}
if (state.status !== 'ready') console.log('Warning: the last setup did not finish. Run `npm run reset`.');
printSummary(state);
