export type Network = "devnet" | "mainnet";

export interface Settings {
  network: Network;
  /** Helius API key. Authenticates the project; it can never authorize spending. */
  apiKey: string;
  /** The primary address "Push to main" sends to. Also the wallet whose token holdings set the fee tier. */
  mainWallet: string;
  /** Additional saved destinations (a tier-gated feature). Push can only ever go to mainWallet or one of these. */
  extraDestinations: string[];
  /** Lock after this many idle minutes. */
  autolockMinutes: number;
  /** While the wallet is open and unlocked, shield public SOL that arrives (above the fee reserve) automatically. */
  autoShield: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  network: "mainnet",
  apiKey: "",
  mainWallet: "",
  extraDestinations: [],
  autolockMinutes: 10,
  autoShield: false,
};

/** Public SOL kept in the vault key to pay fees and nullifier-account rent on withdrawal. */
export const FEE_RESERVE_LAMPORTS = 10_000_000n; // 0.01 SOL (estimate, not measured)
/** Auto-shield leaves smaller amounts alone: a deposit for dust costs more in fees than it hides. */
export const AUTO_SHIELD_MIN_LAMPORTS = 5_000_000n; // 0.005 SOL

/** The pay page a gateway's payment link opens (its deposit code rides in the fragment, never sent to the server). */
export const PAY_PAGE = "https://heliumgateway.net/pay/";

export function rpcUrl(s: Settings): string {
  const host = s.network === "mainnet" ? "mainnet.helius-rpc.com" : "devnet.helius-rpc.com";
  return `https://${host}/?api-key=${encodeURIComponent(s.apiKey)}`;
}

export function explorerTx(s: Settings, sig: string): string {
  const cluster = s.network === "mainnet" ? "" : "?cluster=devnet";
  return `https://orbmarkets.io/tx/${sig}${cluster}`;
}
