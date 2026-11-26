// Signed token settings for mainnet: the Helium coin, its stake pool, the tiers and the burn-to-pay amount.
//
// Published at TOKEN_CONFIG_URL. Only the download build of the extension can fetch it: the Chrome Web Store build's
// security policy (manifest.json, connect-src) doesn't list heliumgateway.net, so the request is blocked there and that
// build uses only what's compiled into product.ts. The fee rate, the cap, the start time and the treasury are never
// read from here; they stay in the code.
//
// A file is used only if it is signed by TOKEN_CONFIG_KEY (an Ed25519 key kept offline, never on the website's
// server), passes every check below, and is newer than the settings already in use. So a compromised website can at
// most keep serving an older signed file, which is ignored.
import { getPublicKeyFromAddress, isAddress, verifySignature, type SignatureBytes } from "@solana/kit";

export const TOKEN_CONFIG_URL = "https://heliumgateway.net/token.json";
/** Public half of the signing key (the private half is in a file on the Helium team's computer). */
export const TOKEN_CONFIG_KEY = "81k7kHszViAMtW1cu2GDvagvxQqSSBAmy6jKZkxkHrN8";

export interface TokenConfig {
  v: 1;
  network: "mainnet";
  /** When it was signed (ms). Higher wins; an older file never replaces a newer one. */
  issued: number;
  token: { mint: string; symbol: string; decimals: number };
  staking: { pool: string; lockSeconds: number };
  tiers: { name: string; minAmount: string; discountBps: number }[];
  burnPerPush: string;
}

/** The file as served: the exact payload text that was signed, and its signature (base64). */
export interface SignedTokenConfig {
  payload: string;
  signature: string;
}

const DAY = 86_400;
const int = (n: unknown, lo: number, hi: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;
const digits = (s: unknown): s is string => typeof s === "string" && /^\d{1,30}$/.test(s);

/** Parses and checks a payload. Throws on anything unexpected: an unknown field shape never half-applies. */
export function parseTokenConfig(payload: string): TokenConfig {
  const c = JSON.parse(payload) as Partial<TokenConfig>;
  const bad = (what: string) => new Error(`Token settings rejected: ${what}`);
  if (!c || c.v !== 1) throw bad("version");
  if (c.network !== "mainnet") throw bad("network");
  if (!int(c.issued, 1_700_000_000_000, 4_102_444_800_000)) throw bad("issued");
  const t = c.token;
  if (!t || !isAddress(t.mint) || typeof t.symbol !== "string" || !/^[A-Za-z0-9]{1,10}$/.test(t.symbol) || !int(t.decimals, 0, 12)) throw bad("token");
  const s = c.staking;
  if (!s || !isAddress(s.pool) || !int(s.lockSeconds, DAY, 365 * DAY)) throw bad("staking");
  if (!Array.isArray(c.tiers) || c.tiers.length < 1 || c.tiers.length > 5) throw bad("tiers");
  for (const tier of c.tiers) {
    if (!tier || typeof tier.name !== "string" || !/^[A-Za-z ]{1,16}$/.test(tier.name) || !digits(tier.minAmount) || tier.minAmount === "0" || !int(tier.discountBps, 0, 10_000)) {
      throw bad("tier");
    }
  }
  if (!digits(c.burnPerPush)) throw bad("burnPerPush");
  return {
    v: 1, network: "mainnet", issued: c.issued,
    token: { mint: t.mint, symbol: t.symbol, decimals: t.decimals },
    staking: { pool: s.pool, lockSeconds: s.lockSeconds },
    tiers: c.tiers.map((x) => ({ name: x.name, minAmount: x.minAmount, discountBps: x.discountBps })),
    burnPerPush: c.burnPerPush,
  };
}

const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

/** Checks the signature against `key`, then the payload. Returns the settings, or throws. */
export async function verifyTokenConfig(file: unknown, key: string = TOKEN_CONFIG_KEY): Promise<TokenConfig> {
  const f = file as Partial<SignedTokenConfig> | null;
  if (!f || typeof f.payload !== "string" || f.payload.length > 4096 || typeof f.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(f.signature)) {
    throw new Error("Token settings rejected: malformed file");
  }
  if (!isAddress(key)) throw new Error("Token settings: no signing key in this build");
  const ok = await verifySignature(await getPublicKeyFromAddress(key), fromB64(f.signature) as SignatureBytes, new TextEncoder().encode(f.payload));
  if (!ok) throw new Error("Token settings rejected: bad signature");
  return parseTokenConfig(f.payload);
}
