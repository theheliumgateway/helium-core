// Pure decoder for a Streamflow stake-pool "StakeEntry" account (Anchor layout, program stake_pool v2.7.0).
// Kept SDK-free so the tier lookup stays small and unit-testable. Offsets come from the program's IDL:
//   8  discriminator | u32 nonce | pubkey stake_pool | pubkey payer | pubkey authority | u64 amount | u64 duration |
//   u128 effective_amount | u64 created_ts | u64 closed_ts | u128 prior_total_effective_stake | u64 unstake_ts | ...
export const STAKE_POOL_PROGRAM_ID = "STAKEvGqQTtzJZH6BWDcbpzXXn2BBerPAgQ3EGLN2GH";
/** Byte offsets of the fields we filter on. */
export const OFFSET_STAKE_POOL = 12;
export const OFFSET_PAYER = 44;

export interface StakeEntryInfo {
  nonce: number;
  amount: bigint;
  /** Lock length in seconds. */
  duration: bigint;
  createdTs: bigint;
  closedTs: bigint;
  unstakeTs: bigint;
}

export function decodeStakeEntry(data: Uint8Array): StakeEntryInfo {
  if (data.length < 180) throw new Error("Not a stake entry account");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    nonce: v.getUint32(8, true),
    amount: v.getBigUint64(108, true),
    duration: v.getBigUint64(116, true),
    createdTs: v.getBigUint64(140, true),
    closedTs: v.getBigUint64(148, true),
    unstakeTs: v.getBigUint64(172, true),
  };
}

/** An entry counts toward the tier while it is open and no unstake has been requested. */
export const isActiveEntry = (e: StakeEntryInfo): boolean => e.closedTs === 0n && e.unstakeTs === 0n;
/** Unix seconds when the lock ends. */
export const unlockTs = (e: StakeEntryInfo): bigint => e.createdTs + e.duration;
