// Staking: lock the product token in a Streamflow stake pool so it counts toward the tier.
//  - reading a stake uses a plain RPC lookup + our own decoder (cheap, used on every tier check);
//  - staking/unstaking uses the official @streamflow/staking SDK, which builds the account-heavy instructions.
// The pool is fixed in src/product.ts, so nothing in a message from the popup can point funds at another program.
import { Keypair } from "@solana/web3.js";
import { ICluster } from "@streamflow/common";
import { SolanaStakingClient } from "@streamflow/staking";
import BN from "bn.js";
import { address } from "@solana/kit";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { FEE_RESERVE_LAMPORTS, rpcUrl, type Settings } from "./config";
import type { ActiveProduct } from "./product";
import {
  OFFSET_PAYER,
  OFFSET_STAKE_POOL,
  STAKE_POOL_PROGRAM_ID,
  decodeStakeEntry,
  isActiveEntry,
  unlockTs,
  type StakeEntryInfo,
} from "./stakeEntry";
import { publicBalance, sendAndConfirmFactory, tokenBalanceOf, tokenProgramOf, type VaultHandle } from "./spr";

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** All open stake entries `owner` has in `pool`. */
export async function stakeEntriesOf(h: VaultHandle, owner: string, pool: string): Promise<StakeEntryInfo[]> {
  const res = (await h.client.solanaRpc
    .getProgramAccounts(address(STAKE_POOL_PROGRAM_ID), {
      encoding: "base64",
      filters: [
        { memcmp: { offset: BigInt(OFFSET_STAKE_POOL), bytes: pool as never, encoding: "base58" } },
        { memcmp: { offset: BigInt(OFFSET_PAYER), bytes: owner as never, encoding: "base58" } },
      ],
    })
    .send()) as unknown as { account: { data: [string, string] } }[];
  const out: StakeEntryInfo[] = [];
  for (const a of res) {
    try {
      const e = decodeStakeEntry(b64(a.account.data[0]));
      if (isActiveEntry(e)) out.push(e);
    } catch {
      /* not a stake entry */
    }
  }
  return out.sort((a, b) => a.nonce - b.nonce);
}

export async function stakedAmountOf(h: VaultHandle, owner: string, p: ActiveProduct): Promise<bigint> {
  if (!p.staking) return 0n;
  return (await stakeEntriesOf(h, owner, p.staking.pool)).reduce((s, e) => s + e.amount, 0n);
}

export interface StakeView {
  total: string;
  entries: { amount: string; unlockTs: number }[];
}
export async function stakeView(h: VaultHandle, owner: string, p: ActiveProduct): Promise<StakeView | null> {
  if (!p.staking) return null;
  const es = await stakeEntriesOf(h, owner, p.staking.pool);
  return {
    total: es.reduce((s, e) => s + e.amount, 0n).toString(),
    entries: es.map((e) => ({ amount: e.amount.toString(), unlockTs: Number(unlockTs(e)) })),
  };
}

function sdk(settings: Settings): SolanaStakingClient {
  return new SolanaStakingClient({
    clusterUrl: rpcUrl(settings),
    cluster: settings.network === "mainnet" ? ICluster.Mainnet : ICluster.Devnet,
    commitment: "confirmed",
  });
}

/** SDK signer for the vault key. Verified to be the same address the rest of the extension uses. */
function invokerFor(h: VaultHandle, seed: Uint8Array): Keypair {
  const kp = Keypair.fromSeed(seed.slice(0, 32));
  if (kp.publicKey.toBase58() !== h.address) throw new Error("Internal error: staking key does not match the gateway address");
  return kp;
}

function requireStaking(p: ActiveProduct) {
  if (!p.staking || !p.token) throw new Error("Staking is not set up on this network");
  return { staking: p.staking, token: p.token };
}

export async function stakeTokens(
  h: VaultHandle,
  seed: Uint8Array,
  settings: Settings,
  p: ActiveProduct,
  amount: bigint,
): Promise<{ signature: string; amount: bigint; lockSeconds: number }> {
  const { staking, token } = requireStaking(p);
  if (amount <= 0n) throw new Error("Amount must be greater than zero");
  const held = await tokenBalanceOf(h, h.address, token.mint);
  if (held < amount) throw new Error(`The gateway holds ${held} ${token.symbol} (smallest units); not enough to stake that`);
  const pub = await publicBalance(h);
  if (pub < FEE_RESERVE_LAMPORTS) {
    throw new Error(`Gateway needs about ${FEE_RESERVE_LAMPORTS} lamports of public SOL for fees and account rent; it has ${pub}`);
  }

  const client = sdk(settings);
  const pool = await client.getStakePool(staking.pool);
  if (pool.mint.toBase58() !== token.mint) throw new Error("The configured stake pool is for a different token");
  const lock = Math.min(Math.max(staking.lockSeconds, pool.minDuration.toNumber()), pool.maxDuration.toNumber());

  // The pool's receipt token account must exist before staking (the SDK doesn't create it).
  const stakeMint = pool.stakeMint.toBase58();
  const receiptProgram = await tokenProgramOf(h, stakeMint);
  const [ata] = await findAssociatedTokenPda({ owner: address(h.address), mint: address(stakeMint), tokenProgram: receiptProgram });
  await sendAndConfirmFactory(h)([
    getCreateAssociatedTokenIdempotentInstruction({ payer: h.signer, ata, owner: address(h.address), mint: address(stakeMint), tokenProgram: receiptProgram }),
  ]);

  // Each stake is its own entry; use the first nonce this vault hasn't used in the pool.
  const used = new Set((await stakeEntriesOf(h, h.address, staking.pool)).map((e) => e.nonce));
  let nonce = 0;
  while (used.has(nonce)) nonce++;

  const r = await client.stake(
    { nonce, amount: new BN(amount.toString()), duration: new BN(lock), stakePool: staking.pool, stakePoolMint: token.mint },
    { invoker: invokerFor(h, seed) },
  );
  return { signature: r.txId, amount, lockSeconds: lock };
}

/** Unstakes every entry whose lock has ended. Entries still locked are left alone. */
export async function unstakeUnlocked(
  h: VaultHandle,
  seed: Uint8Array,
  settings: Settings,
  p: ActiveProduct,
): Promise<{ signatures: string[]; amount: bigint }> {
  const { staking, token } = requireStaking(p);
  const pub = await publicBalance(h);
  if (pub < FEE_RESERVE_LAMPORTS) {
    throw new Error(`Gateway needs about ${FEE_RESERVE_LAMPORTS} lamports of public SOL for fees; it has ${pub}`);
  }
  const entries = await stakeEntriesOf(h, h.address, staking.pool);
  if (entries.length === 0) throw new Error("Nothing is staked");
  const now = BigInt(Math.floor(Date.now() / 1000));
  const ready = entries.filter((e) => unlockTs(e) <= now);
  if (ready.length === 0) {
    const soonest = entries.reduce((m, e) => (unlockTs(e) < m ? unlockTs(e) : m), unlockTs(entries[0]!));
    throw new Error(`Still locked. The earliest stake unlocks in ${Number(soonest - now)} seconds.`);
  }
  const client = sdk(settings);
  const invoker = invokerFor(h, seed);
  const signatures: string[] = [];
  let total = 0n;
  for (const e of ready) {
    const r = await client.unstake({ nonce: e.nonce, stakePool: staking.pool, stakePoolMint: token.mint, shouldClose: true }, { invoker });
    signatures.push(r.txId);
    total += e.amount;
  }
  return { signatures, amount: total };
}
