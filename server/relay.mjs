// The push relayer (prototype, devnet first). See src/hop.ts for the wallet's side.
//
// A relayed push is two transactions. A: the gateway privately pays the amount to a one-time key and the service fee to
// Helium's treasury. B: the one-time key withdraws to the destination, with this relayer as fee payer. The relayer
// signs B only when:
//   - B is one Privacy Rings instruction, with the relayer as fee payer and no other program that could move its SOL;
//   - every other signer has already signed;
//   - B, simulated, pays the declared recipient exactly the declared amount and costs the relayer no more than the cap;
//   - A is confirmed and paid the treasury at least the fee for that amount (read with the treasury's own keys);
//   - A's fee hasn't paid for another push already.
//
// The relayer holds two keys: its own (a small hot wallet that pays network fees) and the treasury's (to read fee
// payments). It never holds a key that can move a user's SOL. It keeps no logs of pushes: only the used fee
// signatures, so one fee can't pay for two pushes.
//
// Config (environment): RELAY_NETWORK (devnet|mainnet), RELAY_RPC_URL (Helius RPC with key), RELAY_SEED_HEX and
// TREASURY_SEED_HEX (32-byte seeds), RELAY_FEE_BPS, RELAY_MIN_FEE_LAMPORTS, RELAY_MAX_COST_LAMPORTS.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  SHIELDED_POOL_PROGRAM_ID, SOL_MINT, ShieldedKeypair, SigningKey, Wallet, createSprClient, getPrivateTransactions,
  syncWallet,
} from "@heliuslabs/spr";
import { LocalKeys, SignedTeePolicy } from "@heliuslabs/spr/client";
import { bytes32, initializePoseidon, isPoseidonInitialized } from "@heliuslabs/spr/keypair";
import {
  address, createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder, getBase64Encoder, getBase64Decoder,
  getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, getSignatureFromTransaction,
  getTransactionDecoder, partiallySignTransaction,
} from "@solana/kit";

const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const unhex = (h) => Uint8Array.from(String(h).match(/../g) ?? [], (b) => parseInt(b, 16));

/** The service fee for pushing `amount`: a share of it, never less than the minimum. Mirrors src/hop.ts relayFee. */
export function relayFee(amount, feeBps, minFee) {
  const share = (amount * BigInt(feeBps)) / 10_000n;
  return share > minFee ? share : minFee;
}

/**
 * The checks that need no network: shape, fee payer, programs, signatures. Returns the problems found (empty = fine)
 * and the decoded pieces the rest of the checks use.
 */
export function inspectRelayTx(wire, relayer, recipient) {
  const problems = [];
  let tx, msg;
  try {
    tx = getTransactionDecoder().decode(wire);
    msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  } catch {
    return { problems: ["The transaction can't be decoded"] };
  }
  const accounts = msg.staticAccounts ?? [];
  if (accounts[0] !== relayer) problems.push("The relayer must be the fee payer");
  // version 1 lists instructions as headers + payloads; legacy and v0 as one array
  const programs = msg.instructionHeaders
    ? msg.instructionHeaders.map((i) => accounts[i.programAccountIndex])
    : (msg.instructions ?? []).map((i) => accounts[i.programAddressIndex]);
  if (programs.length !== 1) problems.push("Only one instruction is allowed");
  if (programs.some((p) => p !== SHIELDED_POOL_PROGRAM_ID)) problems.push("Only the Privacy Rings program may be called");
  if (msg.addressTableLookups?.length) problems.push("Address lookup tables aren't allowed");
  if (recipient && !accounts.includes(recipient)) problems.push("The recipient isn't in the transaction");
  for (const [who, sig] of Object.entries(tx.signatures)) {
    if (who !== relayer && !sig) problems.push(`Missing signature from ${who}`);
  }
  if (!(relayer in tx.signatures)) problems.push("The relayer isn't a signer");
  return { problems, tx, msg };
}

export async function createRelay(cfg) {
  const network = cfg.network === "mainnet" ? "mainnet" : "devnet";
  if (!cfg.rpcUrl) throw new Error("RELAY_RPC_URL is required");
  const feeBps = Number(cfg.feeBps ?? 0), minFee = BigInt(cfg.minFeeLamports ?? 0), maxCost = BigInt(cfg.maxCostLamports ?? 0);
  if (!(feeBps >= 0 && feeBps <= 100)) throw new Error("RELAY_FEE_BPS must be 0..100");
  if (maxCost <= 0n) throw new Error("RELAY_MAX_COST_LAMPORTS is required");
  if (minFee < maxCost) throw new Error("RELAY_MIN_FEE_LAMPORTS must cover RELAY_MAX_COST_LAMPORTS, or the relayer loses money");

  const client = await createSprClient({ solanaRpcUrl: cfg.rpcUrl, proverTee: SignedTeePolicy.forNetwork(network) });
  if (!isPoseidonInitialized()) await initializePoseidon();
  const relayer = await createKeyPairSignerFromPrivateKeyBytes(unhex(cfg.relayerSeedHex));
  const treasury = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(bytes32(unhex(cfg.treasurySeedHex))));
  const treasuryWallet = new Wallet({ identity: treasury.shieldedAddress() });
  const treasuryKeys = LocalKeys.fromKeypair(treasury, client.proofService);

  const usedFile = cfg.usedFile;
  const used = new Set(usedFile && existsSync(usedFile) ? JSON.parse(readFileSync(usedFile, "utf8")) : []);
  const saveUsed = () => {
    if (!usedFile) return;
    const tmp = `${usedFile}.tmp`;
    writeFileSync(tmp, JSON.stringify([...used]));
    renameSync(tmp, usedFile);
  };
  const busy = new Set(); // fee signatures being relayed right now

  const info = () => ({
    network,
    relayer: relayer.address,
    treasury: getBase58Decoder().decode(treasury.shieldedAddress().toBytes()),
    feeBps,
    minFeeLamports: minFee.toString(),
  });

  /** SOL the treasury received privately in one transaction. */
  async function feePaidIn(signature) {
    const st = (await client.solanaRpc.getSignatureStatuses([signature]).send()).value[0];
    if (!st || st.err || !["confirmed", "finalized"].includes(st.confirmationStatus ?? "")) return { paid: 0n, reason: "The fee transaction isn't confirmed" };
    const tip = await client.getSlot();
    if (tip - BigInt(st.slot) > 216_000n) return { paid: 0n, reason: "The fee transaction is more than a day old" };
    await syncWallet({ client, wallet: treasuryWallet, keys: treasuryKeys, config: { requireSlot: BigInt(st.slot) } });
    let paid = 0n;
    for (const t of getPrivateTransactions(treasuryWallet)) {
      if (t.id.signature === signature && t.direction === "inbound" && t.asset === SOL_MINT) paid += t.amount;
    }
    return { paid };
  }

  /** Verifies, co-signs and sends a step-B transaction. Throws { status, message } on refusal. */
  async function push(body) {
    const refuse = (status, message) => { throw Object.assign(new Error(message), { status }); };
    const feeSignature = typeof body?.feeSignature === "string" ? body.feeSignature : "";
    const recipient = typeof body?.recipient === "string" ? body.recipient : "";
    const amountText = typeof body?.amount === "string" ? body.amount : "";
    const txText = typeof body?.tx === "string" ? body.tx : "";
    if (!B58.test(feeSignature) || feeSignature.length < 80 || feeSignature.length > 90) refuse(400, "Bad fee signature");
    if (!B58.test(recipient) || recipient.length < 32 || recipient.length > 44) refuse(400, "Bad recipient");
    if (!/^\d{1,20}$/.test(amountText) || BigInt(amountText) <= 0n) refuse(400, "Bad amount");
    if (!txText || txText.length > 8000) refuse(400, "Bad transaction");
    const amount = BigInt(amountText);
    if (used.has(feeSignature) || busy.has(feeSignature)) refuse(409, "That fee already paid for a push");

    const wire = new Uint8Array(getBase64Encoder().encode(txText));
    const { problems, tx, msg } = inspectRelayTx(wire, relayer.address, address(recipient));
    if (problems.length) refuse(400, problems[0]);

    busy.add(feeSignature);
    try {
      // the fee: A paid the treasury enough for this amount
      const want = relayFee(amount, feeBps, minFee);
      const { paid, reason } = await feePaidIn(feeSignature);
      if (reason) refuse(402, reason);
      if (paid < want) refuse(402, `The fee paid (${paid}) is less than ${want} lamports`);

      // the cost: network fee plus what the simulation takes from the relayer, and the recipient gets exactly `amount`
      const rpc = client.solanaRpc;
      const messageB64 = getBase64Decoder().decode(tx.messageBytes);
      const netFee = BigInt((await rpc.getFeeForMessage(messageB64).send()).value ?? 0);
      const [relayerBefore, recipientBefore] = await Promise.all([client.getBalance(relayer.address), client.getBalance(address(recipient))]);
      const sim = (await rpc.simulateTransaction(txText, {
        encoding: "base64", sigVerify: false, replaceRecentBlockhash: false,
        accounts: { encoding: "base64", addresses: [relayer.address, address(recipient)] },
      }).send()).value;
      if (sim.err) refuse(400, `The transaction fails: ${JSON.stringify(sim.err, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
      const after = (sim.accounts ?? []).map((a) => (a ? BigInt(a.lamports) : 0n));
      const spent = relayerBefore - (after[0] ?? relayerBefore);
      const cost = (spent > 0n ? spent : 0n) + netFee;
      if (cost > maxCost) refuse(400, `The push would cost the relayer ${cost} lamports (cap ${maxCost})`);
      const received = (after[1] ?? 0n) - recipientBefore;
      if (received !== amount) refuse(400, `The recipient would get ${received} lamports, not ${amount}`);
      void msg;

      // sign, mark the fee used before sending (a crash after sending must not let it pay twice), send, confirm
      const signed = await partiallySignTransaction([relayer.keyPair], tx);
      const signature = getSignatureFromTransaction(signed);
      used.add(feeSignature);
      saveUsed();
      try {
        await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send();
        await client.confirmTransaction(signature);
      } catch (e) {
        // nothing landed: free the fee so the same push can be retried
        const st = (await rpc.getSignatureStatuses([signature]).send().catch(() => ({ value: [null] }))).value[0];
        if (!st || st.err) { used.delete(feeSignature); saveUsed(); }
        throw e;
      }
      return { signature, cost: cost.toString() };
    } finally {
      busy.delete(feeSignature);
    }
  }

  return { info, push, relayer: relayer.address, client };
}

/** The relayer from environment variables, or null when it isn't configured. */
export async function relayFromEnv(dataDir) {
  const e = process.env;
  if (!e.RELAY_NETWORK) return null;
  return createRelay({
    network: e.RELAY_NETWORK, rpcUrl: e.RELAY_RPC_URL, relayerSeedHex: e.RELAY_SEED_HEX, treasurySeedHex: e.TREASURY_SEED_HEX,
    feeBps: e.RELAY_FEE_BPS, minFeeLamports: e.RELAY_MIN_FEE_LAMPORTS, maxCostLamports: e.RELAY_MAX_COST_LAMPORTS,
    usedFile: dataDir ? `${dataDir}/relay-used.json` : undefined,
  });
}
