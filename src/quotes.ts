// Builds the disclosed price of a push: SOL fee (or token burn), tier discount, and whether the vault can afford it.
import { address } from "@solana/kit";
import { FEE_RESERVE_LAMPORTS, type Settings } from "./config";
import { MIN_NEW_ACCOUNT_LAMPORTS, computeFee, feeConfigured, fmtUtc } from "./fees";
import type { ActiveProduct } from "./product";
import { publicBalance, tokenProgramOf, vaultTokenAccount, type PushPlan, type VaultHandle } from "./spr";
import { getTier } from "./tiers";

export interface Quote {
  amount: string;
  /** When this quote was made (ms). The push checks it, so a fee that starts after the review is never charged unseen. */
  at: number;
  /** When the configured fee starts (ms), or 0 when it has started or none is configured. */
  feeStartsAt: number;
  /** What happens to pay the fee: nothing, SOL from the vault's public balance, or a token burn. */
  mode: "none" | "sol" | "token";
  feeBps: number;
  treasury: string | null;
  grossFeeLamports: string;
  feeLamports: string;
  discountBps: number;
  tierName: string;
  tierLevel: number;
  token: { symbol: string; decimals: number; burnAmount: string; vaultBalance: string; canPay: boolean } | null;
  publicLamports: string;
  requiredPublicLamports: string;
  sufficientPublic: boolean;
  notice: string | null;
}

export async function makeQuote(
  h: VaultHandle,
  settings: Settings,
  p: ActiveProduct,
  amount: bigint,
  payWithToken: boolean,
  now = Date.now(),
): Promise<{ quote: Quote; plan: PushPlan }> {
  // The tier comes from tokens held by the vault wallet itself, not the destination wallet.
  const tier = await getTier(h, settings.network, h.address, p);

  const breakdown = computeFee(p, amount, tier.discountBps, now);
  let fee = breakdown.fee;
  let notice: string | null = null;
  const pending = feeConfigured(p) && now < p.feeStartsAt;
  if (pending) notice = `No service fee on this push. A ${p.feeBps / 100}% service fee starts ${fmtUtc(p.feeStartsAt)}.`;

  // A transfer below the rent-exempt minimum to a brand-new account fails; skip rather than break the push.
  if (fee > 0n && p.treasury && fee < MIN_NEW_ACCOUNT_LAMPORTS) {
    const existing = await h.client.getBalance(address(p.treasury));
    if (existing === 0n) {
      fee = 0n;
      notice = "Service fee skipped: the treasury wallet has not been funded on this network yet.";
    }
  }

  // Token payment option.
  let tokenInfo: Quote["token"] = null;
  let burn: PushPlan["burn"];
  if (p.token && p.burnPerPush > 0n) {
    try {
      const tokenProgram = await tokenProgramOf(h, p.token.mint);
      const { amount: vaultBalance } = await vaultTokenAccount(h, p.token.mint, tokenProgram);
      const canPay = vaultBalance >= p.burnPerPush;
      tokenInfo = {
        symbol: p.token.symbol,
        decimals: p.token.decimals,
        burnAmount: p.burnPerPush.toString(),
        vaultBalance: vaultBalance.toString(),
        canPay,
      };
      // Only offer/apply the burn when a fee would otherwise be charged.
      if (payWithToken && breakdown.gross > 0n && fee > 0n) {
        if (!canPay) throw new Error(`The gateway holds too little ${p.token.symbol} to pay in tokens`);
        burn = { mint: address(p.token.mint), tokenProgram, amount: p.burnPerPush };
      }
    } catch (e) {
      // If the user explicitly asked to pay in tokens, fail loudly; otherwise a missing/unreadable mint just
      // means the token payment option isn't offered and the push continues with the SOL fee.
      if (payWithToken) throw e;
      tokenInfo = null;
      notice = notice ?? `${p.token.symbol} is not available on ${settings.network} right now, so paying in tokens is disabled.`;
    }
  }

  const mode: Quote["mode"] = burn ? "token" : fee > 0n ? "sol" : "none";
  const solFee = mode === "sol" ? fee : 0n;
  const pub = await publicBalance(h);
  const required = FEE_RESERVE_LAMPORTS + solFee;

  const plan: PushPlan = {};
  if (solFee > 0n && p.treasury) plan.fee = { to: address(p.treasury), lamports: solFee };
  if (burn) plan.burn = burn;

  return {
    plan,
    quote: {
      amount: amount.toString(),
      at: now,
      feeStartsAt: pending ? p.feeStartsAt : 0,
      mode,
      feeBps: p.feeBps,
      treasury: p.treasury,
      grossFeeLamports: breakdown.gross.toString(),
      feeLamports: (mode === "token" ? 0n : solFee).toString(),
      discountBps: tier.discountBps,
      tierName: tier.name,
      tierLevel: tier.level,
      token: tokenInfo,
      publicLamports: pub.toString(),
      requiredPublicLamports: required.toString(),
      sufficientPublic: pub >= required,
      notice,
    },
  };
}
