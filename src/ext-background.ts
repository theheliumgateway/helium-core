// The extension's service worker. It draws nothing itself: it serves the trading dot (src/dock.ts) and opens the
// wallet (wallet.html, src/ext-wallet.ts) for the dot's actions. The key never comes here: it lives in the wallet
// page's own worker. Clicking the toolbar icon opens the wallet in a tab; the dot's settings are a screen inside it
// (src/dot-settings.ts).
//
// Two kinds of sender:
//  - the extension's own pages (settings, wallet): the settings may reveal an old stored gateway's recovery key (with
//    its passphrase); the wallet redeems the dot's one-time "Unshield" code and reports its shielded balance;
//  - the dot (a content script inside a web page, so untrusted): only DockRequest, none of which reveals an address
//    or a balance; "Unshield" leaves a one-time code for the wallet window it opens.
import type { Network } from "./config";
import { decryptSeed, toHex, type EncryptedBlob } from "./crypto";
import {
  dockPrefsFrom, fundIsAuto, SHIELDED_TTL_MS,
  type DockPrefs, type DockRequest, type DockState, type DockView, type FundClaim, type GatewayRequest, type Response, type SettingsRequest,
} from "./messages";

const local = chrome.storage.local;
const session = chrome.storage.session;
const WALLET = chrome.runtime.getURL("wallet.html");
const VIEWS: readonly DockView[] = ["home", "shield", "push", "receive"];
// The window holds the gateway's own UI (360 x 600) plus the window frame.
const WIN_W = 380, WIN_H = 650;

// Nothing in this extension's storage is for web pages: the old gateway's encrypted seed and the dot's settings stay
// out of reach of content scripts (the dot asks this worker instead).
(local as unknown as { setAccessLevel?: (o: { accessLevel: string }) => Promise<void> })
  .setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch(() => undefined);

async function prefs(): Promise<DockPrefs> {
  return dockPrefsFrom((await local.get("dock")).dock);
}

/** Tell every open dot to re-read its state (the settings changed). */
async function broadcast() {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const t of tabs) if (t.id !== undefined) chrome.tabs.sendMessage(t.id, { type: "dock.refresh" }).catch(() => undefined);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.dock || changes.shielded)) void broadcast();
});

/** SOL in USD for pump.fun's (USD) wallet balance: Jupiter's public price, at most once a minute. The request carries
 *  nothing about the user. */
const SOL_MINT = "So11111111111111111111111111111111111111112";
let price: { usd: number; at: number } | null = null;
async function solUsd(): Promise<number | null> {
  if (price && Date.now() - price.at < 60_000) return price.usd;
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`, { credentials: "omit" });
    const v = Number(((await r.json()) as Record<string, { usdPrice?: unknown }>)[SOL_MINT]?.usdPrice);
    if (Number.isFinite(v) && v > 0) price = { usd: v, at: Date.now() };
  } catch {
    /* keep the last price */
  }
  return price?.usd ?? null;
}
/** The gateway's last report. Once older than SHIELDED_TTL_MS the amount is deleted and only "expired" is kept. */
type StoredShielded = { lamports?: string; at: number; network?: Network; expired?: true };
const EXPIRE_ALARM = "shielded-expiry";
async function storedShielded(): Promise<StoredShielded | null> {
  const { shielded } = (await local.get("shielded")) as { shielded?: StoredShielded };
  if (!shielded) return null;
  if (shielded.lamports !== undefined && Date.now() - shielded.at >= SHIELDED_TTL_MS) {
    const gone: StoredShielded = { at: shielded.at, network: shielded.network ?? "mainnet", expired: true };
    await local.set({ shielded: gone });
    return gone;
  }
  return shielded;
}
chrome.alarms?.onAlarm.addListener((a) => {
  if (a.name === EXPIRE_ALARM) void storedShielded();
});
/** The last shielded balance the gateway reported (in SOL), for pump.fun only. */
async function shieldedFor(host: string, p: DockPrefs): Promise<DockState["shielded"]> {
  if (!p.showShielded || !/(^|\.)pump\.fun$/.test(host)) return null;
  const s = await storedShielded();
  if (!s) return null;
  const network = s.network ?? "mainnet";
  if (s.lamports === undefined) return { sol: null, at: s.at, network, expired: true };
  return { sol: Number(BigInt(s.lamports)) / 1e9, at: s.at, network, expired: false };
}

let lastOpen = 0;
async function openGateway(view: DockView, x: number, y: number, sol?: number) {
  const now = Date.now();
  if (now - lastOpen < 500) return; // one window per click, whatever the page does
  lastOpen = now;
  let hash = view as string;
  // An amount for Push only: a plain positive number of SOL with at most 9 decimals. The gateway fills it in, and with
  // the one-time code below (redeemed through the bridge) pushes it straight away if it is within the one-tap limit.
  if (view === "push" && sol !== undefined) {
    if (!Number.isFinite(sol) || sol <= 0 || sol > 10_000) throw new Error("Bad amount");
    const id = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/\+/g, "-").replace(/\//g, "_");
    await session.set({ fund: { id, sol, at: now } satisfies PendingFund });
    hash += `&sol=${sol.toFixed(9).replace(/\.?0+$/, "")}&fund=${id}`;
  }
  const url = `${WALLET}?dock#${hash}`;
  // Reuse the window: an unlocked gateway stays unlocked between actions.
  const { dockWin } = await session.get("dockWin");
  if (typeof dockWin === "number") {
    try {
      const w = await chrome.windows.get(dockWin, { populate: true });
      const tab = w.tabs?.[0];
      if (tab?.id !== undefined) {
        await chrome.tabs.update(tab.id, { url });
        await chrome.windows.update(dockWin, { focused: true });
        return;
      }
    } catch {
      /* the window was closed */
    }
  }
  const clamp = (n: number) => (Number.isFinite(n) ? Math.round(Math.min(Math.max(n, 0), 10000)) : undefined);
  const w = await chrome.windows.create({ url, type: "popup", width: WIN_W, height: WIN_H, left: clamp(x), top: clamp(y), focused: true });
  await session.set({ dockWin: w?.id });
}

/** The toolbar icon: bring the wallet's tab forward, or open one. The dot's small window (…?dock) doesn't count. */
async function openWalletTab() {
  try {
    // the extension's own pages are listed without the "tabs" permission (Chrome 116+)
    const getContexts = (chrome.runtime as unknown as {
      getContexts?: (f: { contextTypes: string[] }) => Promise<{ tabId: number; windowId: number; documentUrl?: string }[]>;
    }).getContexts;
    const open = (await getContexts?.({ contextTypes: ["TAB"] }))
      ?.find((c) => c.tabId >= 0 && c.documentUrl?.startsWith(WALLET) && !c.documentUrl.startsWith(`${WALLET}?dock`));
    if (open) {
      await chrome.tabs.update(open.tabId, { active: true });
      await chrome.windows.update(open.windowId, { focused: true });
      return;
    }
  } catch {
    /* the tab went away: open a new one */
  }
  await chrome.tabs.create({ url: WALLET });
}
chrome.action?.onClicked.addListener(() => void openWalletTab());
// a fresh install goes straight to creating the gateway
chrome.runtime.onInstalled?.addListener((d) => {
  if (d.reason === "install") void chrome.tabs.create({ url: WALLET });
});

async function fromDot(req: DockRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  let host = "";
  try {
    host = new URL(sender.url ?? "").hostname; // where the dot is, from Chrome, never from the message
  } catch {
    /* no URL */
  }
  switch (req?.type) {
    case "dock.state": {
      const p = await prefs();
      const shielded = await shieldedFor(host, p);
      return {
        show: p.enabled && !!host && !p.hidden.includes(host), side: p.side, y: p.y, actions: p.actions, tuck: p.tuck, fund: p.fund,
        shielded, solUsd: shielded?.network === "mainnet" && !shielded.expired ? await solUsd() : null,
      } satisfies DockState;
    }
    case "dock.open":
      if (!VIEWS.includes(req.view)) throw new Error("Unknown screen");
      await openGateway(req.view, Number(req.x), Number(req.y), req.sol === undefined ? undefined : Number(req.sol));
      return null;
    case "dock.pos": {
      if (req.side !== "left" && req.side !== "right") throw new Error("Bad side");
      const y = Number(req.y);
      if (!Number.isFinite(y)) throw new Error("Bad position");
      await local.set({ dock: { ...(await prefs()), side: req.side, y: Math.min(Math.max(y, 0.04), 0.96) } });
      return null;
    }
    case "dock.hide": {
      const p = await prefs();
      if (host && !p.hidden.includes(host)) await local.set({ dock: { ...p, hidden: [...p.hidden, host].slice(-200) } });
      return null;
    }
    default:
      throw new Error("Not allowed from a web page");
  }
}

/** The last "Unshield" click: one at a time, single use, 2 minutes (time to unlock the gateway). */
type PendingFund = { id: string; sol: number; at: number };
const FUND_TTL = 120_000;

/** The wallet page: redeems the code from its URL, and reports the shielded balance. */
async function fromGateway(req: GatewayRequest): Promise<FundClaim | null> {
  if (req?.type === "balance.clear") {
    await local.remove("shielded");
    return null;
  }
  if (req?.type === "balance.report") {
    if (typeof req.lamports !== "string" || !/^\d{1,19}$/.test(req.lamports)) throw new Error("Bad balance");
    if (req.network !== "mainnet" && req.network !== "devnet") throw new Error("Bad network");
    const at = Date.now();
    await local.set({ shielded: { lamports: req.lamports, network: req.network, at } satisfies StoredShielded });
    // delete the amount when it goes stale, even if no pump.fun tab asks for it before then
    await chrome.alarms?.create(EXPIRE_ALARM, { when: at + SHIELDED_TTL_MS + 1000 });
    return null;
  }
  if (req?.type !== "fund.claim" || typeof req.id !== "string") throw new Error("Unknown request");
  const { fund } = (await session.get("fund")) as { fund?: PendingFund };
  if (!fund || fund.id !== req.id || Date.now() - fund.at > FUND_TTL) throw new Error("This request has expired");
  await session.remove("fund");
  return { sol: fund.sol, auto: fundIsAuto(fund.sol, (await prefs()).fund) };
}

/** The gateway this extension used to hold, if it is still stored here (it is never deleted automatically). */
async function legacyVault(): Promise<{ address: string; blob: EncryptedBlob } | null> {
  const { vault } = await local.get("vault");
  return (vault as { address: string; blob: EncryptedBlob } | undefined) ?? null;
}

async function fromSettings(req: SettingsRequest): Promise<unknown> {
  switch (req?.type) {
    case "legacy": {
      const v = await legacyVault();
      return { address: v?.address ?? null };
    }
    case "legacyExport": {
      const v = await legacyVault();
      if (!v) throw new Error("No extension gateway is stored here");
      return { seedHex: toHex(await decryptSeed(req.passphrase, v.blob)) };
    }
    default:
      throw new Error("Unknown request");
  }
}

const EXT_BASE = chrome.runtime.getURL("");
chrome.runtime.onMessage.addListener((req: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  // The dot has the same extension id, so it is told apart by where the message comes from.
  const url = sender.url ?? "";
  const trusted = url.startsWith(EXT_BASE) && (sender.origin === undefined || `${sender.origin}/` === EXT_BASE);
  const type = (req as { type?: unknown } | null)?.type;
  const fromWallet = trusted && url.startsWith(WALLET) && (type === "fund.claim" || type === "balance.report" || type === "balance.clear");
  (fromWallet ? fromGateway(req as GatewayRequest)
    : trusted ? fromSettings(req as SettingsRequest)
    : fromDot(req as DockRequest, sender))
    .then((data): Response => ({ ok: true, data }))
    .catch((e: unknown): Response => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    .then(sendResponse);
  return true;
});
