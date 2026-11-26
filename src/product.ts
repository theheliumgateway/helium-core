// Product configuration: the service fee, the token, and tiers. Edit this file and rebuild.
//
// Everything is OFF until filled in: an empty treasury means no fee is ever charged, and a null token disables
// discounts, burn-to-pay and tier-gated features. Devnet and mainnet are configured separately so a test token
// never gets mixed up with the real one.
//
// Transparency: the fee, discount and burn are always shown on the push review screen and are visible on-chain.
// This is client-side configuration in an open-source extension; anyone can fork it and change or remove the fee.
import { isAddress } from "@solana/kit";
import type { Network } from "./config";

export interface TierDef {
  name: string;
  /** Minimum token amount held, in the token's smallest units, as a decimal string. */
  minAmount: string;
  /** Fee discount for this tier in basis points (5000 = 50% off, 10000 = no fee). */
  discountBps: number;
}

export interface TokenDef {
  mint: string;
  symbol: string;
  decimals: number;
}

/** A Streamflow staking pool for the product token (https://streamflow.finance). Tokens staked here count toward the tier. */
export interface StakingDef {
  /** Address of the stake pool account. */
  pool: string;
  /** How long a new stake is locked, in seconds. Clamped to the pool's own min/max at stake time. */
  lockSeconds: number;
}

/** Where the tier comes from. "staking" avoids the burn-lowers-tier conflict and can't be gamed by borrowing tokens. */
export type TierSource = "holding" | "staking" | "both";

export interface ProductConfig {
  /** Wallet that receives the fee. Empty string = fees disabled. Use an existing, funded wallet. */
  treasury: string;
  /** Fee as basis points of the pushed amount (10 = 0.1%). Hard-capped at MAX_FEE_BPS. */
  feeBps: number;
  /** Maximum fee per push in lamports, as a decimal string. "0" = no cap. */
  feeCapLamports: string;
  /** The product token. null = no token features. */
  token: TokenDef | null;
  /** Tier source: tokens held in the vault wallet, tokens staked in `staking`, or both added together. */
  tierSource: TierSource;
  /** Staking pool. null = staking disabled (tierSource then falls back to "holding"). */
  staking: StakingDef | null;
  /** Holder tiers, any order (sorted ascending by minAmount at load). Tier level 1 = lowest. */
  tiers: TierDef[];
  /** Tokens burned per push when the user chooses to pay in tokens (smallest units). "0" = disabled. */
  burnPerPush: string;
  /** Minimum tier level required to save extra push destinations. 0 = open to everyone. */
  extraDestinationsMinTier: number;
  /** How many extra destinations (besides the main wallet) a user may save. */
  maxExtraDestinations: number;
}

/** No config can exceed this, so a typo can't turn the fee into a drain. 50 bps = 0.5%. */
export const MAX_FEE_BPS = 50;

const OFF: ProductConfig = {
  treasury: "",
  feeBps: 0,
  feeCapLamports: "0",
  token: null,
  tierSource: "holding",
  staking: null,
  tiers: [],
  burnPerPush: "0",
  extraDestinationsMinTier: 0,
  maxExtraDestinations: 5,
};

export const PRODUCT: Record<Network, ProductConfig> = {
  devnet: {
    ...OFF,
    // TST: a worthless test token on DEVNET (6 decimals). Created by `npm run devnet:create-token`;
    // its mint address is recorded in devnet/tst.json.
    token: { mint: "75nEKAdR6u1LYz1p1E6Ef87jpcW7ZL4wbZ86eeC8z7LY", symbol: "TST", decimals: 6 },
    // Tier now comes from TST STAKED in this devnet pool (created by scripts/create-tst-pool.mjs; see devnet/tst-pool.json).
    tierSource: "staking",
    staking: { pool: "hc4EPyAGbe3UJwERv5W6uXoPjb6YwRmS7yAdVy68y7f", lockSeconds: 60 },
    tiers: [
      { name: "Bronze", minAmount: "1000000000", discountBps: 2500 }, //     1,000 TST -> 25% off
      { name: "Silver", minAmount: "10000000000", discountBps: 5000 }, //   10,000 TST -> 50% off
      { name: "Gold", minAmount: "100000000000", discountBps: 10000 }, // 100,000 TST -> free
    ],
    burnPerPush: "100000000", // 100 TST
    // To test the fee on devnet, set a funded devnet wallet you control and a rate:
    // treasury: "<devnet wallet>",
    // feeBps: 10,                // 0.1% of the pushed amount
    // feeCapLamports: "20000000", // never more than 0.02 SOL per push
    // extraDestinationsMinTier: 1,
  },
  mainnet: { ...OFF },
};

/** A validated, normalized view of the config. Anything invalid quietly disables just that feature. */
export interface ActiveProduct {
  treasury: string | null;
  feeBps: number;
  feeCapLamports: bigint;
  token: TokenDef | null;
  tierSource: TierSource;
  staking: StakingDef | null;
  tiers: { name: string; min: bigint; discountBps: number }[];
  burnPerPush: bigint;
  extraDestinationsMinTier: number;
  maxExtraDestinations: number;
}

const big = (s: string): bigint => (/^\d+$/.test(s) ? BigInt(s) : 0n);

export function activeProduct(network: Network): ActiveProduct {
  const c = PRODUCT[network];
  const token = c.token && isAddress(c.token.mint) && c.token.decimals >= 0 && c.token.decimals <= 12 ? c.token : null;
  const tiers = token
    ? c.tiers
        .map((t) => ({ name: t.name, min: big(t.minAmount), discountBps: Math.min(10_000, Math.max(0, Math.floor(t.discountBps))) }))
        .filter((t) => t.min > 0n)
        .sort((a, b) => (a.min < b.min ? -1 : a.min > b.min ? 1 : 0))
    : [];
  const staking =
    token && c.staking && isAddress(c.staking.pool) && c.staking.lockSeconds > 0
      ? { pool: c.staking.pool, lockSeconds: Math.floor(c.staking.lockSeconds) }
      : null;
  return {
    tierSource: staking ? c.tierSource : "holding",
    staking,
    treasury: c.treasury && isAddress(c.treasury) ? c.treasury : null,
    feeBps: Math.min(MAX_FEE_BPS, Math.max(0, Math.floor(c.feeBps))),
    feeCapLamports: big(c.feeCapLamports),
    token,
    tiers,
    burnPerPush: token ? big(c.burnPerPush) : 0n,
    extraDestinationsMinTier: Math.max(0, Math.floor(c.extraDestinationsMinTier)),
    maxExtraDestinations: Math.max(0, Math.floor(c.maxExtraDestinations)),
  };
}
