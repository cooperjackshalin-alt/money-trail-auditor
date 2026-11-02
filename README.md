# Money Trail Auditor

An auditor that checks a seller's onchain money trail before an AI agent pays it. If the seller's "customers" were funded by the seller itself, the payment gets blocked.

Solana **devnet** only. Test money, no real funds.

## Build status

| Part | What it does | Status |
|---|---|---|
| 1. Setup | Create and fund the demo wallets on devnet | ✅ this repo |
| 2. Auditor check | Seller address in → verdict + the transactions that caused it | ✅ this repo |
| 3. Pay or block | Send a fixed payment if clean, return an explorer link | ✅ this repo |
| 4. One page | Two seller cards, a Pay button each, result with reason and links | ✅ this repo |

## Run Part 1

You need **Node 18 or newer**. Check with `node -v`.

**1. Get a devnet RPC URL (5 minutes, free).** Sign up at [Helius](https://www.helius.dev) or [QuickNode](https://www.quicknode.com), create a **Devnet** endpoint and copy its HTTPS URL. The public devnet URL works too, but it rate-limits hard, so don't rely on it in the room.

**2. Install and configure.**

```bash
npm install
cp .env.example .env
```

Open `.env` and replace the URL with yours.

**3. Run setup.**

```bash
npm run setup
```

On the first run, the script creates a **bank wallet** (saved in `bank.json`) and tries a 1 SOL devnet airdrop. Devnet airdrops fail often. If yours does, the script prints the bank address. Then:

1. Go to https://faucet.solana.com
2. Paste the bank address, choose **Devnet**, request 1 SOL (signing in with GitHub raises the limit)
3. Run `npm run setup` again

Setup sends about 20 transactions and takes 1–2 minutes. At the end it prints every wallet with an explorer link, then a list of **Seller B's funding transactions**. Click those to confirm they show seller B sending SOL to its own "customers."

## Demo day

Run these in this order, from the project folder, shortly before you go on stage.

1. **`npm run reset`**: sweeps the old wallets back to the bank and builds fresh ones (1–2 minutes). Every rehearsal click on "Pay" is a real devnet payment, so always reset after rehearsing.
2. **`npm run verify`**: it must end with `ALL CHECKS PASSED`. If it doesn't, run `npm run reset` again.
3. **`npm run demo`**: open the URL it prints (`http://127.0.0.1:3000`) in Chrome and go full screen (⌃⌘F on a Mac, F11 on Windows). Don't click anything until you're on stage.

On stage, click **Seller A**: it shows a green PAID result and a "View payment on explorer" link. Then click **Seller B**: it shows a red BLOCKED result and a table with the 3 customers the seller funded itself.

If something goes wrong:
- A red result with "couldn't verify" or "couldn't reach the auditor" means the page failed safely and nothing was sent.
- "NOT CONFIRMED" means the server stopped during a payment, so the page can't say whether it went through. Open the agent's wallet link before trying again.
- Reloading the page re-enables both buttons. Clicking Seller A again sends another real payment.
- If the server stopped, run `npm run demo` again. Ctrl+C stops it. The terminal logs every audit and payment as it happens.
- Don't run `npm run verify` after clicking: once seller A has been paid it reports 5 payments and fails. That's expected.

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | Builds the demo wallets. If they already exist, it just prints them. |
| `npm run reset` | Sweeps all old demo wallets back to the bank, then rebuilds from scratch. Run this before the demo. |
| `npm run show` | Prints the current wallets and links without touching the network. |
| `npm run verify` | Checks on devnet that the setup wallets have the expected money trail. Run it right after setup or reset: once the agent has paid seller A, A has 5 payments and verify fails. |
| `npm run audit -- <address>` | Runs the auditor on one seller: PASS or BLOCK, the reason, and explorer links. `A` or `B` in place of an address is a shortcut for the demo sellers. |
| `npm run demo` | Starts the demo page at http://127.0.0.1:3000 (local only). |
| `npm run pay -- <address>` | Audits the seller, then pays it 0.01 SOL from the agent only on PASS. Prints the explorer link and the agent's balance before and after. `A` or `B` work here too. |

The bank wallet survives resets, so you only use the faucet once. 1 SOL covers several rebuilds.

## What setup creates

```
bank ─→ agent                                    (the payer in Part 3)
bank ─→ funder 1–4 ─→ customer A1–A4 ─→ seller A  (clean)
bank ─→ seller B ──→ customer B1–B3 ─→ seller B   (dirty: seller funds its own customers)
bank ─→ funder 5 ──→ customer B4 ────→ seller B   (one normal-looking customer)
```

Both sellers look the same on the surface: 4 customers, one 0.01 SOL payment each. The only difference is where the customers got their money.

## Files

- `scripts/setup.js`: builds and funds everything
- `scripts/reset.js`: sweeps old wallets back to the bank and rebuilds
- `scripts/show.js`: prints wallets and links
- `scripts/verify.js`: checks the setup wallets on devnet
- `scripts/auditor.js`: the auditor. `audit(sellerAddress)` reads only the blockchain, never wallets.json or bank.json
- `scripts/audit-cli.js`: prints an audit in plain English (`npm run audit`)
- `scripts/demo.js`: the local demo server. It serves `public/index.html` and two endpoints, `POST /api/audit` and `POST /api/pay`. The agent's keys stay in this process
- `public/index.html`: the demo page (one file, inline CSS and JS, no build step)
- `scripts/pay.js`: `pay(sellerAddress)` audits first, every time, and pays only on PASS. The safety limits are the constants at the top
- `scripts/common.js`: shared helpers (RPC connection, transfers with retries, explorer links)
- `wallets.json`, `bank.json`: **secret keys, gitignored, never commit them**
