// Signed token settings (src/remote.ts): only a correctly signed, well-formed, newer file is accepted.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { getAddressDecoder } from "@solana/kit";
import { parseTokenConfig, verifyTokenConfig } from "../src/remote";
import { activeProduct, applyTokenSettings, PRODUCT } from "../src/product";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const KEY = getAddressDecoder().decode(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
const other = generateKeyPairSync("ed25519").privateKey;
const signed = (obj: object, k = privateKey) => {
  const payload = JSON.stringify(obj);
  return { payload, signature: sign(null, Buffer.from(payload), k).toString("base64") };
};
const MINT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", POOL = "hc4EPyAGbe3UJwERv5W6uXoPjb6YwRmS7yAdVy68y7f";
const good = {
  v: 1, network: "mainnet", issued: Date.parse("2026-11-27T12:00:00Z"),
  token: { mint: MINT, symbol: "HELIUM", decimals: 6 },
  staking: { pool: POOL, lockSeconds: 14 * 86_400 },
  tiers: [
    { name: "Bronze", minAmount: "100000000000", discountBps: 2500 },
    { name: "Silver", minAmount: "1000000000000", discountBps: 5000 },
    { name: "Gold", minAmount: "10000000000000", discountBps: 10000 },
  ],
  burnPerPush: "1000000000",
};
const rejects = async (file: unknown, why: RegExp, name: string) => {
  await assert.rejects(verifyTokenConfig(file, KEY), why, name);
};

const ok = await verifyTokenConfig(signed(good), KEY);
assert.equal(ok.token.mint, MINT); assert.equal(ok.tiers.length, 3); assert.equal(ok.staking.lockSeconds, 1_209_600);

await rejects(signed(good, other), /bad signature/, "signed by another key");
const s = signed(good);
await rejects({ ...s, payload: s.payload.replace("2500", "9999") }, /bad signature/, "payload changed after signing");
await rejects({ payload: s.payload }, /malformed/, "no signature");
await rejects(signed({ ...good, network: "devnet" }), /network/, "wrong network");
await rejects(signed({ ...good, v: 2 }), /version/, "unknown version");
await rejects(signed({ ...good, token: { ...good.token, mint: "nope" } }), /token/, "bad mint");
await rejects(signed({ ...good, token: { ...good.token, symbol: "<script>" } }), /token/, "bad symbol");
await rejects(signed({ ...good, staking: { ...good.staking, lockSeconds: 60 } }), /staking/, "lock under a day");
await rejects(signed({ ...good, tiers: [] }), /tiers/, "no tiers");
await rejects(signed({ ...good, tiers: [{ name: "Gold", minAmount: "0", discountBps: 10000 }] }), /tier/, "tier at zero");
await rejects(signed({ ...good, tiers: [{ name: "Gold", minAmount: "1", discountBps: 10001 }] }), /tier/, "discount over 100%");
await rejects(signed({ ...good, burnPerPush: "-1" }), /burnPerPush/, "bad burn");
// fee settings can't ride along: unknown fields are dropped, never applied
const withFee = parseTokenConfig(JSON.stringify({ ...good, treasury: MINT, feeBps: 50 }));
assert.equal("treasury" in withFee, false); assert.equal("feeBps" in withFee, false);

// applying: the coin, pool and tiers change; the fee and treasury don't
const before = activeProduct("mainnet");
applyTokenSettings("mainnet", { token: ok.token, staking: ok.staking, tiers: ok.tiers, burnPerPush: ok.burnPerPush });
const after = activeProduct("mainnet");
assert.equal(after.token?.mint, MINT); assert.equal(after.staking?.pool, POOL); assert.equal(after.tierSource, "staking");
assert.equal(after.tiers.length, 3); assert.equal(after.burnPerPush, 1_000_000_000n);
assert.equal(after.treasury, before.treasury); assert.equal(after.feeBps, before.feeBps); assert.equal(after.feeStartsAt, before.feeStartsAt);
assert.equal(PRODUCT.mainnet.feeCapLamports, "200000000");
console.log("token settings tests passed");
