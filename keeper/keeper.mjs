// Kelvin keeper
// Mirrors Gemini Prediction Markets onto Arc and settles cover.
//
//   1. LIST     new Gemini contracts we underwrite (weather highs, natural gas, short crypto)
//   2. POST     each contract's implied probability (Gemini best ask) to KelvinOracle
//   3. RESOLVE  contracts Gemini has settled (resolutionSide yes / no)
//   4. SETTLE   every policy whose markets are resolved — the payout goes straight to the holder
//
// Usage:  node keeper.mjs --once          one pass
//         node keeper.mjs --loop [secs]   keep going (default every 60s)
// Env:    KEEPER_PRIVATE_KEY, ORACLE_ADDRESS, VAULT_ADDRESS, [ARC_RPC_URL], [KEEPER_MAX_MINUTES]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toBytes, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const abi = (name) => JSON.parse(readFileSync(join(here, "abi", `${name}.json`), "utf8"));
const oracleAbi = abi("KelvinOracle");
const vaultAbi = abi("KelvinVault");

const GEMINI = "https://api.gemini.com/v1/prediction-markets";
const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.io";
const ORACLE = process.env.ORACLE_ADDRESS;
const VAULT = process.env.VAULT_ADDRESS;
const PK = process.env.KEEPER_PRIVATE_KEY;
if (!ORACLE || !VAULT || !PK) {
  console.error("Missing ORACLE_ADDRESS, VAULT_ADDRESS or KEEPER_PRIVATE_KEY");
  process.exit(1);
}

// ---- what we underwrite -------------------------------------------------------------------
// Daily-high temperature events for these cities (Gemini event tickers WXHIGH-<CITY>-...).
const WEATHER_CITIES = ["AUS", "DFW", "HOU", "NYC", "CHI", "MIA", "LA", "DEN", "ATL", "BOS", "DCA", "LAS"];
// Weekly Henry Hub natural gas price ladders (the fuel that sets the Texas power price).
const COMMODITY_PREFIXES = ["NGAS"];
// A short-dated market so a full buy → resolve → payout cycle can be watched in minutes.
const CRYPTO_PREFIXES = ["BTC05M"];
const CRYPTO_KEEP = 5; // only the next few expiries

// Cover stops selling before the outcome starts to be observed, so nobody can buy with
// information the quote does not have yet.
export function salesCloseFor(eventTicker, expiry) {
  if (eventTicker.startsWith("WXHIGH-")) return expiry - 13 * 3600; // ~10am Central on the measured day, before the afternoon high
  if (COMMODITY_PREFIXES.some((p) => eventTicker.startsWith(p))) return expiry - 8 * 3600; // morning of settlement day
  return expiry - 6 * 60; // 5-minute markets: before the window opens
}

const HEARTBEAT_SECS = 8 * 60; // re-post unchanged odds at least this often (vault staleness is 15 min)
const BATCH = 40;

const arc = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: "Arcscan", url: "https://testnet.arcscan.app" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

const account = privateKeyToAccount(PK);
const pub = createPublicClient({ chain: arc, transport: http(RPC) });
const wallet = createWalletClient({ chain: arc, transport: http(RPC), account });

const idOf = (symbol) => keccak256(toBytes(symbol));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const chunk = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

async function gemini(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${GEMINI}${path}`, { headers: { accept: "application/json" } });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch {}
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  throw new Error(`Gemini request failed: ${path}`);
}

async function geminiEvents(category) {
  const out = [];
  for (let offset = 0; offset < 600; offset += 100) {
    const page = await gemini(`/events?status=active&category=${encodeURIComponent(category)}&limit=100&offset=${offset}`);
    const data = page?.data ?? [];
    out.push(...data);
    if (data.length < 100) break;
  }
  return out;
}

/// The price a buyer would pay for Yes right now, as basis points. null = no usable quote.
export function impliedProbBps(contract) {
  const p = contract.prices ?? {};
  const ask = parseFloat(p.bestAsk ?? p.buy?.yes);
  const bid = parseFloat(p.bestBid ?? p.sell?.yes);
  if (Number.isFinite(ask) && ask > 0) return Math.min(9900, Math.round(ask * 10000));
  // one-sided book: a bid with no offer. Price conservatively above the bid.
  if (Number.isFinite(bid) && bid > 0) return Math.min(9900, Math.round((bid + 0.05) * 10000));
  return null;
}

async function wanted() {
  const [weather, commodities, crypto] = await Promise.all([
    geminiEvents("Weather"),
    geminiEvents("Commodities"),
    geminiEvents("Crypto"),
  ]);
  const events = [];
  for (const e of weather) {
    const m = /^WXHIGH-([A-Z]+)-/.exec(e.ticker);
    if (m && WEATHER_CITIES.includes(m[1])) events.push(e);
  }
  for (const e of commodities) if (COMMODITY_PREFIXES.some((p) => e.ticker.startsWith(p))) events.push(e);
  const soon = crypto
    .filter((e) => CRYPTO_PREFIXES.some((p) => e.ticker.startsWith(p)))
    .filter((e) => new Date(e.contracts?.[0]?.expiryDate ?? 0).getTime() > Date.now() + 7 * 60_000)
    .sort((a, b) => new Date(a.contracts[0].expiryDate) - new Date(b.contracts[0].expiryDate))
    .slice(0, CRYPTO_KEEP);
  events.push(...soon);
  return events;
}

async function send(label, request) {
  const hash = await wallet.writeContract(request);
  const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  log(`${label}: ${rcpt.status} ${hash}`);
  return rcpt;
}

async function readMarkets(ids) {
  const out = new Map();
  for (const part of chunk(ids, 100)) {
    const res = await pub.multicall({
      contracts: part.map((id) => ({ address: ORACLE, abi: oracleAbi, functionName: "read", args: [id] })),
      allowFailure: false,
    });
    part.forEach((id, i) => out.set(id, { status: res[i][0], probBps: res[i][1], updatedAt: Number(res[i][2]), expiry: Number(res[i][3]), salesClose: Number(res[i][4]) }));
  }
  return out;
}

async function allListed() {
  const count = Number(await pub.readContract({ address: ORACLE, abi: oracleAbi, functionName: "marketCount" }));
  const rows = [];
  for (let offset = 0; offset < count; offset += 60) {
    const [ids, page] = await pub.readContract({ address: ORACLE, abi: oracleAbi, functionName: "listPage", args: [BigInt(offset), 60n] });
    ids.forEach((id, i) => rows.push({ id, ...page[i] }));
  }
  return rows;
}

export async function pass() {
  const now = Math.floor(Date.now() / 1000);
  const events = await wanted();

  // ---- 1 + 2: list and post odds ----
  const live = [];
  for (const e of events) {
    for (const c of e.contracts ?? []) {
      if (!c.instrumentSymbol || !c.expiryDate) continue;
      const expiry = Math.floor(new Date(c.expiryDate).getTime() / 1000);
      if (expiry <= now + 120) continue;
      const salesClose = salesCloseFor(e.ticker, expiry);
      if (salesClose <= now + 60) continue; // nothing left to sell: do not spend gas mirroring it
      live.push({ id: idOf(c.instrumentSymbol), symbol: c.instrumentSymbol, eventTicker: e.ticker, label: c.label, expiry, salesClose, prob: impliedProbBps(c) });
    }
  }
  const onchain = await readMarkets(live.map((m) => m.id));

  const toList = live.filter((m) => onchain.get(m.id).status === 0);
  for (const part of chunk(toList, 12)) {
    await send(`list ${part.length} markets`, {
      address: ORACLE, abi: oracleAbi, functionName: "listMarkets",
      args: [part.map((m) => m.symbol), part.map((m) => m.eventTicker), part.map((m) => m.label), part.map((m) => BigInt(m.expiry)), part.map((m) => BigInt(m.salesClose))],
    });
  }

  const toPost = live.filter((m) => {
    if (m.prob === null) return false; // no quote on Gemini: let it go stale, the vault will refuse to sell
    const oc = onchain.get(m.id);
    if (oc.status > 1) return false;
    return oc.status === 0 || oc.probBps !== m.prob || now - oc.updatedAt > HEARTBEAT_SECS;
  });
  // odds only matter while cover is on sale
  const postable = toPost.filter((m) => m.salesClose > now);
  for (const part of chunk(postable, BATCH)) {
    await send(`post odds for ${part.length} markets`, {
      address: ORACLE, abi: oracleAbi, functionName: "postOdds",
      args: [part.map((m) => m.id), part.map((m) => m.prob)],
    });
  }

  // ---- 3: resolve what Gemini has settled ----
  const listed = await allListed();
  const pending = listed.filter((m) => m.status === 1 && Number(m.expiry) < now);
  const byEvent = new Map();
  for (const m of pending) byEvent.set(m.eventTicker, [...(byEvent.get(m.eventTicker) ?? []), m]);
  const resolveIds = [];
  const resolveYes = [];
  for (const [ticker, markets] of byEvent) {
    const e = await gemini(`/events/${ticker}`);
    if (!e) continue;
    for (const m of markets) {
      const c = (e.contracts ?? []).find((x) => x.instrumentSymbol === m.symbol);
      const side = c?.resolutionSide;
      if (side === "yes" || side === "no") {
        resolveIds.push(m.id);
        resolveYes.push(side === "yes");
      }
    }
  }
  for (let i = 0; i < resolveIds.length; i += BATCH) {
    await send(`resolve ${Math.min(BATCH, resolveIds.length - i)} markets`, {
      address: ORACLE, abi: oracleAbi, functionName: "resolve",
      args: [resolveIds.slice(i, i + BATCH), resolveYes.slice(i, i + BATCH)],
    });
  }

  // ---- 4: settle policies ----
  const policyCount = Number(await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "policyCount" }));
  if (policyCount > 0) {
    const ids = Array.from({ length: Math.min(policyCount, 300) }, (_, i) => BigInt(policyCount - 1 - i));
    const ready = await pub.multicall({
      contracts: ids.map((id) => ({ address: VAULT, abi: vaultAbi, functionName: "isSettleable", args: [id] })),
      allowFailure: false,
    });
    const settleable = ids.filter((_, i) => ready[i]);
    for (const part of chunk(settleable, 20)) {
      await send(`settle ${part.length} policies`, { address: VAULT, abi: vaultAbi, functionName: "settleMany", args: [part] });
    }
  }

  const bal = await pub.getBalance({ address: account.address });
  log(`pass done — ${live.length} live, +${toList.length} listed, ${postable.length} posted, ${resolveIds.length} resolved; keeper balance ${Number(formatEther(bal)).toFixed(3)} USDC`);
}

const args = process.argv.slice(2);
if (args.includes("--loop")) {
  const every = Number(args[args.indexOf("--loop") + 1]) || 60;
  const maxMinutes = Number(process.env.KEEPER_MAX_MINUTES) || 0;
  const started = Date.now();
  for (;;) {
    try {
      await pass();
    } catch (err) {
      log("pass failed:", err.shortMessage ?? err.message);
    }
    if (maxMinutes && Date.now() - started > maxMinutes * 60_000) break;
    await new Promise((r) => setTimeout(r, every * 1000));
  }
} else if (args.includes("--once")) {
  await pass();
}
