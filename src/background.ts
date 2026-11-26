// The gateway's engine: owns the key material. The website runs it in a Web Worker (src/web/worker.ts); the UI
// (popup.ts) never sees the seed except during explicit backup/export. The extension no longer runs it: its
// background is src/ext-background.ts (the trading dot only).
import { address as parseAddress, isAddress } from "@solana/kit";
import { DEFAULT_SETTINGS, FEE_RESERVE_LAMPORTS, PAY_PAGE, explorerTx, type Settings } from "./config";
import {
  decryptSeed, encryptSeed, fromHex, toHex, unwrapSeedWithPasskey, wrapSeedWithPasskey,
  type EncryptedBlob, type PasskeyWrap,
} from "./crypto";
import { AUTOLOCK_CHOICES, type Balances, type PasskeyInfo, type ProductInfo, type Request, type Response, type Status } from "./messages";
import { passphraseProblem } from "./strength";
import { activeProduct } from "./product";
import { feeConfigured, feeStarted } from "./fees";
import { makeQuote } from "./quotes";
import {
  autoShieldAmount,
  newSeed,
  openVault,
  depositCodeOf,
  parsePrivateAddress,
  privateAddressOf,
  privateSol,
  publicBalance,
  pushToMain,
  sendPrivate,
  sendPublicSol,
  shield,
  tokenProgramOf,
  vaultAddress,
  vaultTokenAccount,
} from "./spr";
import { stakeView, stakeTokens, unstakeUnlocked } from "./staking";
import { clearTierCache, getTier } from "./tiers";

const ALARM = "autolock";
const MAX_PASSKEYS = 10;

interface StoredVault {
  blob: EncryptedBlob;
  address: string;
  /** Other ways in: the same seed wrapped with a key from each passkey's PRF output (see crypto.ts). */
  passkeys?: (PasskeyInfo & PasskeyWrap)[];
}
const B64URL = /^[A-Za-z0-9_-]+$/;

/** A gateway set aside with Log out: its encrypted key and the settings that belong to it, not to the browser. */
interface SavedGateway {
  vault: StoredVault;
  mainWallet: string;
  extraDestinations: string[];
  autoShield: boolean;
}
const MAX_SAVED = 20;

const local = chrome.storage.local;
const session = chrome.storage.session;

async function getSettings(): Promise<Settings> {
  const { settings } = await local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) };
}
async function getVault(): Promise<StoredVault | null> {
  const { vault } = await local.get("vault");
  return (vault as StoredVault | undefined) ?? null;
}
async function getSaved(): Promise<SavedGateway[]> {
  const { saved } = await local.get("saved");
  return Array.isArray(saved) ? (saved as SavedGateway[]).filter((g) => g && g.vault && typeof g.vault.address === "string") : [];
}
/** A gateway that becomes current is no longer listed as set aside (one copy of each key on the device). */
async function unsave(address: string) {
  const saved = await getSaved();
  if (saved.some((g) => g.vault.address === address)) await local.set({ saved: saved.filter((g) => g.vault.address !== address) });
}

// Unlocked seed lives only in session storage (memory; cleared on browser close, not readable by web pages).
async function getUnlockedSeed(): Promise<Uint8Array | null> {
  const { seedHex } = await session.get("seedHex");
  return typeof seedHex === "string" ? fromHex(seedHex) : null;
}
/** active: the user did something, so the idle lock starts over. Background checks pass false. */
async function requireSeed(active = true): Promise<Uint8Array> {
  const seed = await getUnlockedSeed();
  if (!seed) throw new Error("Gateway is locked");
  if (active) await touch();
  return seed;
}
const autolockOf = (s: Settings) => ((AUTOLOCK_CHOICES as readonly number[]).includes(s.autolockMinutes) ? s.autolockMinutes : 10);
async function touch() {
  await chrome.alarms.create(ALARM, { delayInMinutes: autolockOf(await getSettings()) });
}
async function lock() {
  await session.remove(["seedHex", "weakPass"]);
  await chrome.alarms.clear(ALARM);
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) void lock();
});

async function unlockWith(seed: Uint8Array, weakPass = false) {
  await session.set({ seedHex: toHex(seed), weakPass });
  await touch();
}
/** The passphrase must open the stored key (for every new way in, and every change to where funds can go). */
async function checkPassphrase(passphrase: string): Promise<{ v: StoredVault; seed: Uint8Array }> {
  const v = await getVault();
  if (!v) throw new Error("No gateway yet");
  return { v, seed: await decryptSeed(passphrase, v.blob) };
}
function strongEnough(passphrase: string) {
  const why = passphraseProblem(passphrase);
  if (why) throw new Error(why);
}

function parseLamports(s: string): bigint {
  if (!/^\d+$/.test(s)) throw new Error("Invalid amount");
  return BigInt(s);
}

// Serialize all chain operations: private-note spends must not race each other.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

function productInfo(s: Settings): ProductInfo {
  const p = activeProduct(s.network);
  return {
    feeBps: p.feeBps,
    feeActive: feeStarted(p),
    feeStartsAt: feeConfigured(p) && !feeStarted(p) ? p.feeStartsAt : 0,
    tokenSymbol: p.token?.symbol ?? null,
    tokenDecimals: p.token?.decimals ?? 0,
    tiers: p.tiers.map((t) => ({ name: t.name, min: t.min.toString(), discountBps: t.discountBps })),
    burnPerPush: p.burnPerPush.toString(),
    extraDestinationsMinTier: p.extraDestinationsMinTier,
    maxExtraDestinations: p.maxExtraDestinations,
    tierSource: p.tierSource,
    stakingEnabled: !!p.staking,
    stakeLockSeconds: p.staking?.lockSeconds ?? 0,
  };
}

async function status(): Promise<Status> {
  const [v, s, seed, { weakPass }] = await Promise.all([getVault(), getSettings(), getUnlockedSeed(), session.get("weakPass")]);
  return {
    passkeys: (v?.passkeys ?? []).map(({ id, salt, label, added }) => ({ id, salt, label, added })),
    autolockMinutes: autolockOf(s),
    weakPassphrase: !!seed && weakPass === true,
    autoShield: s.autoShield === true,
    hasVault: !!v,
    unlocked: !!seed,
    address: v?.address ?? null,
    network: s.network,
    hasApiKey: !!s.apiKey,
    mainWallet: s.mainWallet,
    extraDestinations: s.extraDestinations,
    product: productInfo(s),
    saved: (await getSaved()).map((g) => g.vault.address).filter((a) => a !== v?.address),
  };
}

async function handle(req: Request): Promise<unknown> {
  switch (req.type) {
    case "status":
      return status();

    case "create": {
      if (await getVault()) throw new Error("A gateway already exists. Import or unlock it instead.");
      strongEnough(req.passphrase);
      const seed = newSeed();
      const addr = vaultAddress(seed);
      await local.set({ vault: { blob: await encryptSeed(req.passphrase, seed), address: addr } satisfies StoredVault });
      await unlockWith(seed);
      await unsave(addr);
      // Returned once so the user can back it up. It is not stored in plaintext anywhere.
      return { address: addr, seedHex: toHex(seed) };
    }

    case "import": {
      if (await getVault()) throw new Error("A gateway already exists in this browser profile");
      strongEnough(req.passphrase);
      const seed = fromHex(req.seedHex);
      if (seed.length !== 32) throw new Error("Recovery key must be 32 bytes (64 hex characters)");
      const addr = vaultAddress(seed);
      // Importing a gateway that was set aside here brings back its own settings (main wallet, destinations).
      const was = (await getSaved()).find((g) => g.vault.address === addr);
      const back: Partial<Settings> = was ? { mainWallet: was.mainWallet, extraDestinations: was.extraDestinations, autoShield: was.autoShield } : {};
      await local.set({ vault: { blob: await encryptSeed(req.passphrase, seed), address: addr } satisfies StoredVault, settings: { ...(await getSettings()), ...back } });
      await unlockWith(seed);
      await unsave(addr);
      return { address: addr };
    }

    case "unlock": {
      const v = await getVault();
      if (!v) throw new Error("No gateway yet");
      // older gateways were made under a 10-character rule: they still open, and the page suggests a change
      await unlockWith(await decryptSeed(req.passphrase, v.blob), passphraseProblem(req.passphrase) !== null);
      return status();
    }

    case "unlockPasskey": {
      const v = await getVault();
      if (!v) throw new Error("No gateway yet");
      const pk = v.passkeys?.find((p) => p.id === req.id);
      if (!pk) throw new Error("That passkey isn't set up for this gateway. Use your passphrase.");
      if (typeof req.prf !== "string" || !/^[0-9a-f]{64}$/.test(req.prf)) throw new Error("The passkey didn't return its key");
      const seed = await unwrapSeedWithPasskey(fromHex(req.prf), pk);
      if (vaultAddress(seed) !== v.address) throw new Error("That passkey can't unlock this gateway");
      await unlockWith(seed);
      return status();
    }

    case "lock":
      await lock();
      return status();

    case "logOut": {
      // Nothing is decrypted or deleted: the encrypted key moves to the saved list, with the settings that are its own.
      const v = await getVault();
      await lock();
      clearTierCache();
      if (!v) return status();
      const s = await getSettings();
      const others = (await getSaved()).filter((g) => g.vault.address !== v.address);
      if (others.length >= MAX_SAVED) throw new Error(`At most ${MAX_SAVED} gateways can be saved on this device`);
      const entry: SavedGateway = { vault: v, mainWallet: s.mainWallet, extraDestinations: s.extraDestinations, autoShield: s.autoShield === true };
      await local.set({
        saved: [entry, ...others],
        settings: { ...s, mainWallet: DEFAULT_SETTINGS.mainWallet, extraDestinations: [], autoShield: DEFAULT_SETTINGS.autoShield },
      });
      await local.remove("vault");
      return status();
    }

    case "switchTo": {
      if (await getVault()) throw new Error("Log out of the current gateway first");
      const g = (await getSaved()).find((x) => x.vault.address === req.address);
      if (!g) throw new Error("That gateway isn't saved on this device");
      await local.set({
        vault: g.vault,
        settings: { ...(await getSettings()), mainWallet: g.mainWallet, extraDestinations: g.extraDestinations, autoShield: g.autoShield },
      });
      await unsave(g.vault.address);
      return status();
    }

    case "checkPassphrase":
      await checkPassphrase(req.passphrase);
      return null;

    case "changePassphrase": {
      const { v, seed } = await checkPassphrase(req.passphrase);
      strongEnough(req.next);
      if (req.next === req.passphrase) throw new Error("That's the passphrase you have now");
      // passkeys wrap the seed itself, so they keep working
      await local.set({ vault: { ...v, blob: await encryptSeed(req.next, seed) } satisfies StoredVault });
      if (await getUnlockedSeed()) await session.set({ weakPass: false });
      return status();
    }

    case "addPasskey": {
      const { v, seed } = await checkPassphrase(req.passphrase);
      const list = v.passkeys ?? [];
      if (list.length >= MAX_PASSKEYS) throw new Error(`You can add at most ${MAX_PASSKEYS} passkeys`);
      if (typeof req.id !== "string" || req.id.length < 16 || req.id.length > 1400 || !B64URL.test(req.id)) throw new Error("Bad passkey id");
      if (typeof req.salt !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(req.salt)) throw new Error("Bad passkey input");
      if (typeof req.prf !== "string" || !/^[0-9a-f]{64}$/.test(req.prf)) throw new Error("The passkey didn't return its key");
      if (list.some((p) => p.id === req.id)) throw new Error("That passkey is already set up");
      const label = String(req.label ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60) || "Passkey";
      const wrap = await wrapSeedWithPasskey(fromHex(req.prf), seed);
      await local.set({ vault: { ...v, passkeys: [...list, { id: req.id, salt: req.salt, label, added: Date.now(), ...wrap }] } satisfies StoredVault });
      return status();
    }

    case "removePasskey": {
      await requireSeed();
      const v = await getVault();
      if (!v) throw new Error("No gateway yet");
      await local.set({ vault: { ...v, passkeys: (v.passkeys ?? []).filter((p) => p.id !== req.id) } satisfies StoredVault });
      return status();
    }

    case "adopt": {
      // The wallet page read these from the extension's own storage (no web page or other extension can write there).
      // Nothing is decrypted here: the user unlocks it with the passphrase they set back then.
      if (await getVault()) throw new Error("This wallet already has a gateway");
      const b = req.blob as Partial<EncryptedBlob> | null;
      const ok = (s: unknown) => typeof s === "string" && s.length > 0 && s.length < 200 && /^[A-Za-z0-9+/=]+$/.test(s);
      if (!isAddress(req.address) || !b || !ok(b.salt) || !ok(b.iv) || !ok(b.ct)
        || typeof b.iterations !== "number" || b.iterations < 100_000 || b.iterations > 10_000_000) {
        throw new Error("The stored gateway is damaged. Import it with its recovery key instead.");
      }
      const blob: EncryptedBlob = { salt: b.salt!, iv: b.iv!, ct: b.ct!, iterations: b.iterations };
      const old = (req.settings ?? {}) as Partial<Settings>;
      const keep: Partial<Settings> = {};
      if (old.network === "mainnet" || old.network === "devnet") keep.network = old.network;
      if (typeof old.apiKey === "string" && /^[\w-]{1,100}$/.test(old.apiKey)) keep.apiKey = old.apiKey;
      if (typeof old.mainWallet === "string" && isAddress(old.mainWallet) && old.mainWallet !== req.address) keep.mainWallet = old.mainWallet;
      if (Array.isArray(old.extraDestinations)) {
        keep.extraDestinations = old.extraDestinations.filter((a): a is string => typeof a === "string" && isAddress(a) && a !== req.address).slice(0, 20);
      }
      await local.set({ vault: { blob, address: req.address } satisfies StoredVault, settings: { ...(await getSettings()), ...keep } });
      await unsave(req.address);
      return status();
    }

    case "setAutolock": {
      await requireSeed();
      if (!(AUTOLOCK_CHOICES as readonly number[]).includes(req.minutes)) throw new Error("Pick one of the listed times");
      await local.set({ settings: { ...(await getSettings()), autolockMinutes: req.minutes } });
      await touch();
      return status();
    }

    case "saveSettings": {
      const cur = await getSettings();
      if (req.network === "mainnet" && cur.network !== "mainnet" && !req.confirmMainnet) {
        throw new Error("Tick the box to confirm you are switching to mainnet (real funds)");
      }
      // An empty key field keeps the saved key.
      await local.set({ settings: { ...cur, apiKey: req.apiKey.trim() || cur.apiKey, network: req.network } });
      clearTierCache();
      return status();
    }

    case "setMain": {
      // Changing the withdrawal destination requires the passphrase, even while unlocked.
      const v = await getVault();
      if (!v) throw new Error("No gateway yet");
      await decryptSeed(req.passphrase, v.blob);
      const main = req.main.trim();
      if (!isAddress(main)) throw new Error("That is not a valid Solana address");
      if (main === v.address) throw new Error("Main wallet must differ from the gateway address");
      await local.set({ settings: { ...(await getSettings()), mainWallet: main } });
      clearTierCache();
      return status();
    }

    case "addDestination": {
      // Saving a new push destination needs the passphrase and (if configured) a minimum holder tier.
      const v = await getVault();
      if (!v) throw new Error("No gateway yet");
      await decryptSeed(req.passphrase, v.blob);
      const s = await getSettings();
      const p = activeProduct(s.network);
      const addr = req.address.trim();
      if (!isAddress(addr)) throw new Error("That is not a valid Solana address");
      if (addr === v.address) throw new Error("Destination must differ from the gateway address");
      if (addr === s.mainWallet || s.extraDestinations.includes(addr)) throw new Error("That destination is already saved");
      if (s.extraDestinations.length >= p.maxExtraDestinations) {
        throw new Error(`You can save at most ${p.maxExtraDestinations} extra destinations`);
      }
      if (p.extraDestinationsMinTier > 0) {
        const seed = await requireSeed();
        const h = await openVault(seed, s);
        const tier = await getTier(h, s.network, h.address, p);
        if (tier.level < p.extraDestinationsMinTier) {
          const need = p.tiers[p.extraDestinationsMinTier - 1]?.name ?? `tier ${p.extraDestinationsMinTier}`;
          throw new Error(`Extra destinations need the ${need} tier. Hold more ${p.token?.symbol ?? "tokens"} in your gateway.`);
        }
      }
      await local.set({ settings: { ...s, extraDestinations: [...s.extraDestinations, addr] } });
      return status();
    }

    case "removeDestination": {
      const s = await getSettings();
      await local.set({ settings: { ...s, extraDestinations: s.extraDestinations.filter((a) => a !== req.address) } });
      return status();
    }

    case "balances":
      return serial(async (): Promise<Balances> => {
        const seed = await requireSeed(!req.quiet);
        const settings = await getSettings();
        const p = activeProduct(settings.network);
        const h = await openVault(seed, settings);
        const [pub, priv] = await Promise.all([publicBalance(h), privateSol(h)]);
        let tier: Balances["tier"] = null;
        let vaultToken: string | null = null;
        let staked: Balances["staked"] = null;
        if (p.token) {
          const t = await getTier(h, settings.network, h.address, p);
          tier = { name: t.name, level: t.level, discountBps: t.discountBps, held: t.held.toString() };
          const program = await tokenProgramOf(h, p.token.mint).catch(() => null);
          if (program) vaultToken = (await vaultTokenAccount(h, p.token.mint, program)).amount.toString();
          staked = await stakeView(h, h.address, p).catch(() => null);
        }
        return {
          publicLamports: pub.toString(),
          privateLamports: priv.amount.toString(),
          feeReserveLamports: FEE_RESERVE_LAMPORTS.toString(),
          tier,
          vaultToken,
          staked,
        };
      });

    case "quote":
      return serial(async () => {
        const seed = await requireSeed();
        const settings = await getSettings();
        const h = await openVault(seed, settings);
        const { quote } = await makeQuote(h, settings, activeProduct(settings.network), parseLamports(req.lamports), !!req.payWithToken);
        return quote;
      });

    case "shield":
      return serial(async () => {
        const seed = await requireSeed();
        const settings = await getSettings();
        const h = await openVault(seed, settings);
        const signature = await shield(h, parseLamports(req.lamports));
        return { signature, url: explorerTx(settings, signature) };
      });

    case "push":
      return serial(async () => {
        const seed = await requireSeed();
        const settings = await getSettings();
        if (!settings.mainWallet) throw new Error("Set your main wallet first");
        // Only destinations the user saved (with their passphrase) are allowed.
        const to = req.to ?? settings.mainWallet;
        if (to !== settings.mainWallet && !settings.extraDestinations.includes(to)) {
          throw new Error("That destination is not in your saved list");
        }
        const product = activeProduct(settings.network);
        // A fee that started after the user's review must not be charged without being shown: review again.
        const now = Date.now();
        if (feeConfigured(product) && now >= product.feeStartsAt && (req.quotedAt ?? now) < product.feeStartsAt) {
          throw new Error(`The ${product.feeBps / 100}% service fee started after you reviewed this push. Review it again to see the fee.`);
        }
        const h = await openVault(seed, settings);
        const amount = req.lamports === "all" ? "all" : parseLamports(req.lamports);
        // The fee/burn is recomputed here from the final amount; nothing the UI displays is trusted.
        const r = await pushToMain(h, parseAddress(to), amount, async (final) => {
          const { plan } = await makeQuote(h, settings, product, final, !!req.payWithToken);
          return plan;
        });
        return {
          signature: r.signature,
          lamports: r.lamports.toString(),
          to,
          feeLamports: (r.plan.fee?.lamports ?? 0n).toString(),
          burned: (r.plan.burn?.amount ?? 0n).toString(),
          url: explorerTx(settings, r.signature),
        };
      });

    case "privateAddress": {
      const seed = await requireSeed();
      const settings = await getSettings();
      const h = await openVault(seed, settings);
      return { address: privateAddressOf(h), link: `${PAY_PAGE}#to=${depositCodeOf(h)}&net=${settings.network}` };
    }

    case "setAutoShield": {
      await requireSeed();
      await local.set({ settings: { ...(await getSettings()), autoShield: req.on === true } });
      return status();
    }

    case "autoShield":
      // The page asks after each balance read; the worker decides, from the setting and the chain, never the page.
      return serial(async () => {
        const settings = await getSettings();
        if (!settings.autoShield) return null;
        const seed = await requireSeed(false);
        const h = await openVault(seed, settings);
        const amount = autoShieldAmount(await publicBalance(h));
        if (amount === 0n) return null;
        const signature = await shield(h, amount);
        return { signature, lamports: amount.toString(), url: explorerTx(settings, signature) };
      });

    case "sendPrivate":
      return serial(async () => {
        // A private send has no saved-list to check, so it needs the passphrase every time: nothing that can only
        // drive the page (a stray script, a tampered link) can choose where private funds go.
        await checkPassphrase(req.passphrase);
        const seed = await requireSeed();
        const settings = await getSettings();
        const to = parsePrivateAddress(req.to);
        const h = await openVault(seed, settings);
        if (privateAddressOf(h) === req.to.trim()) throw new Error("That's this gateway's own private address");
        const r = await sendPrivate(h, to, parseLamports(req.lamports));
        return { signature: r.signature, lamports: r.lamports.toString(), url: explorerTx(settings, r.signature) };
      });

    case "sendPublic":
      // Public vault SOL -> a saved destination. Same allow-list as push; no product fee on this path.
      return serial(async () => {
        const seed = await requireSeed();
        const settings = await getSettings();
        if (!settings.mainWallet) throw new Error("Set your main wallet first");
        const to = req.to ?? settings.mainWallet;
        if (to !== settings.mainWallet && !settings.extraDestinations.includes(to)) {
          throw new Error("That destination is not in your saved list");
        }
        const h = await openVault(seed, settings);
        const amount = req.lamports === "all" ? "all" : parseLamports(req.lamports);
        const r = await sendPublicSol(h, to, amount);
        return {
          signature: r.signature,
          lamports: r.lamports.toString(),
          remaining: r.remaining.toString(),
          to,
          url: explorerTx(settings, r.signature),
        };
      });

    case "stake":
      // Stakes product tokens held by the vault into the pool fixed in product.ts; nothing here names a program or pool.
      return serial(async () => {
        const seed = await requireSeed();
        const settings = await getSettings();
        const p = activeProduct(settings.network);
        const h = await openVault(seed, settings);
        const r = await stakeTokens(h, seed, settings, p, parseLamports(req.amount));
        clearTierCache();
        return { signature: r.signature, amount: r.amount.toString(), lockSeconds: r.lockSeconds, url: explorerTx(settings, r.signature) };
      });

    case "unstake":
      return serial(async () => {
        const seed = await requireSeed();
        const settings = await getSettings();
        const p = activeProduct(settings.network);
        const h = await openVault(seed, settings);
        const r = await unstakeUnlocked(h, seed, settings, p);
        clearTierCache();
        return { signatures: r.signatures, amount: r.amount.toString(), url: explorerTx(settings, r.signatures[r.signatures.length - 1] ?? "") };
      });

    case "exportSeed": {
      const v = await getVault();
      if (!v) throw new Error("No gateway yet");
      return { seedHex: toHex(await decryptSeed(req.passphrase, v.blob)) };
    }
  }
}

/** SDK errors carry a machine code and details (e.g. CLIENT_INVALID_CONFIG {field}); show them, never secrets. */
function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const { code, details } = e as { code?: unknown; details?: unknown };
  let extra = "";
  if (typeof code === "string") {
    let d = "";
    if (details !== undefined) {
      try {
        d = " " + JSON.stringify(details, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
      } catch {
        /* details not serializable */
      }
    }
    extra = ` [${code}${d}]`;
  }
  const cause = (e as { cause?: unknown }).cause;
  const causeMsg = cause instanceof Error && cause.message !== e.message ? ` (cause: ${cause.message})` : "";
  return e.message + extra + causeMsg;
}

const EXT_BASE = chrome.runtime.getURL("");
chrome.runtime.onMessage.addListener((req: Request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  // Only the page that owns this worker may drive the vault (sender URL under runtime.getURL, see worker-shim.ts).
  if (!(sender.url ?? "").startsWith(EXT_BASE)) return false;
  handle(req)
    .then((data): Response => ({ ok: true, data }))
    .catch((e: unknown): Response => ({ ok: false, error: describeError(e) }))
    .then(sendResponse);
  return true;
});
