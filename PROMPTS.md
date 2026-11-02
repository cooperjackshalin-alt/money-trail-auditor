# Prompt log

Every prompt we used to build this, in order. Note what worked and what we had to fix.

## Part 1: Setup (Claude)

```
Context: 3-minute live demo Wednesday on Solana devnet. Reliability beats cleverness. No x402, no Circle Agent Wallets, no agent framework for this round.

The demo has 4 parts we'll build one at a time:
1. Setup: create wallets and fund them on devnet
2. Auditor check: seller address in → verdict + the transactions that caused it
3. Pay or block: send a fixed payment if clean, return an explorer link
4. One page: two seller cards, a Pay button each, the result with reason and links

Build only Part 1 now.
- One "agent" wallet (the payer).
- Seller A (clean): 4 customer wallets funded from unrelated wallets, each paid Seller A once.
- Seller B (dirty): 4 customer wallets, 3 of them funded directly by Seller B, each paid Seller B once.
- Save all keys to a local file that's gitignored.
- One reset command that rebuilds everything from scratch.
- Use a custom devnet RPC URL from a .env file.
- Prefer Circle's official devnet USDC if it's straightforward; otherwise use SOL and we'll call it "test money" on stage.

Done when: running setup prints every wallet address with a devnet explorer link, and I can see Seller B's funding transactions in the explorer.

Tell us exactly how to run it.
```

**Result:** Node scripts for setup, reset and show. Used SOL instead of USDC (token accounts and Circle's faucet add failure points for a 2-evening build). Added a persistent "bank" wallet so resets don't need the faucet again.

**What we had to fix:**

- **Retries could double-pay.** The old `transfer()` built a brand-new transaction on every retry. If devnet timed out while confirming a transfer that had actually landed, the retry would send the money again. Now each transaction is signed once and its signature is kept. After any error or timeout we check `getSignatureStatuses` for that signature. If it landed, we return it. While its blockhash is still valid we only resend the same signed bytes, which can't land twice. A new transaction is built only after the blockhash has expired and the old one never landed. If expiry can't be confirmed, the transfer gives up with an error instead of resending. Also added `bs58` as a direct dependency to encode the signature before sending (`scripts/common.js`, `package.json`).
- **Wrong kind of Helius URL.** The first URL pasted into `.env` was a Helius Wallet Balances REST link (`api.helius.xyz/v1/wallet/.../balances?api-key=...`), not an RPC endpoint, and it returned `405 Invalid method`. Use the devnet RPC form instead: `https://devnet.helius-rpc.com/?api-key=YOUR_KEY`. The same key works. To confirm it's devnet, check that `getGenesisHash()` returns `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.
- **Airdrop failed** (`500 Internal Server Error` via Helius). We funded the bank by hand at faucet.solana.com, as the README describes. No code change.

Verified on devnet after both `npm run setup` and `npm run reset`:
- Seller A has 4 incoming payments, and none of its customers were funded by Seller A.
- Seller B has 4 incoming payments, and exactly 3 of its customers were funded directly by Seller B.
- All 16 signatures in `wallets.json` exist and are confirmed.

Reset swept all 16 old wallets to zero and rebuilt cleanly. No retries were needed on either run.

## Part 2: Auditor check (Claude)

```
Part 1 is done. Move your verify.js into the repo as scripts/verify.js with an `npm run verify` script, and use its chain-reading logic as the starting point for Part 2.

Build only Part 2: the auditor check. No payments, no UI.

Rule that matters most: the auditor reads ONLY the blockchain. Its single input is a seller address. It must never read wallets.json or bank.json to decide anything. A judge will ask whether the demo is rigged, and the honest answer has to be no.

What it does, given a seller address:
1. Read the seller's recent transaction history (latest 25 signatures is enough) and find every wallet that sent it SOL. Those are its customers. If the seller paid itself, flag that as self-payment.
2. For each customer, find where it got its first SOL (its oldest incoming transfer). That's the funder.
3. If the funder is the seller itself, flag that customer and keep the funding transaction signature.
4. Verdict: BLOCK if any customer was funded by the seller, or if there's any self-payment. Put the threshold in one constant at the top so it's easy to explain and change. Otherwise PASS.
5. Fail closed: if the RPC errors, the history can't be read, or the seller has no customers, the verdict is BLOCK with the reason "couldn't verify this seller". Never PASS by default.

Structure:
- scripts/auditor.js exports audit(sellerAddress) → { verdict, reason, customers: [{ address, funder, fundingSig, fundedBySeller }], flaggedSigs }. Parts 3 and 4 will import this.
- `npm run audit -- <address>` prints a plain-English result with devnet explorer links. As a convenience only, `npm run audit -- A` and `npm run audit -- B` may look up those two addresses from wallets.json. That's just picking the input, not deciding the verdict.
- Write the reason the way we'll say it on stage, e.g. "Blocked: 3 of this seller's 4 customers got their first funds from the seller's own wallet."

Done when, tested on devnet:
- Seller A → PASS
- Seller B → BLOCK, listing exactly the 3 funding transactions that match `npm run show`
- A brand-new empty address → BLOCK (couldn't verify)
- Each audit finishes in under 5 seconds on our Helius URL. Tell me the actual times.
- Confirm by searching the code that auditor.js never reads wallets.json.

Log this prompt and what you had to fix in PROMPTS.md. Don't commit.
```

**Result:** `scripts/auditor.js` exports `audit(sellerAddress)`. It returns `{ verdict, reason, seller, customers, flaggedSigs }`, plus `detail` (the technical cause) when it couldn't verify. The rule is one constant at the top, `BLOCK_AT_SELLER_FUNDED_CUSTOMERS = 1`, and self-payment always blocks. Any error, unreadable transaction, missing history, no customers, or no answer within 8 seconds gives BLOCK with "couldn't verify this seller." The command-line printer is a separate file, `scripts/audit-cli.js`. That file holds the A/B shortcut, so `auditor.js` has no code that touches wallets.json, bank.json or any file. `scripts/verify.js` moved into the repo (`npm run verify`).

Tested on devnet:
- Seller A → PASS in 0.25–0.26s.
- Seller B → BLOCK in 0.26–0.31s. Its 3 flagged transactions are identical to `npm run show`.
- A brand-new address → BLOCK (couldn't verify, no history) in 0.10–0.11s.
- End to end, including Node startup, each is under 0.5s.

Also tested live: garbage input and a bad API key (401) both BLOCK with "couldn't verify." Paths the demo wallets can't produce were tested offline with a stubbed RPC: self-payment BLOCKs, one seller-funded customer BLOCKs, a clean seller PASSes, and an unreadable customer transaction or an RPC that hangs BLOCKs (the hang after 8s).

Proof it isn't rigged: `grep` finds no file or wallet access in `auditor.js`. Its only imports are `@solana/web3.js` and `getConnection` from `common.js`. We also ran it under Node's permission model with read access only to `scripts/`, `node_modules/` and `.env`, and got the same verdicts, while reading `wallets.json` in that process failed with `ERR_ACCESS_DENIED`.

**What we had to fix:**

- **Seller B shows 5 customers, not 4.** The bank's 0.08 SOL that bankrolls seller B is a wallet sending the seller SOL, so the chain-only auditor counts the bank as a customer. The bank's own first SOL came from the devnet faucet, so it isn't flagged. The stage line is therefore "Blocked: 3 of this seller's 5 customers got their first funds from the seller's own wallet." We left it honest rather than special-casing it. Skipping "the wallet that first funded the seller" would also drop seller A's first real customer, because that customer's payment is what opened seller A's account.
- No code bugs came up. We kept the CLI in a separate file from the start so the "never reads wallets.json" check is a one-line grep on `auditor.js`.

## Part 3: Pay or block (Claude)

```
Part 2 is approved. Keep "3 of 5" and don't change Part 1.

Build only Part 3: pay or block. No UI.

1. scripts/pay.js exports pay(sellerAddress):
   - Runs audit(sellerAddress) first, every time. No caching.
   - BLOCK → send nothing. Return { paid: false, audit }.
   - PASS → send a fixed payment from the agent wallet to the seller with our existing no-double-send transfer(), and return { paid: true, signature, explorerUrl, audit }.
   - The agent's own key comes from wallets.json. That's fine: it's the payer's wallet, not an input to the verdict. The verdict still comes only from auditor.js.
2. Safety limits as constants at the top, so we can point at them in the pitch:
   - PAYMENT_LAMPORTS = 0.01 SOL
   - MAX_PAYMENT_LAMPORTS: refuse anything above it
   - Refuse if the agent's balance would drop below a small floor
   Any failure means nothing is sent, with a clear reason.
3. `npm run pay -- A`, `npm run pay -- B`, or `npm run pay -- <address>` prints a plain-English result and the explorer link.

Done when, tested on devnet:
- Pay A → sends; print the explorer link and the agent's balance before and after
- Pay B → blocked, and the agent's balance is unchanged (show both numbers)
- Pay an empty address → blocked, nothing sent
- Audit A again after paying it → still PASS (the agent is now one of A's customers; confirm it isn't flagged)
- Run `npm run reset`, then pay A and B again, to prove the full loop resets cleanly for the demo

Log the prompt and fixes in PROMPTS.md. Don't commit.
```

**Result:** `scripts/pay.js` exports `pay(sellerAddress)`. It always runs `audit()` first. On BLOCK it returns `{ paid: false, reason, audit }` and sends nothing. On PASS it returns `{ paid: true, signature, explorerUrl, lamports, audit }`. The safety limits are constants at the top:
- `PAYMENT_LAMPORTS` = 0.01 SOL.
- `MAX_PAYMENT_LAMPORTS` = 0.05 SOL. Anything above it is refused.
- `MIN_AGENT_BALANCE_LAMPORTS` = 0.05 SOL. A payment is refused if it would leave the agent below this, fee included.

It also refuses if the wallets aren't set up, or if the seller is the agent itself. A chain-only audit of the agent would PASS, because its only "customer" is the bank. Every refusal happens before anything is signed and says "Nothing was sent." `npm run pay -- A|B|<address>` prints the audit, the result, the explorer link and the agent's balance before and after, in SOL and exact lamports.

Tested on devnet:
- **Pay A:** PAID. Agent went from 0.3000 to 0.2900 SOL, exactly 300,000,000 → 289,995,000 lamports (the payment plus the 5,000-lamport fee). [tx](https://explorer.solana.com/tx/5E6CcS6R3CLuf4hsnx5d6QffxRhJmiPssdqVRfsKKP1thu8iggCjdHMQpEYxJLuT7mpF3o6u3V7wYD3yj15BJzAz?cluster=devnet)
- **Pay B:** BLOCKED. The agent's balance was 289,995,000 lamports before and after, and its transaction count stayed at 2.
- **Pay an empty address:** BLOCKED (couldn't verify, no history). Nothing sent.
- **Audit A after paying it:** still PASS, now with 5 customers. The agent is customer 1, and its first funds came from the bank, so it isn't flagged.
- **`npm run reset`, then pay A and B:** reset swept everything back, including the 0.01 SOL A had received. `npm run verify` passed again. Pay A was PAID (300,000,000 → 289,995,000 lamports), pay B was BLOCKED (balance unchanged), and B's 3 flagged transactions are identical to `npm run show`.

Tested offline with `sendRawTransaction` stubbed, so nothing could reach devnet:
- The balance floor, the per-payment max and paying the agent itself are all refused before any send.
- **Never confirmed:** with real block heights, all 3 attempts expired without landing, and it reports that nothing was sent.
- **Unknown:** with the deadline hit, it reports "may still land", with the transaction link to check before paying again.

**What we had to fix:**

- **pay() needed to know whether a failed transfer might still land.** `transfer()` threw the same error for "every attempt expired without landing" (nothing sent) and "hit the 3-minute deadline" (it may still land). It now tags the error with `mayHaveLanded` and the last `signature`, so pay() can say which. The retry behaviour and the error message setup prints are unchanged.
- **Setup's wording leaked into pay's reason.** The first version passed through setup's "run reset to sweep" text. pay() now gives its own reason for each case.
- **Balances showed only 4 decimals,** which would hide a fee. The CLI prints exact lamports too, so "unchanged" is provable.
- **Shared the A/B shortcut.** It moved from `audit-cli.js` into `common.js` as `pickSellerAddress()`, so `npm run audit` and `npm run pay` share it. `auditor.js` is unchanged and still has no file or wallet access.
- **`npm run verify` fails after any payment to A,** because A then has 5 incoming payments. That's expected, so the order before the pitch is `npm run reset` → `npm run verify` → demo. This is noted in the README.

## Part 4: One demo page (Claude)

```
Part 3 is approved. Build only Part 4: one demo page. It will be projected in a room on Wednesday, so it has to be reliable and readable from the back row.

Architecture (keep it boring):
- A tiny local Node server (plain http or Express, nothing else) that serves one HTML file and two endpoints: POST /api/audit and POST /api/pay, which call our existing audit() and pay().
- Bind to localhost only. The agent's keys stay on the server and never reach the browser.
- One command: `npm run demo` starts it and prints the URL.
- No React or build step. One HTML file with inline CSS and JS.

The page:
- A one-line header: "Our agent wants to buy market data. Before it pays, the auditor checks the seller's money trail."
- Two seller cards that look IDENTICAL before clicking: same layout, neutral names (e.g. "Seller A" / "Seller B" or two made-up data shops), the shortened address with an explorer link, and a "Pay 0.01 SOL" button. Do NOT label either one clean, dirty, safe or risky.
- On click: disable that button immediately (pay() doesn't stop double payments), show "Auditing the seller's money trail…", then the result in the card:
  - PAID: a large green result, the reason ("None of this seller's 4 customers were funded by the seller"), and a "View payment on explorer" link.
  - BLOCKED: a large red result, the exact reason string from the auditor, and a small table of the seller's customers showing who funded each one. Highlight the rows funded by the seller, with each funding transaction linked to the explorer.
  - Couldn't verify, or any server error: show it as BLOCKED with the reason. Never show a blank card or a spinner that runs forever.
- Explorer links open in a new tab.
- Projector-friendly: large text, high contrast, works at 1280×720 and on a laptop screen. No horizontal scroll.
- No reset button on the page. We reset from the terminal before going on stage.

Done when, tested on devnet:
- `npm run reset`, then `npm run demo`, then clicking Seller A pays and shows a working explorer link
- Clicking Seller B blocks and shows the 3 highlighted funding rows matching `npm run show`
- Double-clicking a Pay button sends exactly one payment (check the agent's balance)
- Stopping the server mid-click shows a BLOCKED/error result, not a hang
- Take a screenshot of each result state so I can see them

Add a "Demo day" section to the README: reset → verify → demo, in that order. Log the prompt and fixes in PROMPTS.md. Don't commit.
```

**Result:** `scripts/demo.js` is a plain Node `http` server with no new dependencies, bound to `127.0.0.1:3000` (`PORT` overrides the port). It serves `public/index.html`: one file, inline CSS and JS, no build step. The page gets only the two seller addresses, the agent's address and the payment size; keys never leave the server. The endpoints take only `{ "seller": "A" | "B" }` and the server maps that to the address, so the page can't make the agent pay an arbitrary address.

The server also rejects:
- a foreign `Host` header (DNS rebinding)
- a foreign `Origin`
- any non-JSON body, which stops a cross-site form post from triggering a payment

The page calls `/api/audit` first. On BLOCK it stops. On PASS it shows "Audit passed. Paying 0.01 SOL…" and calls `/api/pay`, which audits again: pay() never trusts an earlier audit. The button is disabled on the first click. The server also allows only one payment at a time. Every request has a client timeout (15s for the audit, 60s for the payment), so no state hangs.

Tested on devnet, in order:
- **`npm run reset` → `npm run verify` → `npm run demo`:** all fine.
- **Seller A:** PAID about 2.5s after the click. The agent went from 300,000,000 to 289,995,000 lamports. The explorer link opens in a new tab and shows Success / Finalized.
- **Seller B:** BLOCKED, with "Blocked: 3 of this seller's 5 customers…". The agent's balance didn't change. The 3 highlighted rows' transaction links are identical to `npm run show`.
- **Double-click plus 3 extra programmatic clicks on A:** exactly one payment (−10,005,000 lamports, transaction count +1).
- **Two simultaneous `/api/pay` requests**, as from two browser tabs: one PAID, the other "another payment is already in progress. Nothing was sent."
- **RPC never answers:** BLOCKED ("couldn't verify this seller", why: no answer within 8s) after 8.0s.
- **Server killed during the audit:** BLOCKED ("couldn't reach the auditor. Nothing was sent.") immediately.
- **Server killed during the payment:** NOT CONFIRMED, with a link to the agent's wallet. In that run the kill beat the request, so nothing was sent.
- **Layout:** no horizontal scroll at 1280×720, 1280×640, 1440×900 or 390px wide. The tallest state (B blocked) is 650px, so it fits 1280×720 fully.

Screenshots were taken with headless Chrome via `puppeteer-core`. That was installed only in a scratch folder, not in this project.

**What we had to fix:**

- **The blocked state didn't fit 1280×720.** It was 736px tall. We tightened the spacing, not the text size, and it's now 650px.
- **Table addresses split across two lines on a phone.** Shortened addresses now stay on one line, and the table is tighter below 600px wide.
- **One deliberate change from the brief:** if the server dies during the *payment* step, the page shows a red **NOT CONFIRMED**, not BLOCKED. At that point the payment may already have been sent, so "BLOCKED" could be false. The page links to the agent's wallet so you can check. Failures during the audit step still show BLOCKED with "Nothing was sent."
- **A second layer against double payments.** The disabled button covers double-clicks. The server lock covers two tabs or a scripted double request.
