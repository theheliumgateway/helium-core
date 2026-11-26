// Helius Solana Privacy Rings operations: shield (deposit), read private balance, withdraw to a public address, and
// send privately to another gateway's private address.
// Flow follows https://www.helius.dev/docs/privacy/guides/{deposit,withdraw,read-balance}.md (SDK 0.9.0-alpha).
import {
  SOL_MINT, ShieldedAddress, ShieldedKeypair, SigningKey, Wallet, buildTransferTransaction, createSprClient, syncWallet,
} from "@heliuslabs/spr";
import { atSlot, LocalKeys, SignedTeePolicy } from "@heliuslabs/spr/client";
import { bytes32, initializePoseidon, isPoseidonInitialized } from "@heliuslabs/spr/keypair";
import {
  DepositAsset,
  TransactWithdrawal,
  depositInstruction,
  transactInstruction,
} from "@heliuslabs/spr/interface";
import {
  AssetRegistry,
  ConfidentialTransfer,
  ProofInputUtxo,
  WithdrawalTarget,
  decryptToBalances,
} from "@heliuslabs/spr/transaction";
import {
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createTransactionMessage,
  getBase58Decoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  signTransactionWithSigners,
  sendTransactionWithoutConfirmingFactory,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenPda, getBurnInstruction } from "@solana-program/token";
import { AUTO_SHIELD_MIN_LAMPORTS, FEE_RESERVE_LAMPORTS, rpcUrl, type Settings } from "./config";
import { planPublicSend } from "./sweep";

type Client = Awaited<ReturnType<typeof createSprClient>>;
type IndexedTx = Parameters<typeof decryptToBalances>[0]["transactions"][number];

/** Solana's per-transaction input limit for a private spend (see Helius UTXO docs). */
const MAX_INPUT_UTXOS = 40;

export interface VaultHandle {
  client: Client;
  keypair: ShieldedKeypair;
  signer: ReturnType<ShieldedKeypair["toSolanaSigner"]>;
  assets: AssetRegistry;
  /** Public Solana address of the vault key. Fund this with a little SOL for fees. */
  address: string;
  /** The SDK's view of the private balance: syncing it finds deposits and private transfers sent to this gateway. */
  wallet: Wallet;
  keys: LocalKeys;
}

export function openVault(seed: Uint8Array, settings: Settings): Promise<VaultHandle> {
  if (!settings.apiKey) throw new Error("Add your Helius API key in Settings first");
  // The remote prover refuses requests unless the client verifies its TEE attestation against a signed policy
  // (the SDK pins the release signers per network). Without this, proving fails with CLIENT_INVALID_CONFIG {field: "tee"}.
  return createSprClient({
    solanaRpcUrl: rpcUrl(settings),
    proverTee: SignedTeePolicy.forNetwork(settings.network),
  }).then(async (client) => {
    // Shielded-address derivation hashes with Poseidon; fail early rather than mid-flow.
    if (!isPoseidonInitialized()) await initializePoseidon();
    const keypair = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(bytes32(seed)));
    const signer = keypair.toSolanaSigner();
    const wallet = new Wallet({ identity: keypair.shieldedAddress() });
    const keys = LocalKeys.fromKeypair(keypair, client.proofService);
    return { client, keypair, signer, assets: new AssetRegistry(), address: signer.address, wallet, keys };
  });
}

/* ───────── the private address: what another gateway, or the pay page, sends to ───────── */

/** A ShieldedAddress is 96 bytes (signing || nullifier || viewing public keys); shared as base58 text. */
const PRIVATE_ADDRESS_BYTES = 96;
export function privateAddressOf(h: VaultHandle): string {
  return getBase58Decoder().decode(h.keypair.shieldedAddress().toBytes());
}
/**
 * The payment link's deposit code: view tag (32 bytes) then owner hash (32 bytes), the two values a deposit to this
 * gateway's private balance names. The pay page builds the deposit from them without hashing anything itself (the
 * owner hash needs Poseidon, a 4 MB wasm the extension already has). The code can receive deposits only, never a
 * private transfer, so the link shares less than the private address.
 */
export function depositCodeOf(h: VaultHandle): string {
  const a = h.keypair.shieldedAddress();
  const code = new Uint8Array(64);
  code.set(a.confidentialViewTag(), 0);
  code.set(a.ownerHash(), 32);
  return getBase58Decoder().decode(code);
}
/** Parses a pasted private address; a public Solana address (32 bytes) gets its own explanation. */
export function parsePrivateAddress(text: string): ShieldedAddress {
  const t = text.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(t)) throw new Error("That isn't a Helium private address");
  const bytes = new Uint8Array(getBase58Encoder().encode(t));
  if (bytes.length === 32) throw new Error("That's a public Solana address. Private sends need the other gateway's private address (its Receive screen).");
  if (bytes.length === 64) throw new Error("That's a payment-link code, not a private address. Ask for the private address from their Receive screen.");
  if (bytes.length !== PRIVATE_ADDRESS_BYTES) throw new Error("That isn't a Helium private address");
  try {
    return ShieldedAddress.fromBytes(bytes);
  } catch {
    throw new Error("That isn't a valid private address");
  }
}

/** Public address for a seed without touching the network. */
export function vaultAddress(seed: Uint8Array): string {
  return ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(bytes32(seed))).toSolanaSigner().address;
}

export function newSeed(): Uint8Array {
  return SigningKey.generate("ed25519").secretBytes();
}

export function sendAndConfirmFactory(h: VaultHandle) {
  const send = sendTransactionWithoutConfirmingFactory({ rpc: h.client.solanaRpc });
  return async (instructions: readonly Instruction[]) => {
    const { value: lifetime } = await h.client.solanaRpc.getLatestBlockhash().send();
    const signed = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 1 }),
        (m) => setTransactionMessageFeePayerSigner(h.signer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) =>
          setTransactionMessageConfig(
            { computeUnitLimit: 450_000, loadedAccountsDataSizeLimit: 64 * 1024 * 1024 },
            m,
          ),
        (m) => appendTransactionMessageInstructions(instructions, m),
      ),
    );
    assertIsTransactionWithBlockhashLifetime(signed);
    await send(signed, { commitment: "confirmed" });
    const signature = getSignatureFromTransaction(signed);
    const slot = await h.client.confirmTransaction(signature);
    return { signature, slot };
  };
}

export async function publicBalance(h: VaultHandle): Promise<bigint> {
  return h.client.getBalance(address(h.address));
}

/**
 * The private SOL balance and its notes. Syncs the SDK wallet, which finds deposits (your own shields and the pay
 * page's) and private transfers from other gateways, which are tagged per sender and invisible to a plain tag read.
 * If that sync fails, falls back to reading the deposit tag alone, so the balance and pushes keep working; private
 * transfers then show up on the next successful sync.
 */
export async function privateSol(h: VaultHandle, requireSlot?: bigint) {
  try {
    await syncWallet({ client: h.client, wallet: h.wallet, keys: h.keys, ...(requireSlot ? { config: { requireSlot } } : {}) });
    return h.wallet.balance(SOL_MINT);
  } catch (e) {
    console.warn("wallet sync failed; reading deposits only", e);
    return depositTagBalance(h);
  }
}

/** Fetch every encrypted event for this wallet's deposit view tag and decrypt locally. */
async function depositTagBalance(h: VaultHandle) {
  const tag = h.keypair.shieldedAddress().confidentialViewTag();
  const txs: IndexedTx[] = [];
  let token: Awaited<ReturnType<Client["getShieldedTransactionsByTags"]>>["paginationToken"] = null;
  do {
    const page: Awaited<ReturnType<Client["getShieldedTransactionsByTags"]>> =
      await h.client.getShieldedTransactionsByTags({
        tags: [tag],
        limit: 100,
        ...(token ? { paginationToken: token } : {}),
      });
    for (const item of page.data) txs.push(...item.events);
    token = page.paginationToken;
  } while (token);

  const balances = await decryptToBalances({ keypair: h.keypair, registry: h.assets, transactions: txs });
  return balances.balance(SOL_MINT);
}

/** Public -> private, to the vault's own shielded address. Visible on-chain: sender, amount. */
export async function shield(h: VaultHandle, lamports: bigint): Promise<string> {
  if (lamports <= 0n) throw new Error("Amount must be greater than zero");
  const pub = await publicBalance(h);
  if (pub < lamports + FEE_RESERVE_LAMPORTS) {
    throw new Error(
      `Gateway public balance too low: need amount + ${FEE_RESERVE_LAMPORTS} lamports fee reserve, have ${pub}`,
    );
  }
  const me = h.keypair.shieldedAddress();
  const ix = await depositInstruction({
    tree: h.client.tree,
    depositor: h.signer,
    deposits: [
      {
        asset: DepositAsset.sol(),
        viewTag: me.confidentialViewTag(),
        recipientOwnerHash: me.ownerHash(),
        amount: lamports,
      },
    ],
  });
  const tx = await sendAndConfirmFactory(h)([ix]);
  return tx.signature;
}

/** What auto-shield would move now: everything above the fee reserve, or nothing below the minimum. */
export function autoShieldAmount(publicLamports: bigint): bigint {
  const spare = publicLamports - FEE_RESERVE_LAMPORTS;
  return spare >= AUTO_SHIELD_MIN_LAMPORTS ? spare : 0n;
}

/**
 * Private -> another gateway's private address, as one confidential transfer: the chain shows that this gateway's
 * public address paid a transaction fee into the pool, not who received what or how much. The recipient finds it the
 * next time its wallet syncs. No service fee: that is charged when SOL leaves the pool.
 */
export async function sendPrivate(h: VaultHandle, to: ShieldedAddress, lamports: bigint): Promise<{ signature: string; lamports: bigint }> {
  if (lamports <= 0n) throw new Error("Amount must be greater than zero");
  const pub = await publicBalance(h);
  if (pub < FEE_RESERVE_LAMPORTS) {
    throw new Error(`The gateway needs about ${FEE_RESERVE_LAMPORTS} lamports of public SOL for the network fee; it has ${pub}`);
  }
  const bal = await privateSol(h);
  if (lamports > bal.amount) throw new Error(`Amount exceeds private balance (${bal.amount} lamports)`);
  const tx = await buildTransferTransaction({
    client: h.client, wallet: h.wallet, keys: h.keys, feePayer: h.signer.address, recipient: to, amount: lamports,
  });
  const signed = await signTransactionWithSigners([h.signer], tx);
  const signature = getSignatureFromTransaction(signed);
  await h.client.solanaRpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" })
    .send();
  const slot = await h.client.confirmTransaction(signature);
  // Block until the indexer has it, so the next balance read is fresh (and no note is spent twice).
  await h.client.getShieldedTransactionsBySignature(signature, atSlot(slot));
  return { signature, lamports };
}

/**
 * Public SOL in the vault wallet -> a saved destination. A plain system transfer (no ring involved), so amount and
 * destination are public. The destination is a parameter, never taken from the UI: the worker passes a saved one.
 */
export async function sendPublicSol(
  h: VaultHandle,
  to: string,
  requested: bigint | "all",
): Promise<{ signature: string; lamports: bigint; remaining: bigint }> {
  const destination = address(to);
  const [balance, destBalance] = await Promise.all([publicBalance(h), h.client.getBalance(destination)]);
  const plan = planPublicSend(balance, requested, destBalance);
  const ix = getTransferSolInstruction({ source: h.signer, destination, amount: plan.amount });
  const tx = await sendAndConfirmFactory(h)([ix]);
  return { signature: tx.signature, lamports: plan.amount, remaining: plan.remaining };
}

/** Sum of a wallet's balances of one mint across all its token accounts (smallest units). */
export async function tokenBalanceOf(h: VaultHandle, owner: string, mint: string): Promise<bigint> {
  const res = (await h.client.solanaRpc
    .getTokenAccountsByOwner(address(owner), { mint: address(mint) }, { encoding: "jsonParsed" })
    .send()) as unknown as {
    value: { account: { data: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }[];
  };
  let total = 0n;
  for (const a of res.value) {
    const amt = a.account.data.parsed?.info?.tokenAmount?.amount;
    if (amt && /^\d+$/.test(amt)) total += BigInt(amt);
  }
  return total;
}

/** Token program that owns a mint (classic SPL Token or Token-2022). */
export async function tokenProgramOf(h: VaultHandle, mint: string): Promise<Address> {
  const acct = await h.client.getAccount(address(mint));
  if (!acct) throw new Error("Token mint not found on this network");
  return acct.owner;
}

/** The vault's own associated token account for a mint, and how much it holds. */
export async function vaultTokenAccount(h: VaultHandle, mint: string, tokenProgram: Address) {
  const [ata] = await findAssociatedTokenPda({ owner: address(h.address), mint: address(mint), tokenProgram });
  let amount = 0n;
  try {
    const r = await h.client.solanaRpc.getTokenAccountBalance(ata).send();
    amount = BigInt(r.value.amount);
  } catch {
    /* account does not exist yet */
  }
  return { ata, amount };
}

/** Extra instructions that ride in the same transaction as the withdrawal, so they succeed or fail together. */
export interface PushPlan {
  fee?: { to: Address; lamports: bigint };
  burn?: { mint: Address; tokenProgram: Address; amount: bigint };
}

/**
 * Private -> public. The destination is a parameter of this function, not of any message from the UI:
 * the caller (background worker) always passes a saved destination.
 *
 * `plan` is called with the final amount and returns the disclosed fee and/or token burn to append atomically.
 */
export async function pushToMain(
  h: VaultHandle,
  main: string,
  lamports: bigint | "all",
  plan: (amount: bigint) => Promise<PushPlan> = async () => ({}),
): Promise<{
  signature: string;
  lamports: bigint;
  plan: PushPlan;
}> {
  const recipient = address(main);
  const bal = await privateSol(h);
  if (bal.amount === 0n) throw new Error("Private balance is empty");

  // Pick inputs: largest first, capped at the per-transaction limit.
  const sorted = [...bal.utxos].sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0));
  const picked = sorted.slice(0, MAX_INPUT_UTXOS);
  const spendable = picked.reduce((s, u) => s + u.amount, 0n);
  const amount = lamports === "all" ? spendable : lamports;
  if (amount <= 0n) throw new Error("Amount must be greater than zero");
  if (amount > spendable) {
    throw new Error(
      spendable < bal.amount
        ? `One transaction can spend at most ${MAX_INPUT_UTXOS} private notes (${spendable} lamports). Push that, then push again.`
        : `Amount exceeds private balance (${bal.amount} lamports)`,
    );
  }
  const extra = await plan(amount);
  const pub = await publicBalance(h);
  const needed = FEE_RESERVE_LAMPORTS + (extra.fee?.lamports ?? 0n);
  if (pub < needed) {
    throw new Error(`Gateway needs about ${needed} lamports of public SOL (network fees + service fee); it has ${pub}`);
  }
  if (extra.burn) {
    const { amount: held } = await vaultTokenAccount(h, extra.burn.mint, extra.burn.tokenProgram);
    if (held < extra.burn.amount) throw new Error("Gateway does not hold enough tokens to pay the fee in tokens");
  }

  const inputs = picked.map((u) => ProofInputUtxo.fromKeypair(u, h.keypair));
  const withdrawal = new ConfidentialTransfer(h.keypair.shieldedAddress(), inputs, h.signer.address);
  withdrawal.withdraw(SOL_MINT, amount, WithdrawalTarget.sol({ recipient }));
  const proofInputs = withdrawal.sign(h.keypair, h.assets);
  const keys = LocalKeys.fromKeypair(h.keypair, h.client.proofService);
  const data = await h.client.proveTransact(proofInputs, keys);
  const ix = await transactInstruction({
    payer: h.signer,
    ownerSigners: [h.signer],
    inputTree: h.client.tree,
    outputTree: h.client.tree,
    withdrawal: TransactWithdrawal.sol({ recipient }),
    data,
  });
  const ixs: Instruction[] = [ix];
  if (extra.fee && extra.fee.lamports > 0n) {
    ixs.push(getTransferSolInstruction({ source: h.signer, destination: extra.fee.to, amount: extra.fee.lamports }));
  }
  if (extra.burn && extra.burn.amount > 0n) {
    const { ata } = await vaultTokenAccount(h, extra.burn.mint, extra.burn.tokenProgram);
    ixs.push(
      getBurnInstruction(
        { account: ata, mint: extra.burn.mint, authority: h.signer, amount: extra.burn.amount },
        { programAddress: extra.burn.tokenProgram },
      ),
    );
  }
  const tx = await sendAndConfirmFactory(h)(ixs);
  // Block until the indexer has the event so the next balance read is fresh.
  await h.client.getShieldedTransactionsBySignature(tx.signature, atSlot(tx.slot));
  return { signature: tx.signature, lamports: amount, plan: extra };
}
