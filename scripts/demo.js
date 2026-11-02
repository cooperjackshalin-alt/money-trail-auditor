// Part 4: the demo page.
//
// A tiny local server. It serves public/index.html and two endpoints that call our
// existing audit() and pay(). It listens on 127.0.0.1 only. The agent's keys never
// leave this process: the page only ever gets addresses, verdicts and transaction
// signatures.
//
// Run with:  npm run demo

const http = require('http');
const fs = require('fs');
const path = require('path');
const { audit } = require('./auditor');
const { pay, PAYMENT_LAMPORTS } = require('./pay');
const { getConnection, loadWallets, shortErr, LAMPORTS_PER_SOL } = require('./common');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const PAGE_FILE = path.join(__dirname, '..', 'public', 'index.html');
const MAX_BODY_BYTES = 1024;

// One payment at a time, even if the page somehow sends two.
let paymentInFlight = false;

const redact = (msg) => String(msg).replace(/api-key=[^&\s"]*/g, 'api-key=<redacted>');

function demoWallets() {
  const state = loadWallets();
  return state && state.status === 'ready' ? state : null;
}

// The page only ever sends "A" or "B". The address comes from here, never from the browser.
function sellerAddress(key) {
  const state = demoWallets();
  if (!state || (key !== 'A' && key !== 'B')) return null;
  return state.sellers[key].address;
}

// ---------- request guards ----------

// Only this page may call the API: same host, same origin, JSON body. This blocks
// other websites open in the same browser from triggering a payment.
const allowedHosts = [`${HOST}:${PORT}`, `localhost:${PORT}`];
const allowedHost = (req) => allowedHosts.includes(req.headers.host);
const allowedOrigin = (req) => !req.headers.origin || allowedHosts.map((h) => `http://${h}`).includes(req.headers.origin);
const isJson = (req) => (req.headers['content-type'] || '').startsWith('application/json');

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('request is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------- responses ----------

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function sendPage(res) {
  const state = demoWallets();
  const data = state
    ? {
        sellers: { A: state.sellers.A.address, B: state.sellers.B.address },
        agent: state.agent.address,
        paymentSol: PAYMENT_LAMPORTS / LAMPORTS_PER_SOL,
      }
    : null;
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const html = fs.readFileSync(PAGE_FILE, 'utf8').replace('/*DEMO_DATA*/null', json);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  try {
    if (!allowedHost(req)) return sendJson(res, 403, { error: 'forbidden' });
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) return sendPage(res);
    if (req.method === 'GET' && req.url === '/favicon.ico') return res.writeHead(204).end();

    if (req.method === 'POST' && (req.url === '/api/audit' || req.url === '/api/pay')) {
      if (!allowedOrigin(req) || !isJson(req)) return sendJson(res, 403, { error: 'forbidden' });
      const { seller } = await readJson(req);
      const address = sellerAddress(seller);
      if (!address) return sendJson(res, 400, { error: 'unknown seller, or the demo wallets are not set up' });

      if (req.url === '/api/audit') {
        const result = await audit(address);
        console.log(`[audit ${seller}] ${result.verdict}: ${result.reason}${result.detail ? ` (${result.detail})` : ''}`);
        return sendJson(res, 200, result);
      }

      if (paymentInFlight) {
        console.log(`[pay ${seller}] refused: another payment is in progress`);
        return sendJson(res, 200, { paid: false, reason: 'Not paid: another payment is already in progress. Nothing was sent.', audit: null });
      }
      paymentInFlight = true;
      try {
        const result = await pay(address);
        console.log(`[pay ${seller}] ${result.paid ? `PAID ${result.explorerUrl}` : `NOT PAID: ${result.reason}`}`);
        return sendJson(res, 200, result);
      } finally {
        paymentInFlight = false;
      }
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.log(`[error] ${redact(shortErr(err))}`);
    sendJson(res, 500, { error: redact(shortErr(err)) });
  }
});

function main() {
  getConnection(); // exits with a clear message if RPC_URL is missing or looks like mainnet
  const state = demoWallets();
  if (!state) {
    console.log('No finished demo wallets. Run `npm run reset` first.');
    process.exit(1);
  }
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.log(`Port ${PORT} is busy. Stop the other server, or run: PORT=3001 npm run demo`);
    else console.log(`Server error: ${redact(shortErr(err))}`);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`\nDemo page: http://${HOST}:${PORT}\n`);
    console.log(`  Seller A: ${state.sellers.A.address}`);
    console.log(`  Seller B: ${state.sellers.B.address}`);
    console.log(`  Agent:    ${state.agent.address}\n`);
    console.log('Press Ctrl+C to stop.\n');
  });
}

main();
