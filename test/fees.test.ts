import assert from "node:assert/strict";
import { computeFee, feeStarted, fmtUtc, tierForBalance } from "../src/fees";
import { activeProduct, MAX_FEE_BPS, PRODUCT } from "../src/product";
import type { ActiveProduct } from "../src/product";

const T = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const base: ActiveProduct = {
  treasury: T, feeBps: 20, feeCapLamports: 50_000_000n, token: { mint: T, symbol: "TST", decimals: 6 },
  tiers: [
    { name: "Bronze", min: 1_000n, discountBps: 2_500 },
    { name: "Silver", min: 10_000n, discountBps: 5_000 },
    { name: "Gold", min: 100_000n, discountBps: 10_000 },
  ],
  burnPerPush: 100n, extraDestinationsMinTier: 1, maxExtraDestinations: 5,
  feeStartsAt: 0, tierSource: "holding", staking: null,
};
const SOL = 1_000_000_000n;

// 0.2% of 10 SOL = 0.02 SOL, no discount
assert.equal(computeFee(base, 10n * SOL, 0).fee, 20_000_000n);
// cap: 0.2% of 1000 SOL = 2 SOL -> capped at 0.05 SOL
assert.equal(computeFee(base, 1000n * SOL, 0).fee, 50_000_000n);
// discount applies after the cap: 50% off of capped 0.05 = 0.025
assert.equal(computeFee(base, 1000n * SOL, 5_000).fee, 25_000_000n);
// 100% discount -> zero fee, gross still reported
const free = computeFee(base, 10n * SOL, 10_000);
assert.equal(free.fee, 0n); assert.equal(free.gross, 20_000_000n);
// floor rounding never exceeds the exact fee: 1 lamport * 20 / 10000 = 0
assert.equal(computeFee(base, 1n, 0).fee, 0n);
// no treasury -> no fee ever
assert.equal(computeFee({ ...base, treasury: null }, 10n * SOL, 0).fee, 0n);
// feeBps 0 -> no fee
assert.equal(computeFee({ ...base, feeBps: 0 }, 10n * SOL, 0).fee, 0n);
// zero / negative amount -> no fee
assert.equal(computeFee(base, 0n, 0).fee, 0n);

// start time: nothing before it, the full fee from that millisecond on
const START = Date.parse("2026-11-28T17:30:00Z");
const timed = { ...base, feeStartsAt: START };
assert.equal(computeFee(timed, 10n * SOL, 0, START - 1).fee, 0n);
assert.equal(computeFee(timed, 10n * SOL, 0, START - 1).gross, 0n);
assert.equal(computeFee(timed, 10n * SOL, 0, START).fee, 20_000_000n);
assert.equal(feeStarted(timed, START - 1), false);
assert.equal(feeStarted(timed, START), true);
assert.equal(feeStarted({ ...timed, treasury: null }, START), false);
assert.equal(fmtUtc(START), "28 Nov 2026, 17:30 UTC");

// tiers
assert.equal(tierForBalance(base, 0n).level, 0);
assert.equal(tierForBalance(base, 999n).level, 0);
assert.equal(tierForBalance(base, 1_000n).name, "Bronze");
assert.equal(tierForBalance(base, 50_000n).name, "Silver");
assert.equal(tierForBalance(base, 10n ** 12n).name, "Gold");
assert.equal(tierForBalance(base, 10_000n).discountBps, 5_000);

// config guards: default is fully OFF; absurd fee is clamped; bad addresses disable features; bad start times keep it off
const off = activeProduct("devnet");
assert.equal(off.treasury, null); assert.equal(off.feeBps, 0); assert.equal(off.feeStartsAt, 0);
const live = PRODUCT.mainnet;
PRODUCT.mainnet = { ...live, feeStartsAt: "tomorrow" };
assert.equal(activeProduct("mainnet").feeStartsAt, Number.MAX_SAFE_INTEGER); // unreadable start -> never starts
PRODUCT.mainnet = { ...live, feeStartsAt: "2026-11-26T22:40:00+02:00" };
assert.equal(activeProduct("mainnet").feeStartsAt, Number.MAX_SAFE_INTEGER); // only UTC ("Z") is accepted
PRODUCT.mainnet = { ...live, feeStartsAt: "2026-11-28T17:30:00Z" };
assert.equal(activeProduct("mainnet").feeStartsAt, START);
PRODUCT.mainnet = live;
PRODUCT.devnet = { ...PRODUCT.devnet, treasury: T, feeBps: 5_000, token: { mint: "not-an-address", symbol: "X", decimals: 6 }, tiers: [{ name: "a", minAmount: "1", discountBps: 99_999 }] };
const clamped = activeProduct("devnet");
assert.equal(clamped.feeBps, MAX_FEE_BPS);
assert.equal(clamped.token, null); assert.equal(clamped.tiers.length, 0); // invalid mint disables token features
PRODUCT.devnet = { ...PRODUCT.devnet, treasury: "garbage", feeBps: 20, token: { mint: T, symbol: "X", decimals: 6 }, tiers: [{ name: "a", minAmount: "1", discountBps: 99_999 }] };
const c2 = activeProduct("devnet");
assert.equal(c2.treasury, null);              // invalid treasury -> fees disabled
assert.equal(c2.tiers[0]?.discountBps, 10_000); // discount clamped to 100%
console.log("fee/tier/config tests passed");
