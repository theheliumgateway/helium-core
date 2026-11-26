// The gateway's worker (src/background.ts): passphrase rules, passkey unlock, passphrase change and auto-lock.
// Runs the real worker code in Node with an in-memory chrome stub. No network: nothing here opens the vault on-chain.
//   node test/vault.test.mjs
import { build } from "esbuild";
import { randomBytes } from "node:crypto";

const out = new URL("./vault-bg.test.cjs", import.meta.url);
await build({
  entryPoints: [new URL("../src/background.ts", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")],
  bundle: true, platform: "node", format: "cjs", outfile: out.pathname.replace(/^\/([A-Z]:)/, "$1"), logLevel: "error",
  define: { global: "globalThis" },
});

const store = {}, mem = {}, alarms = [];
const listeners = [], alarmListeners = [];
globalThis.chrome = {
  runtime: { id: "w", getURL: (p) => `w:/${p}`, onMessage: { addListener: (f) => listeners.push(f) } },
  storage: {
    local: { get: async (k) => ({ [k]: structuredClone(store[k]) }), set: async (o) => Object.assign(store, structuredClone(o)) },
    session: {
      get: async (k) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in mem).map((x) => [x, mem[x]])),
      set: async (o) => Object.assign(mem, o),
      remove: async (k) => { for (const x of Array.isArray(k) ? k : [k]) delete mem[x]; },
    },
  },
  alarms: {
    create: async (name, o) => { alarms.push([name, o.delayInMinutes]); },
    clear: async () => true,
    onAlarm: { addListener: (f) => alarmListeners.push(f) },
  },
};
const { createRequire } = await import("node:module");
createRequire(import.meta.url)(out.pathname.replace(/^\/([A-Z]:)/, "$1"));

const ask = (req) => new Promise((resolve) => listeners[0](req, { id: "w", url: "w:/app" }, resolve));
let failed = 0;
const check = (name, ok, got) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(got)}`}`); if (!ok) failed++; };
const hex = (n) => randomBytes(n).toString("hex");
const b64url = (n) => randomBytes(n).toString("base64url");

const GOOD = "maple-orbit-cactus-lantern";
const BETTER = "tidal 7 velvet quarry zebra";

for (const weak of ["short", "password1234", "aaaaaaaaaaaaaaaa", "qwertyuiop12", "abcdefghijklmn", "Solana123456"]) {
  const r = await ask({ type: "create", passphrase: weak });
  check(`weak passphrase "${weak}" is refused`, r.ok === false && store.vault === undefined, r);
}
let r = await ask({ type: "create", passphrase: GOOD });
check("a four-word passphrase makes a gateway", r.ok && r.data.seedHex?.length === 64, r);
const seedHex = r.data.seedHex;
r = await ask({ type: "status" });
check("new gateway: unlocked, no passkeys, 10-minute auto-lock, passphrase fine", r.ok && r.data.unlocked && r.data.passkeys.length === 0 && r.data.autolockMinutes === 10 && r.data.weakPassphrase === false, r.data);

// passkeys
const pk = { id: b64url(32), salt: b64url(32), prf: hex(32), label: "This device" };
r = await ask({ type: "addPasskey", passphrase: "wrong passphrase here", ...pk });
check("adding a passkey needs the passphrase", r.ok === false && /Wrong passphrase/.test(r.error) && !store.vault.passkeys, r);
r = await ask({ type: "checkPassphrase", passphrase: GOOD });
check("the page can check the passphrase before making a passkey", r.ok, r);
for (const [what, bad] of [["id", { id: "x" }], ["salt", { salt: "short" }], ["key", { prf: "zz" }]]) {
  r = await ask({ type: "addPasskey", passphrase: GOOD, ...pk, ...bad });
  check(`a malformed passkey ${what} is refused`, r.ok === false, r);
}
r = await ask({ type: "addPasskey", passphrase: GOOD, ...pk, label: "Laptop\u0007 Hello" });
check("a passkey is added", r.ok && r.data.passkeys.length === 1 && r.data.passkeys[0].id === pk.id && r.data.passkeys[0].label === "Laptop Hello", r.data?.passkeys);
check("status shows the passkey's id and input, never its wrapped key", r.ok && !("ct" in r.data.passkeys[0]) && !("iv" in r.data.passkeys[0]), r.data?.passkeys);
check("the stored wrap doesn't contain the key material", !JSON.stringify(store.vault).includes(pk.prf) && !JSON.stringify(store.vault).includes(seedHex), null);
r = await ask({ type: "addPasskey", passphrase: GOOD, ...pk });
check("the same passkey can't be added twice", r.ok === false, r);

await ask({ type: "lock" });
r = await ask({ type: "unlockPasskey", id: pk.id, prf: hex(32) });
check("the wrong passkey output doesn't unlock", r.ok === false && mem.seedHex === undefined, r);
r = await ask({ type: "unlockPasskey", id: b64url(32), prf: pk.prf });
check("an unknown passkey doesn't unlock", r.ok === false && mem.seedHex === undefined, r);
r = await ask({ type: "unlockPasskey", id: pk.id, prf: pk.prf });
check("the passkey unlocks the gateway", r.ok && r.data.unlocked && mem.seedHex === seedHex, r);

// auto-lock
r = await ask({ type: "setAutolock", minutes: 7 });
check("only the listed auto-lock times", r.ok === false, r);
r = await ask({ type: "setAutolock", minutes: 2 });
check("auto-lock can be set to 2 minutes", r.ok && r.data.autolockMinutes === 2 && alarms.at(-1)?.[1] === 2, alarms.at(-1));
await ask({ type: "balances" }).catch(() => null); // any use re-arms the alarm with the chosen time
check("activity re-arms the alarm with the chosen time", alarms.at(-1)?.[1] === 2, alarms.at(-1));
alarmListeners.forEach((f) => f({ name: "autolock" }));
await new Promise((res) => setTimeout(res, 10));
check("the alarm locks the gateway", mem.seedHex === undefined, mem);

r = await ask({ type: "setAutolock", minutes: 5 });
check("changing auto-lock needs the gateway unlocked", r.ok === false, r);
r = await ask({ type: "removePasskey", id: pk.id });
check("removing a passkey needs the gateway unlocked", r.ok === false && store.vault.passkeys.length === 1, r);

// passphrase change
await ask({ type: "unlock", passphrase: GOOD });
r = await ask({ type: "changePassphrase", passphrase: GOOD, next: "password1234" });
check("a weak new passphrase is refused", r.ok === false, r);
r = await ask({ type: "changePassphrase", passphrase: "nope nope nope nope", next: BETTER });
check("changing needs the current passphrase", r.ok === false && /Wrong passphrase/.test(r.error), r);
r = await ask({ type: "changePassphrase", passphrase: GOOD, next: BETTER });
check("the passphrase changes", r.ok, r);
await ask({ type: "lock" });
r = await ask({ type: "unlock", passphrase: GOOD });
check("the old passphrase stops working", r.ok === false, r);
r = await ask({ type: "unlock", passphrase: BETTER });
check("the new one works", r.ok && r.data.unlocked, r);
await ask({ type: "lock" });
r = await ask({ type: "unlockPasskey", id: pk.id, prf: pk.prf });
check("the passkey still works after the change", r.ok && r.data.unlocked, r);
r = await ask({ type: "exportSeed", passphrase: BETTER });
check("it's the same gateway key throughout", r.ok && r.data.seedHex === seedHex, r);
r = await ask({ type: "removePasskey", id: pk.id });
check("a passkey can be removed", r.ok && r.data.passkeys.length === 0, r);

// a gateway made under the old 10-character rule: its key encrypted with a passphrase allowed then, refused now
const legacy = "solana2024";
const address = store.vault.address;
const blob = await (async () => {
  const s = seedHex;
  const { webcrypto } = await import("node:crypto");
  const salt = webcrypto.getRandomValues(new Uint8Array(16)), iv = webcrypto.getRandomValues(new Uint8Array(12));
  const base = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(legacy), "PBKDF2", false, ["deriveKey"]);
  const key = await webcrypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 600_000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, Buffer.from(s, "hex")));
  const b = (u) => Buffer.from(u).toString("base64");
  return { salt: b(salt), iv: b(iv), ct: b(ct), iterations: 600_000 };
})();
store.vault = { blob, address };
await ask({ type: "lock" });
r = await ask({ type: "unlock", passphrase: legacy });
check("an older, weaker passphrase still unlocks, and the page is told to suggest a change", r.ok && r.data.unlocked && r.data.weakPassphrase === true, r.data);
r = await ask({ type: "changePassphrase", passphrase: legacy, next: GOOD });
check("after changing it the warning goes away", r.ok && r.data.weakPassphrase === false, r.data);
await ask({ type: "lock" });
r = await ask({ type: "status" });
check("locked: no warning, and the flag is gone from memory", r.ok && r.data.weakPassphrase === false && !("weakPass" in mem), mem);

// taking over the gateway an earlier version of the extension stored (still encrypted, same passphrase)
const oldVault = structuredClone(store.vault);
r = await ask({ type: "adopt", address: oldVault.address, blob: oldVault.blob });
check("adopting is refused while the wallet already has a gateway", r.ok === false, r);
delete store.vault;
delete store.settings;
r = await ask({ type: "adopt", address: oldVault.address, blob: { ...oldVault.blob, iterations: 5 } });
check("a damaged stored gateway is refused", r.ok === false && store.vault === undefined, r);
r = await ask({ type: "adopt", address: "not-an-address", blob: oldVault.blob });
check("a bad address is refused", r.ok === false && store.vault === undefined, r);
const main = "So11111111111111111111111111111111111111112";
r = await ask({ type: "adopt", address: oldVault.address, blob: oldVault.blob,
  settings: { network: "mainnet", apiKey: "abc-123", mainWallet: main, extraDestinations: [main, "junk", oldVault.address], evil: 1 } });
check("the stored gateway is taken over, locked", r.ok && r.data.hasVault && !r.data.unlocked && r.data.address === oldVault.address, r.data);
check("its settings come along, cleaned", store.settings.network === "mainnet" && store.settings.mainWallet === main
  && store.settings.extraDestinations.length === 1 && !("evil" in store.settings), store.settings);
r = await ask({ type: "unlock", passphrase: GOOD });
check("it opens with the same passphrase, same key", r.ok && r.data.unlocked && mem.seedHex === seedHex, r);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
