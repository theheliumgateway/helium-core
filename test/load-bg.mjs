// Loads the built extension service worker (src/ext-background.ts) with a stub chrome API and checks who may ask it
// what: the wallet page (its dot settings screen) may read/recover the old extension gateway, the toolbar icon opens
// the wallet; the trading dot (a content script inside a web
// page) only gets the dock requests, and an amount it passes is only ever a Push suggestion for the web gateway.
const b64 = (u) => Buffer.from(u).toString("base64");
const seed = crypto.getRandomValues(new Uint8Array(32));
const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
const base = await crypto.subtle.importKey("raw", new TextEncoder().encode("right passphrase"), "PBKDF2", false, ["deriveKey"]);
const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 1000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, seed));
const store = { vault: { address: "Vau1t1111111111111111111111111111111111111", blob: { salt: b64(salt), iv: b64(iv), ct: b64(ct), iterations: 1000 } } };

// A real service worker has no Node globals: remove Buffer so a missing browser shim shows up here, not in Chrome.
delete globalThis.Buffer;
const listeners = [];
const opened = [];
const sess = {};
globalThis.chrome = {
  runtime: {
    id: "x", getURL: (p) => `chrome-extension://x/${p}`, onMessage: { addListener: (f) => listeners.push(f) },
    getContexts: async () => contexts,
  },
  action: { onClicked: { addListener: (f) => actionListeners.push(f) } },
  storage: {
    local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) },
    session: {
      get: async (k) => ({ [k]: sess[k] }),
      set: async (o) => { if (!("dockWin" in o)) Object.assign(sess, o); }, // no reusable window in this test
      remove: async (k) => { delete sess[k]; },
    },
    onChanged: { addListener() {} },
  },
  tabs: {
    query: async () => [], sendMessage: async () => {},
    create: async (o) => { tabsCreated.push(o.url); return { id: 9 }; },
    update: async (id) => { tabsFocused.push(id); },
  },
  windows: { create: async (o) => (opened.push(o.url), { id: 1 }), get: async () => { throw new Error("closed"); }, update: async () => {} },
  alarms: { create: async (n, o) => { alarms.push([n, o]); }, onAlarm: { addListener: (f) => alarmListeners.push(f) } },
};
const alarms = [];
const alarmListeners = [];
const actionListeners = [], tabsCreated = [], tabsFocused = [];
let contexts = [];
let priceCalls = 0;
globalThis.fetch = async (url) => {
  priceCalls++;
  if (!String(url).startsWith("https://lite-api.jup.ag/price/v3?ids=So111")) throw new Error(`unexpected fetch ${url}`);
  return { json: async () => ({ So11111111111111111111111111111111111111112: { usdPrice: 150 } }) };
};
await import("../dist/background.js");

const ask = (req, sender) => new Promise((resolve) => { const r = listeners[0](req, sender, resolve); if (r === false) resolve("ignored"); });
const page = { id: "x", url: "chrome-extension://x/wallet.html#dot", origin: "chrome-extension://x" };
const dot = { id: "x", url: "https://pump.fun/coin/abc", origin: "https://pump.fun", tab: { id: 7 } };
const wait = () => new Promise((r) => setTimeout(r, 520)); // the worker opens at most one window per 500 ms
let failed = 0;
const check = (name, ok, got) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(got)}`}`); if (!ok) failed++; };
const hex = Array.from(seed, (b) => b.toString(16).padStart(2, "0")).join("");

let r = await ask({ type: "legacy" }, page);
check("the wallet's dot settings see the old extension gateway", r.ok && r.data.address === store.vault.address, r);
r = await ask({ type: "legacyExport", passphrase: "wrong" }, page);
check("wrong passphrase reveals nothing", r.ok === false && /Wrong passphrase/.test(r.error), r);
r = await ask({ type: "legacyExport", passphrase: "right passphrase" }, page);
check("right passphrase reveals the recovery key", r.ok && r.data.seedHex === hex, r);
r = await ask({ type: "legacy" }, { id: "evil", url: "chrome-extension://evil/wallet.html" });
check("another extension is ignored", r === "ignored", r);

// the toolbar icon opens the wallet: a new tab, or the one already open (never the dot's small window)
const click = async () => { actionListeners[0]?.({}); await new Promise((r) => setTimeout(r, 20)); };
await click();
check("toolbar click opens the wallet in a tab", tabsCreated.at(-1) === "chrome-extension://x/wallet.html" && tabsFocused.length === 0, { tabsCreated, tabsFocused });
contexts = [{ tabId: 4, windowId: 2, documentUrl: "chrome-extension://x/wallet.html?dock#push" }, { tabId: 3, windowId: 2, documentUrl: "chrome-extension://x/wallet.html#home" }];
const before = tabsCreated.length;
await click();
check("toolbar click focuses the open wallet tab", tabsFocused.at(-1) === 3 && tabsCreated.length === before, { tabsCreated, tabsFocused });
contexts = [{ tabId: 4, windowId: 2, documentUrl: "chrome-extension://x/wallet.html?dock#push" }];
await click();
check("the dot's window doesn't count as the wallet tab", tabsCreated.length === before + 1, { tabsCreated, tabsFocused });
contexts = [];
for (const type of ["legacy", "legacyExport", "status", "exportSeed", "push"]) {
  r = await ask({ type, passphrase: "right passphrase" }, dot);
  check(`dot can't ${type}`, r.ok === false && /Not allowed/.test(r.error), r);
}
r = await ask({ type: "dock.state" }, dot);
check("dot reads its state (defaults)", r.ok && r.data.show && r.data.fund.enabled && r.data.actions.push && r.data.tuck, r);
const FUND_URL = /^chrome-extension:\/\/x\/wallet\.html\?dock#push&sol=([\d.]+)&fund=([A-Za-z0-9_-]{24})$/;
const gw = { id: "x", url: "chrome-extension://x/wallet.html?dock#push", origin: "chrome-extension://x", tab: { id: 9 } }; // the wallet page
r = await ask({ type: "dock.open", view: "push", x: 100, y: 100, sol: 1.4 }, dot);
let m = FUND_URL.exec(opened.at(-1) ?? "");
check("Unshield opens Push with the amount and a one-time code", r.ok && m?.[1] === "1.4", opened);
const code = m?.[2];
r = await ask({ type: "fund.claim", id: code }, dot);
check("the dot can't redeem the code", r.ok === false && /Not allowed/.test(r.error), r);
r = await ask({ type: "fund.claim", id: code }, { ...gw, url: "https://evil.example/app/", origin: "https://evil.example" });
check("another site can't redeem the code", r.ok === false, r);
r = await ask({ type: "fund.claim", id: code }, { ...gw, url: "https://heliumgateway.net/app/?dock#push", origin: "https://heliumgateway.net" });
check("the old website wallet can't redeem it any more", r.ok === false, r);
r = await ask({ type: "fund.claim", id: code }, { ...page, url: "chrome-extension://x/other.html" });
check("another extension page can't redeem it", r.ok === false, r);
r = await ask({ type: "fund.claim", id: "A".repeat(24) }, gw);
check("a guessed code is refused", r.ok === false && /expired/.test(r.error), r);
r = await ask({ type: "fund.claim", id: code }, gw);
check("the gateway redeems the code: 1.4 SOL, one click", r.ok && r.data.sol === 1.4 && r.data.auto === true, r);
r = await ask({ type: "fund.claim", id: code }, gw);
check("a code works only once", r.ok === false, r);
for (const [type, extra] of [["dock.open", { view: "push", x: 0, y: 0, sol: 1 }], ["dock.hide", {}]]) {
  r = await ask({ type, ...extra }, gw);
  check(`the wallet page can't ${type}`, r.ok === false, r);
}
await wait();
r = await ask({ type: "dock.open", view: "push", x: 0, y: 0, sol: 2 }, dot);
m = FUND_URL.exec(opened.at(-1) ?? "");
check("whole amounts stay whole", r.ok && m?.[1] === "2", opened);
r = await ask({ type: "fund.claim", id: m?.[2] }, gw);
check("2 SOL is within the default 2 SOL limit", r.ok && r.data.auto === true, r);
await wait();
r = await ask({ type: "dock.open", view: "push", x: 0, y: 0, sol: 2.5 }, dot);
m = FUND_URL.exec(opened.at(-1) ?? "");
r = await ask({ type: "fund.claim", id: m?.[2] }, gw);
check("above the limit it only fills in the review", r.ok && r.data.sol === 2.5 && r.data.auto === false, r);
await wait();
r = await ask({ type: "dock.open", view: "push", x: 0, y: 0, sol: 1 }, dot);
const stale = FUND_URL.exec(opened.at(-1) ?? "")?.[2];
sess.fund.at -= 121_000;
r = await ask({ type: "fund.claim", id: stale }, gw);
check("a code expires after 2 minutes", r.ok === false && /expired/.test(r.error), r);
await wait();
store.dock = { fund: { autoMax: 0 } };
r = await ask({ type: "dock.open", view: "push", x: 0, y: 0, sol: 0.1 }, dot);
r = await ask({ type: "fund.claim", id: FUND_URL.exec(opened.at(-1) ?? "")?.[2] }, gw);
check("'Always review' turns one-click off", r.ok && r.data.auto === false, r);
delete store.dock;
await wait();
for (const sol of [-1, 0, 1e9, "1;alert(1)", "abc"]) {
  const n = opened.length;
  r = await ask({ type: "dock.open", view: "push", x: 0, y: 0, sol }, dot);
  check(`bad amount ${JSON.stringify(sol)} is refused`, r.ok === false && opened.length === n, r);
  await wait();
}
r = await ask({ type: "dock.open", view: "shield", x: 0, y: 0, sol: 5 }, dot);
check("an amount only applies to Push", r.ok && opened.at(-1) === "chrome-extension://x/wallet.html?dock#shield", opened);
await wait();
r = await ask({ type: "dock.open", view: "javascript:alert(1)", x: 0, y: 0 }, dot);
check("dot can't open other pages", r.ok === false, r);
r = await ask({ type: "dock.state" }, dot);
check("no shielded balance until the gateway reports one", r.ok && r.data.shielded === null && r.data.solUsd === null && priceCalls === 0, r);
r = await ask({ type: "balance.report", lamports: "2500000000", network: "mainnet" }, dot);
check("the dot can't report a balance", r.ok === false && store.shielded === undefined, r);
r = await ask({ type: "balance.report", lamports: "12abc", network: "mainnet" }, gw);
check("a malformed balance is refused", r.ok === false && store.shielded === undefined, r);
r = await ask({ type: "balance.report", lamports: "1000", network: "testnet" }, gw);
check("an unknown network is refused", r.ok === false && store.shielded === undefined, r);
r = await ask({ type: "balance.report", lamports: "700000000", network: "devnet" }, gw);
r = await ask({ type: "dock.state" }, dot);
check("a devnet balance is listed, without a price (not added to totals)", r.ok && r.data.shielded?.sol === 0.7 && r.data.shielded.network === "devnet" && r.data.solUsd === null && priceCalls === 0, r);
r = await ask({ type: "balance.report", lamports: "2500000000", network: "mainnet" }, gw);
r = await ask({ type: "balance.report", lamports: "9", network: "mainnet" }, { ...gw, url: "https://heliumgateway.net/app/", origin: "https://heliumgateway.net" });
check("the website can't report a balance", r.ok === false && store.shielded?.lamports !== "9", r);
r = await ask({ type: "balance.report", lamports: "2500000000", network: "mainnet" }, gw);
check("the gateway reports its shielded balance", r.ok && store.shielded?.lamports === "2500000000", store.shielded);
r = await ask({ type: "dock.state" }, dot);
check("pump.fun gets the shielded SOL and SOL's price", r.ok && r.data.shielded?.sol === 2.5 && r.data.shielded.network === "mainnet" && r.data.solUsd === 150, r);
r = await ask({ type: "dock.state" }, { ...dot, url: "https://axiom.trade/meme/x", origin: "https://axiom.trade" });
check("other trading sites don't get the balance", r.ok && r.data.shielded === null, r);
store.dock = { showShielded: false };
r = await ask({ type: "dock.state" }, dot);
check("turning it off hides the balance", r.ok && r.data.shielded === null, r);
delete store.dock;
await ask({ type: "dock.state" }, dot);
check("the price is fetched at most once a minute", priceCalls === 1, priceCalls);
const lastAlarm = alarms.at(-1);
check("a report sets the 10-minute expiry alarm", lastAlarm?.[0] === "shielded-expiry" && lastAlarm[1].when - store.shielded.at === 601_000, alarms);
store.shielded.at -= 600_000;
const callsBefore = priceCalls;
r = await ask({ type: "dock.state" }, dot);
check("after 10 minutes the balance shows as expired", r.ok && r.data.shielded?.expired === true && r.data.shielded.sol === null && r.data.solUsd === null, r);
check("the expired amount is deleted from storage", store.shielded.lamports === undefined && store.shielded.expired === true, store.shielded);
check("no price is fetched for an expired balance", priceCalls === callsBefore, priceCalls);
r = await ask({ type: "balance.report", lamports: "1000000000", network: "mainnet" }, gw);
r = await ask({ type: "dock.state" }, dot);
check("unlocking the gateway again brings a fresh balance", r.ok && r.data.shielded?.sol === 1 && r.data.shielded.expired === false, r);
store.shielded.at -= 600_000;
alarmListeners.forEach((f) => f({ name: "shielded-expiry" }));
await new Promise((res) => setTimeout(res, 10));
check("the alarm deletes the amount without any pump.fun tab open", store.shielded.lamports === undefined && store.shielded.expired === true, store.shielded);
store.dock = { fund: { enabled: true, bufferSol: 0.02, roundSol: 0.1, autoMax: 1 } };
r = await ask({ type: "dock.state" }, dot);
check("old amount settings move to the new rule (keeping the limit)", r.ok && r.data.fund.v === 2 && r.data.fund.roundSol === 0.001 && r.data.fund.bufferPct === 3 && r.data.fund.autoMax === 1, r.data?.fund);
delete store.dock;
r = await ask({ type: "dock.hide" }, dot);
check("hide uses the sender's site", r.ok && store.dock.hidden[0] === "pump.fun", store.dock);
r = await ask({ type: "dock.state" }, dot);
check("hidden site no longer shows the dot", r.ok && r.data.show === false, r);
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
