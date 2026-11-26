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

/** A fee is configured (treasury and rate), whether or not it has started. */
export const feeConfigured = (p: ActiveProduct): boolean => !!p.treasury && p.feeBps > 0;
/** The configured fee applies at `now`. */
export const feeStarted = (p: ActiveProduct, now = Date.now()): boolean => feeConfigured(p) && now >= p.feeStartsAt;

/** fee = floor(amount * feeBps / 10000), capped, then reduced by the tier discount. Zero before the fee's start time. */
export function computeFee(p: ActiveProduct, amount: bigint, discountBps: number, now = Date.now()): FeeBreakdown {
  if (!feeStarted(p, now) || amount <= 0n) return { gross: 0n, fee: 0n, discountBps };
  let gross = (amount * BigInt(p.feeBps)) / 10_000n;
  if (p.feeCapLamports > 0n && gross > p.feeCapLamports) gross = p.feeCapLamports;
  const fee = gross - (gross * BigInt(discountBps)) / 10_000n;
  return { gross, fee, discountBps };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "28 Nov 2026, 17:30 UTC": the same text everywhere the start time is shown. */
export function fmtUtc(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

/** Rent-exempt minimum for a 0-data account. A transfer below this to a nonexistent account fails. */
export const MIN_NEW_ACCOUNT_LAMPORTS = 890_880n;
