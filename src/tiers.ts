// Tier lookup. A TierProvider turns "this wallet" into a tier level; everything else (fee discounts, gated features)
// only talks to getTier(), so a new source can replace the holder check without touching the rest.
//
// Phase 1 (now):  "holding"  — the tier comes from the token balance of the vault wallet (its own public address).
// Phase 2 (next): "staking"  — a provider that reads a stake account instead. Implement TierProvider and register it
//                              in PROVIDERS; nothing else changes.
import type { Network } from "./config";
import { NO_TIER, tierForBalance, type TierResult } from "./fees";
import type { ActiveProduct } from "./product";
import { tokenBalanceOf, type VaultHandle } from "./spr";
import { stakedAmountOf } from "./staking";

export interface TierProvider {
  id: string;
  resolve(h: VaultHandle, owner: string, p: ActiveProduct): Promise<TierResult>;
}

const holding: TierProvider = {
  id: "holding",
  async resolve(h, owner, p) {
    if (!p.token || p.tiers.length === 0) return NO_TIER;
    return tierForBalance(p, await tokenBalanceOf(h, owner, p.token.mint));
  },
};

/** Phase 2: the tier comes from tokens staked in the Streamflow pool (burning/moving held tokens can't lower it). */
const staking: TierProvider = {
  id: "staking",
  async resolve(h, owner, p) {
    if (!p.token || p.tiers.length === 0) return NO_TIER;
    return tierForBalance(p, await stakedAmountOf(h, owner, p));
  },
};

/** Held + staked added together. */
const both: TierProvider = {
  id: "both",
  async resolve(h, owner, p) {
    if (!p.token || p.tiers.length === 0) return NO_TIER;
    const [held, staked] = await Promise.all([tokenBalanceOf(h, owner, p.token.mint), stakedAmountOf(h, owner, p)]);
    return tierForBalance(p, held + staked);
  },
};

export const PROVIDERS: Record<string, TierProvider> = { holding, staking, both };
/** The provider the product config selects (falls back to holding when staking isn't configured). */
export const providerFor = (p: ActiveProduct): TierProvider => PROVIDERS[p.tierSource] ?? holding;

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: TierResult }>();

/** Tier for `owner`, cached briefly so quoting doesn't hammer the RPC. */
export async function getTier(h: VaultHandle, network: Network, owner: string, p: ActiveProduct): Promise<TierResult> {
  const provider = providerFor(p);
  const key = `${network}:${provider.id}:${owner}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: TierResult;
  try {
    value = await provider.resolve(h, owner, p);
  } catch {
    // A missing mint or RPC hiccup must never block a push: fall back to "no tier" (full fee) without caching it.
    return NO_TIER;
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}
export function clearTierCache() {
  cache.clear();
}
