// Pure fee/tier math (no I/O) so it can be unit-tested.
import type { ActiveProduct } from "./product";

export interface TierResult {
  /** 0 = no tier; 1..n = index+1 into the ascending tier list. */
  level: number;
  name: string;
  discountBps: number;
  /** Token amount counted toward the tier (smallest units). */
  held: bigint;
}

export const NO_TIER: TierResult = { level: 0, name: "None", discountBps: 0, held: 0n };

export function tierForBalance(p: ActiveProduct, held: bigint): TierResult {
  let result: TierResult = { ...NO_TIER, held };
  p.tiers.forEach((t, i) => {
    if (held >= t.min) result = { level: i + 1, name: t.name, discountBps: t.discountBps, held };
  });
  return result;
}

export interface FeeBreakdown {
  /** Fee before any discount. */
  gross: bigint;
  /** Fee actually charged in SOL (lamports). 0 when no treasury is configured. */
  fee: bigint;
  discountBps: number;
}

/** fee = floor(amount * feeBps / 10000), capped, then reduced by the tier discount. */
export function computeFee(p: ActiveProduct, amount: bigint, discountBps: number): FeeBreakdown {
  if (!p.treasury || p.feeBps === 0 || amount <= 0n) return { gross: 0n, fee: 0n, discountBps };
  let gross = (amount * BigInt(p.feeBps)) / 10_000n;
  if (p.feeCapLamports > 0n && gross > p.feeCapLamports) gross = p.feeCapLamports;
  const fee = gross - (gross * BigInt(discountBps)) / 10_000n;
  return { gross, fee, discountBps };
}

/** Rent-exempt minimum for a 0-data account. A transfer below this to a nonexistent account fails. */
export const MIN_NEW_ACCOUNT_LAMPORTS = 890_880n;
