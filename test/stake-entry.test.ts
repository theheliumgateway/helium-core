import assert from "node:assert/strict";
import { decodeStakeEntry, isActiveEntry, unlockTs } from "../src/stakeEntry";

// Build an account the way the program lays it out (offsets verified against a live devnet entry).
const buf = new Uint8Array(224);
const v = new DataView(buf.buffer);
v.setUint32(8, 3, true);                 // nonce
v.setBigUint64(108, 1_500_000_000n, true); // amount
v.setBigUint64(116, 60n, true);           // duration
v.setBigUint64(140, 1_795_548_286n, true); // created_ts
const e = decodeStakeEntry(buf);
assert.equal(e.nonce, 3);
assert.equal(e.amount, 1_500_000_000n);
assert.equal(e.duration, 60n);
assert.equal(unlockTs(e), 1_795_548_346n);
assert.ok(isActiveEntry(e));
v.setBigUint64(148, 5n, true);           // closed_ts set -> no longer counts
assert.ok(!isActiveEntry(decodeStakeEntry(buf)));
v.setBigUint64(148, 0n, true); v.setBigUint64(172, 9n, true); // unstake requested -> no longer counts
assert.ok(!isActiveEntry(decodeStakeEntry(buf)));
assert.throws(() => decodeStakeEntry(new Uint8Array(50)), /Not a stake entry/);
console.log("stake entry decoder tests passed");
