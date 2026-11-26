import assert from "node:assert/strict";
import { NETWORK_FEE_LAMPORTS as FEE, RENT_EXEMPT_MIN as MIN, planPublicSend } from "../src/sweep";

const SOL = 1_000_000_000n;
// send everything: amount = balance - fee, nothing left
let p = planPublicSend(2n * SOL, "all", 5n * SOL);
assert.equal(p.amount, 2n * SOL - FEE); assert.equal(p.remaining, 0n);
// partial leaving plenty
p = planPublicSend(2n * SOL, 1n * SOL, 5n * SOL);
assert.equal(p.amount, 1n * SOL); assert.equal(p.remaining, 1n * SOL - FEE);
// partial leaving exactly zero after fee is allowed
p = planPublicSend(1n * SOL, 1n * SOL - FEE, 5n * SOL);
assert.equal(p.remaining, 0n);
// partial leaving dust below rent-exempt min is rejected
assert.throws(() => planPublicSend(2n * SOL, 2n * SOL - FEE - 1000n, 5n * SOL), /tiny remainder/);
assert.throws(() => planPublicSend(2n * SOL, 2n * SOL - FEE - (MIN - 1n), 5n * SOL), /tiny remainder/);
// remainder exactly at the minimum is fine
p = planPublicSend(2n * SOL, 2n * SOL - FEE - MIN, 5n * SOL);
assert.equal(p.remaining, MIN);
// amount + fee over balance
assert.throws(() => planPublicSend(1n * SOL, 1n * SOL, 5n * SOL), /Not enough/);
// balance can't even cover the fee
assert.throws(() => planPublicSend(FEE, "all", 5n * SOL), /Nothing to send/);
assert.throws(() => planPublicSend(0n, "all", 5n * SOL), /Nothing to send/);
// brand-new destination needs at least the rent-exempt minimum
assert.throws(() => planPublicSend(1n * SOL, 1000n, 0n), /no SOL yet/);
p = planPublicSend(1n * SOL, MIN, 0n); assert.equal(p.amount, MIN);
// "all" to a new destination is fine when it clears the minimum
p = planPublicSend(1n * SOL, "all", 0n); assert.equal(p.amount, 1n * SOL - FEE);
console.log("public send planner tests passed");
