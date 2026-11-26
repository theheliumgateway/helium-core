import type { Network } from "./config";
import type { Quote } from "./quotes";

export type { Quote };

/** Everything the popup may ask the background worker to do. A push can only target a destination the user has
 *  already saved (main wallet or an extra saved with their passphrase). Lamport/token amounts are decimal strings. */
export type Request =
  | { type: "status" }
  | { type: "create"; passphrase: string }
  | { type: "import"; passphrase: string; seedHex: string }
  | { type: "unlock"; passphrase: string }
  /** id: the passkey's credential id (base64url); prf: its PRF output for that passkey's salt (hex). */
  | { type: "unlockPasskey"; id: string; prf: string }
  | { type: "lock" }
  /** Lock, then set this gateway aside on this device (still encrypted) so another can be opened or created. */
  | { type: "logOut" }
  /** Make a gateway set aside on this device the current one again (then unlock it as usual). */
  | { type: "switchTo"; address: string }
  | { type: "checkPassphrase"; passphrase: string }
  | { type: "changePassphrase"; passphrase: string; next: string }
  /** salt: the PRF input the page used (base64url, 32 bytes). Needs the passphrase, like every new way in. */
  | { type: "addPasskey"; passphrase: string; id: string; salt: string; prf: string; label: string }
  | { type: "removePasskey"; id: string }
  | { type: "setAutolock"; minutes: number }
  /** Take over the gateway an earlier version of the extension stored (still encrypted, same passphrase). */
  | { type: "adopt"; address: string; blob: unknown; settings?: unknown }
  | { type: "saveSettings"; apiKey: string; network: Network; confirmMainnet: boolean }
  | { type: "setMain"; passphrase: string; main: string }
  | { type: "addDestination"; passphrase: string; address: string }
  | { type: "removeDestination"; address: string }
  /** quiet: a background refresh (auto-shield's check), which doesn't count as activity for the idle lock. */
  | { type: "balances"; quiet?: boolean }
  /** This gateway's private address (base58), and the pay-page link that carries it. */
  | { type: "privateAddress" }
  | { type: "setAutoShield"; on: boolean }
  /** Shield whatever public SOL sits above the fee reserve, if auto-shield is on. The worker picks the amount. */
  | { type: "autoShield" }
  /** Private balance -> another gateway's private address. Needs the passphrase, like every new destination. */
  | { type: "sendPrivate"; to: string; lamports: string; passphrase: string }
  | { type: "quote"; lamports: string; payWithToken?: boolean }
  | { type: "shield"; lamports: string }
  | { type: "push"; lamports: string | "all"; to?: string; payWithToken?: boolean; /** The `at` of the quote the user saw. */ quotedAt?: number }
  | { type: "sendPublic"; lamports: string | "all"; to?: string }
  | { type: "stake"; amount: string }
  | { type: "unstake" }
  | { type: "exportSeed"; passphrase: string };

export interface ProductInfo {
  feeBps: number;
  feeActive: boolean;
  /** When a configured fee starts (ms), or 0 when it has started or none is configured. */
  feeStartsAt: number;
  tokenSymbol: string | null;
  tokenDecimals: number;
  tiers: { name: string; min: string; discountBps: number }[];
  burnPerPush: string;
  extraDestinationsMinTier: number;
  maxExtraDestinations: number;
  /** "holding" | "staking" | "both": what the tier is computed from. */
  tierSource: "holding" | "staking" | "both";
  /** Staking pool configured for this network (stake/unstake available). */
  stakingEnabled: boolean;
  stakeLockSeconds: number;
  /** The download version is running signed token settings newer than the ones built into it: a full build with them
   *  is on heliumgateway.net, and the user should download it again. */
  updateReady: boolean;
}

export interface Status {
  hasVault: boolean;
  unlocked: boolean;
  address: string | null;
  network: Network;
  hasApiKey: boolean;
  mainWallet: string;
  extraDestinations: string[];
  product: ProductInfo;
  /** Passkeys that can unlock this gateway (ids and PRF inputs are not secret). */
  passkeys: PasskeyInfo[];
  autolockMinutes: number;
  /** The passphrase used to unlock this session is weaker than a new one may be (kept in memory only). */
  weakPassphrase: boolean;
  autoShield: boolean;
  /** Other gateways saved on this device, set aside with Log out. Public addresses only. */
  saved: string[];
}
export interface PasskeyInfo { id: string; salt: string; label: string; added: number }
export const AUTOLOCK_CHOICES = [2, 5, 10, 30] as const;

export interface Balances {
  publicLamports: string;
  privateLamports: string;
  feeReserveLamports: string;
  /** Tier of the vault wallet, when the product token is configured. */
  tier: { name: string; level: number; discountBps: number; held: string } | null;
  /** Product tokens held by the vault's own public wallet (used for pay-in-token). */
  vaultToken: string | null;
  /** Tokens the vault has staked in the pool, with when each stake unlocks (unix seconds). Null when staking is off. */
  staked: { total: string; entries: { amount: string; unlockTs: number }[] } | null;
}

/* ───────── the trading dock (src/dock.ts: the floating dot on trading sites) ─────────
 * The dot runs as a content script inside third-party pages, so it is untrusted: the background accepts only these
 * requests from it, and none of them reveals an address or a balance. Every action opens the web gateway
 * (wallet.html, inside the extension) in its own window. The one that moves funds is "Unshield" on pump.fun: it can only push to
 * the main wallet saved in the gateway (with its passphrase), only up to the user's one-tap limit, and only with a
 * one-time code from a real click. The extension itself holds no wallet: its popup is the dot's settings. */
export type DockView = "home" | "shield" | "push" | "receive";
export type DockSide = "left" | "right";
/** The fan's own actions; "fund" appears on its own when a buy amount is typed on pump.fun. */
export type DockAction = "push" | "shield" | "receive" | "home";
export interface DockPrefs {
  enabled: boolean;
  /** Which actions the fan shows, in this order. */
  actions: Record<DockAction, boolean>;
  /** Tuck half off the edge after a few idle seconds. */
  tuck: boolean;
  /** "Unshield" on pump.fun: push the buy's SOL estimate plus bufferPct % (the "≈" price can move) plus bufferSol
   *  (network fees, the token account's rent), rounded up to roundSol. autoMax: one click pushes straight to the
   *  gateway's saved main wallet up to this many SOL; above it (or 0) it opens the review. v: settings format (older
   *  saves get the new amount rule). */
  fund: { v: number; enabled: boolean; bufferPct: number; bufferSol: number; roundSol: number; autoMax: number };
  /** Add the gateway's shielded SOL to pump.fun's wallet balance (last value the gateway reported). */
  showShielded: boolean;
  /** Sites (hostnames) where the user hid the dot. */
  hidden: string[];
  side: DockSide;
  /** Vertical position, as a fraction of the window height. */
  y: number;
}
export const DOCK_DEFAULTS: DockPrefs = {
  enabled: true,
  actions: { push: true, shield: true, receive: true, home: true },
  tuck: true,
  fund: { v: 2, enabled: true, bufferPct: 3, bufferSol: 0.005, roundSol: 0.001, autoMax: 2 },
  showShielded: true,
  hidden: [],
  side: "right",
  y: 0.62,
};
/** Saved prefs merged over the defaults (older saves lack the newer fields). */
export function dockPrefsFrom(saved: unknown): DockPrefs {
  const s = (saved ?? {}) as Partial<DockPrefs>;
  return {
    ...DOCK_DEFAULTS,
    ...s,
    actions: { ...DOCK_DEFAULTS.actions, ...s.actions },
    // saves from before v2 (0.02 SOL, rounded up to 0.1) overshot small buys: they start over on the new rule,
    // keeping only the on/off switch and the one-tap limit
    fund: s.fund?.v === 2
      ? { ...DOCK_DEFAULTS.fund, ...s.fund }
      : { ...DOCK_DEFAULTS.fund, ...(s.fund ? { enabled: s.fund.enabled ?? true, autoMax: s.fund.autoMax ?? DOCK_DEFAULTS.fund.autoMax } : {}) },
    hidden: Array.isArray(s.hidden) ? s.hidden : [],
  };
}
export type DockRequest =
  | { type: "dock.state" }
  /** sol: Push only. Up to the one-tap limit the gateway pushes it to the saved main wallet; above it, it is filled in. */
  | { type: "dock.open"; view: DockView; x: number; y: number; sol?: number }
  | { type: "dock.pos"; side: DockSide; y: number }
  | { type: "dock.hide" };
export interface DockState {
  show: boolean;
  side: DockSide;
  y: number;
  actions: Record<DockAction, boolean>;
  tuck: boolean;
  fund: DockPrefs["fund"];
  /** pump.fun only, when showShielded is on: the last shielded balance the gateway reported, and SOL's price. A devnet
   *  balance is listed on its own and never added to pump.fun's (real-money) totals. After SHIELDED_TTL_MS the amount
   *  is deleted (sol: null, expired: true) until the user unlocks the gateway again. */
  shielded: { sol: number | null; at: number; network: Network; expired: boolean } | null;
  solUsd: number | null;
}
/** How long the extension keeps the shielded balance the gateway reported (the gateway itself locks after 10 idle
 *  minutes); after that pump.fun shows it as expired until the gateway is unlocked again. */
export const SHIELDED_TTL_MS = 10 * 60_000;
/** One click on "Unshield" goes straight through only up to the user's limit. */
export const fundIsAuto = (sol: number, f: DockPrefs["fund"]): boolean => f.autoMax > 0 && sol <= f.autoMax + 1e-9;
/** What the wallet page (wallet.html) may ask the extension's background: redeem the one-time code the dot's click put
 *  in its URL (single use, 2 minutes; nothing outside the extension can open that page or make a code, so nothing
 *  else can start a push), and report the unlocked gateway's shielded balance for pump.fun's wallet balance. */
export type GatewayRequest =
  | { type: "fund.claim"; id: string }
  | { type: "balance.report"; lamports: string; network: Network }
  /** The wallet logged out: forget the balance it reported, so pump.fun never shows another gateway's SOL. */
  | { type: "balance.clear" };
export interface FundClaim { sol: number; auto: boolean }
/** What the extension's settings page may ask its background. */
export type SettingsRequest =
  | { type: "legacy" }
  | { type: "legacyExport"; passphrase: string };
/** Push amounts from the dot: the order plus the leeway, rounded up to the step, in whole lamports. */
export function fundAmount(orderSol: number, f: DockPrefs["fund"]): number {
  const raw = orderSol * (1 + Math.max(0, f.bufferPct) / 100) + Math.max(0, f.bufferSol);
  const step = f.roundSol > 0 ? f.roundSol : 1e-9;
  return Math.round(Math.ceil(raw / step - 1e-9) * step * 1e9) / 1e9;
}

export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: string };
