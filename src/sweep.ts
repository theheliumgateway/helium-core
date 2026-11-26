// Pure planner for sending the vault's PUBLIC SOL to a saved destination (no I/O, unit-tested).
//
// Solana rules this has to respect:
//  - the network fee (5,000 lamports for one signature) comes out of the same balance;
//  - a system account may not be left holding 1..(rent-exempt minimum - 1) lamports: it must keep at least the
//    minimum or be emptied to exactly 0;
//  - a transfer into an account that doesn't exist yet must itself be at least the rent-exempt minimum.

export const NETWORK_FEE_LAMPORTS = 5_000n;
/** Rent-exempt minimum for a 0-data system account. */
export const RENT_EXEMPT_MIN = 890_880n;

export interface PublicSendPlan {
  /** Lamports delivered to the destination. */
  amount: bigint;
  /** Lamports left in the vault afterwards (0 when everything was sent). */
  remaining: bigint;
}

export function planPublicSend(balance: bigint, requested: bigint | "all", destinationBalance: bigint): PublicSendPlan {
  const amount = requested === "all" ? balance - NETWORK_FEE_LAMPORTS : requested;
  if (amount <= 0n) throw new Error("Nothing to send: the gateway's public balance doesn't cover the network fee");
  const remaining = balance - amount - NETWORK_FEE_LAMPORTS;
  if (remaining < 0n) {
    throw new Error(`Not enough public SOL: the amount plus a ${NETWORK_FEE_LAMPORTS} lamport network fee exceeds the balance`);
  }
  if (remaining !== 0n && remaining < RENT_EXEMPT_MIN) {
    throw new Error(
      "That would leave a tiny remainder Solana doesn't allow. Send everything, or leave at least 0.00089 SOL in the gateway.",
    );
  }
  if (destinationBalance === 0n && amount < RENT_EXEMPT_MIN) {
    throw new Error("The destination has no SOL yet, so the first transfer to it must be at least 0.00089 SOL");
  }
  return { amount, remaining };
}
