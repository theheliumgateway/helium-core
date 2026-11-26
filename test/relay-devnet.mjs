// DEVNET ONLY. End-to-end check of the relayed push (src/hop.ts + server/relay.mjs) with worthless test keys:
//   1. a fresh gateway G is funded and shields 0.2 devnet SOL;
//   2. G pushes 0.05 to a fresh "main wallet" through a one-time key, with a relayer running in this process;
//   3. checks: the main wallet got exactly 0.05; the withdrawal doesn't contain G's address anywhere, but does
//      contain the one-time key's; the relayer refuses to reuse the same fee; what the push cost the relayer.
// Needs a Helius API key, read from HELIUS_API_KEY and never printed. Run (PowerShell):
//   $env:HELIUS_API_KEY="<key>"; node test/relay-devnet.mjs
// The payer is devnet/payer.json. Each run spends about 0.4 devnet SOL.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import {
  address, appendTransactionMessageInstructions, createKeyPairSignerFromPrivateKeyBytes, createSolanaRpc,
  createTransactionMessage, generateKeyPairSigner, getAddressEncoder, getBase64EncodedWireTransaction,
  getSignatureFromTransaction, pipe, setTransactionMessageConfig, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { SOL_MINT, ShieldedKeypair, SigningKey, Wallet, createSprClient, syncWallet } from "@heliuslabs/spr";
import { LocalKeys, SignedTeePolicy } from "@heliuslabs/spr/client";
import { DepositAsset, depositInstruction } from "@heliuslabs/spr/interface";
import { bytes32 } from "@heliuslabs/spr/keypair";
import { AssetRegistry } from "@heliuslabs/spr/transaction";
import { createRelay } from "../server/relay.mjs";
import { hopKey, relayedPush } from "../src/hop.ts";

const KEY = process.env.HELIUS_API_KEY?.trim();
if (!KEY) {
  console.error('Set HELIUS_API_KEY first. PowerShell: $env:HELIUS_API_KEY="<your key>"; node test/relay-devnet.mjs');
  process.exit(2);
}
const RPC = `https://devnet.helius-rpc.com/?api-key=${encodeURIComponent(KEY)}`;
const rpc = createSolanaRpc(RPC);
// errors from the SDK can quote the URL: keep the key out of anything this script prints
const scrub = (s) => String(s).split(KEY).join("<key>").split(encodeURIComponent(KEY)).join("<key>");
for (const k of ["log", "error", "warn"]) {
  const orig = console[k].bind(console);
  console[k] = (...a) => orig(...a.map((x) => (typeof x === "string" ? scrub(x) : x instanceof Error ? scrub(x.stack ?? x.message) : x)));
}
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fmt = (l) => (Number(l) / 1e9).toFixed(6);
const unhex = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
const hex = (b) => Buffer.from(b).toString("hex");
let failed = 0;
const check = (cond, name) => { log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) failed++; };

const client = await createSprClient({ solanaRpcUrl: RPC, proverTee: SignedTeePolicy.forNetwork("devnet") });
const payer = await createKeyPairSignerFromPrivateKeyBytes(unhex(JSON.parse(readFileSync("devnet/payer.json", "utf8")).seedHex));

async function send(instructions, feePayer) {
  const { value: lifetime } = await rpc.getLatestBlockhash().send();
  const signed = await signTransactionMessageWithSigners(pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => setTransactionMessageConfig({ computeUnitLimit: 450_000, loadedAccountsDataSizeLimit: 64 * 1024 * 1024 }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  ));
  const sig = getSignatureFromTransaction(signed);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  return { sig, slot: await client.confirmTransaction(sig) };
}
const contains = (bytes, addr) => bytes.includes(Buffer.from(getAddressEncoder().encode(address(addr))));

const start = await client.getBalance(payer.address);
log("payer", payer.address, fmt(start), "SOL (devnet)");
if (start < 500_000_000n) throw new Error("devnet payer needs at least 0.5 SOL");

// the gateway, shaped like src/spr.ts VaultHandle
const seed = crypto.getRandomValues(new Uint8Array(32));
const keypair = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(bytes32(seed)));
const signer = keypair.toSolanaSigner();
const G = { client, keypair, signer, assets: new AssetRegistry(), address: signer.address,
  wallet: new Wallet({ identity: keypair.shieldedAddress() }), keys: LocalKeys.fromKeypair(keypair, client.proofService) };
const main = (await generateKeyPairSigner()).address;

// the relayer, in this process, behind a local HTTP server shaped like /api/relay/*
const relay = await createRelay({
  network: "devnet", rpcUrl: RPC, relayerSeedHex: hex(crypto.getRandomValues(new Uint8Array(32))),
  treasurySeedHex: hex(crypto.getRandomValues(new Uint8Array(32))),
  // generous caps for the measurement; the output says what a push really costs
  feeBps: 30, minFeeLamports: "20000000", maxCostLamports: "20000000",
});
const server = createServer(async (req, res) => {
  const reply = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.url === "/info") return reply(200, relay.info());
  if (req.url === "/push" && req.method === "POST") {
    let raw = ""; for await (const c of req) raw += c;
    try { return reply(200, await relay.push(JSON.parse(raw))); } catch (e) { return reply(e.status ?? 502, { error: scrub(e.message) }); }
  }
  reply(404, { error: "Not found" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
log("gateway", G.address, "| main", main, "| relayer", relay.relayer);

// 1. fund and shield
await send([
  getTransferSolInstruction({ source: payer, destination: G.address, amount: 300_000_000n }),
  getTransferSolInstruction({ source: payer, destination: relay.relayer, amount: 100_000_000n }),
], payer);
{
  const me = keypair.shieldedAddress();
  const ix = await depositInstruction({ tree: client.tree, depositor: signer,
    deposits: [{ asset: DepositAsset.sol(), viewTag: me.confidentialViewTag(), recipientOwnerHash: me.ownerHash(), amount: 200_000_000n }] });
  const { slot } = await send([ix], signer);
  await syncWallet({ client, wallet: G.wallet, keys: G.keys, config: { requireSlot: slot } });
  log("1. shielded; G private =", fmt(G.wallet.balance(SOL_MINT).amount));
}

// 2. the relayed push
const relayerBefore = await client.getBalance(relay.relayer);
const r = await relayedPush(G, seed, 0, main, 50_000_000n, url, { network: "devnet", onStep: (s) => log("2.", s) });
const relayerAfter = await client.getBalance(relay.relayer);
log("2. pushed: hop", r.hopSignature.slice(0, 12), "| withdrawal", r.signature.slice(0, 12), "| fee", fmt(r.fee));

// 3. checks
check((await client.getBalance(main)) === 50_000_000n, "the main wallet got exactly 0.05");
// the transactions exactly as sent (the withdrawal before the relayer's signature, which adds no account or data)
const a = Buffer.from(r.wire.hop, "base64"), b = Buffer.from(r.wire.withdrawal, "base64");
check(contains(a, G.address), "step A (gateway -> one-time key) names the gateway, as expected");
check(!contains(b, G.address), "the withdrawal doesn't contain the gateway's address anywhere");
check(contains(b, r.hopAddress) && r.hopAddress !== G.address, "the withdrawal names only the one-time key");
check(contains(b, relay.relayer), "the relayer paid the withdrawal's network fee");
{
  const hop = await hopKey(G, seed, 0);
  await syncWallet({ client, wallet: hop.wallet, keys: hop.keys });
  check(hop.wallet.balance(SOL_MINT).amount === 0n, "nothing is left on the one-time key");
}
{
  let status = 0;
  try { await relay.push({ feeSignature: r.hopSignature, amount: "50000000", recipient: main, tx: "AA==" }); } catch (e) { status = e.status; }
  check(status === 409, "the relayer refuses to reuse the same fee");
}
const cost = relayerBefore - relayerAfter;
log(`relayer cost for one push: ${cost} lamports (${fmt(cost)} SOL). Set RELAY_MIN_FEE_LAMPORTS and RELAY_MAX_COST_LAMPORTS from this.`);
log("payer now", fmt(await client.getBalance(payer.address)));
server.close();
log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
