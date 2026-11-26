// Relayed push (prototype, devnet first): SOL leaves the pool without naming the gateway.
//
// Why a hop: every spend from the pool publishes its owner's key (as a transaction signer, or in the proof data on the
// in-proof rail), so a push the gateway makes itself names the gateway. Instead:
//   A. the gateway sends the amount privately to a one-time key of its own, plus the service fee privately to Helium's
//      treasury, in one private transfer. Public: the gateway made a private transfer. Hidden: who got what.
//   B. the one-time key withdraws the amount to the destination. Helium's relayer pays the network fee, so the one-time
//      key needs no public SOL (funding it would link it). Public: a fresh key withdrew to the destination.
// The relayer only signs B after checking that A paid the fee to the treasury (server/relay.mjs).
//
// One-time keys are derived from the gateway seed and a counter, so the recovery key can always find SOL left on one.
// This file imports nothing relative at runtime, so Node can load it straight from test scripts.
import {
  SOL_MINT, ShieldedAddress, ShieldedKeypair, SigningKey, Wallet, buildMultiTransferTransaction,
  buildWithdrawalTransaction, syncWallet,
} from "@heliuslabs/spr";
import { atSlot, LocalKeys } from "@heliuslabs/spr/client";
import { bytes32 } from "@heliuslabs/spr/keypair";
import {
  address, getBase58Encoder, getBase64EncodedWireTransaction, getSignatureFromTransaction,
  partiallySignTransactionWithSigners, signTransactionWithSigners,
} from "@solana/kit";
import type { VaultHandle } from "./spr";

/** What the relayer publishes at /api/relay/info. */
export interface RelayInfo {
  network: "devnet" | "mainnet";
  /** Pays the network fee of step B. */
  relayer: string;
  /** Helium's private address: step A pays the service fee to it. */
  treasury: string;
  feeBps: number;
  /** The fee never goes below this, so the relayer's own cost (network fee and rent) is always covered. */
  minFeeLamports: string;
}

/** The service fee for pushing `amount`: a share of it, never less than the minimum. */
export function relayFee(amount: bigint, info: Pick<RelayInfo, "feeBps" | "minFeeLamports">): bigint {
  const share = (amount * BigInt(info.feeBps)) / 10_000n;
  const min = BigInt(info.minFeeLamports);
  return share > min ? share : min;
}

/** The one-time key's seed: sha256("helium/hop/v1" || gateway seed || index). */
export async function hopSeed(seed: Uint8Array, index: number): Promise<Uint8Array> {
  if (!Number.isInteger(index) || index < 0 || index > 0xffff_ffff) throw new Error("Bad one-time key index");
  const tag = new TextEncoder().encode("helium/hop/v1");
  const msg = new Uint8Array(tag.length + seed.length + 4);
  msg.set(tag, 0);
  msg.set(seed, tag.length);
  new DataView(msg.buffer).setUint32(tag.length + seed.length, index, false);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", msg));
}

export async function hopKey(h: Pick<VaultHandle, "client">, seed: Uint8Array, index: number) {
  const keypair = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(bytes32(await hopSeed(seed, index))));
  const signer = keypair.toSolanaSigner();
  return {
    index, keypair, signer, address: signer.address,
    wallet: new Wallet({ identity: keypair.shieldedAddress() }),
    keys: LocalKeys.fromKeypair(keypair, h.client.proofService),
  };
}

export async function relayInfo(relayUrl: string): Promise<RelayInfo> {
  const r = await fetch(`${relayUrl}/info`, { cache: "no-store" });
  if (!r.ok) throw new Error(`The relayer isn't available (${r.status})`);
  return (await r.json()) as RelayInfo;
}

export interface RelayedPushResult {
  /** Step A, the private transfer the gateway signed (names the gateway, hides amounts and recipients). */
  hopSignature: string;
  /** Step B, the withdrawal the relayer sent (names only the one-time key). */
  signature: string;
  fee: bigint;
  hopAddress: string;
  /** The two transactions as sent (base64 wire format), for checking what they reveal. */
  wire: { hop: string; withdrawal: string };
}

/**
 * Pushes `amount` to `to` through a one-time key and the relayer. `to` must already be a saved destination: the caller
 * (the worker) checks that, as for an ordinary push. `onStep` reports progress for the screen.
 */
export async function relayedPush(
  h: VaultHandle,
  seed: Uint8Array,
  hopIndex: number,
  to: string,
  amount: bigint,
  relayUrl: string,
  opts: { network: "devnet" | "mainnet"; delayMs?: number; onStep?: (step: string) => void } = { network: "devnet" },
): Promise<RelayedPushResult> {
  if (amount <= 0n) throw new Error("Amount must be greater than zero");
  const step = opts.onStep ?? (() => {});
  const info = await relayInfo(relayUrl);
  if (info.network !== opts.network) throw new Error(`The relayer is on ${info.network}, the gateway on ${opts.network}`);
  const fee = relayFee(amount, info);
  const treasury = ShieldedAddress.fromBytes(new Uint8Array(getBase58Encoder().encode(info.treasury)));
  const hop = await hopKey(h, seed, hopIndex);

  // A. gateway -> one-time key (amount) + treasury (fee), one private transfer the gateway signs and pays for
  step("Moving the amount to a one-time key");
  await syncWallet({ client: h.client, wallet: h.wallet, keys: h.keys });
  const txA = await buildMultiTransferTransaction({
    client: h.client, wallet: h.wallet, keys: h.keys, feePayer: h.signer.address,
    payments: [
      { recipient: hop.keypair.shieldedAddress(), amount },
      { recipient: treasury, amount: fee },
    ],
  });
  const signedA = await signTransactionWithSigners([h.signer], txA);
  const hopSignature = getSignatureFromTransaction(signedA);
  await h.client.solanaRpc
    .sendTransaction(getBase64EncodedWireTransaction(signedA), { encoding: "base64", preflightCommitment: "confirmed" })
    .send();
  const slotA = await h.client.confirmTransaction(hopSignature);
  await h.client.getShieldedTransactionsBySignature(hopSignature, atSlot(slotA));

  // a pause between A and B makes them harder to pair up by timing
  if (opts.delayMs && opts.delayMs > 0) await new Promise((r) => setTimeout(r, opts.delayMs));

  // B. one-time key -> destination; the relayer pays and co-signs after checking A
  step("Sending through the relayer");
  await syncWallet({ client: h.client, wallet: hop.wallet, keys: hop.keys, config: { requireSlot: slotA } });
  const held = hop.wallet.balance(SOL_MINT).amount;
  if (held < amount) throw new Error(`The one-time key holds ${held} lamports, expected ${amount}`);
  const txB = await buildWithdrawalTransaction({
    client: h.client, wallet: hop.wallet, keys: hop.keys, feePayer: address(info.relayer),
    recipient: address(to), amount,
  });
  const partB = await partiallySignTransactionWithSigners([hop.signer], txB);
  const wireB = getBase64EncodedWireTransaction(partB);
  const r = await fetch(`${relayUrl}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ feeSignature: hopSignature, amount: amount.toString(), recipient: to, tx: wireB }),
  });
  const out = (await r.json().catch(() => ({}))) as { signature?: string; error?: string };
  if (!r.ok || !out.signature) {
    // the SOL stays on the one-time key (index hopIndex) and the fee stays unused: the same push can be retried
    throw new Error(out.error ?? `The relayer refused the push (${r.status})`);
  }
  return {
    hopSignature, signature: out.signature, fee, hopAddress: hop.address,
    wire: { hop: getBase64EncodedWireTransaction(signedA), withdrawal: wireB },
  };
}
