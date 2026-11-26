// Offline checks of the relayer's transaction screening (server/relay.mjs) and the fee math the wallet and the
// relayer must agree on (src/hop.ts). No network. Run: node test/relay.test.mjs
import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage,
  generateKeyPairSigner, getTransactionEncoder, partiallySignTransaction, pipe, setTransactionMessageConfig,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { SHIELDED_POOL_PROGRAM_ID } from "@heliuslabs/spr";
import { inspectRelayTx, relayFee as serverFee } from "../server/relay.mjs";
import { relayFee as walletFee } from "../src/hop.ts";

let failed = 0;
const ok = (cond, name) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) failed++; };

const relayer = await generateKeyPairSigner();
const hop = await generateKeyPairSigner();
const recipient = (await generateKeyPairSigner()).address;
const lifetime = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1n };

// stands in for the Privacy Rings withdrawal: the relayer pays, the one-time key signs, the recipient is written to
const ringIx = (accounts = [[relayer.address, AccountRole.WRITABLE_SIGNER], [hop.address, AccountRole.READONLY_SIGNER], [recipient, AccountRole.WRITABLE]]) => ({
  programAddress: SHIELDED_POOL_PROGRAM_ID,
  accounts: accounts.map(([a, role]) => ({ address: a, role })),
  data: new Uint8Array([1, 2, 3]),
});
async function wire(feePayer, instructions, signers = [hop]) {
  const tx = compileTransaction(pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => setTransactionMessageConfig({ computeUnitLimit: 450_000 }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  ));
  const signed = signers.length ? await partiallySignTransaction(signers.map((s) => s.keyPair), tx) : tx;
  return new Uint8Array(getTransactionEncoder().encode(signed));
}
const problems = (bytes, to = recipient) => inspectRelayTx(bytes, relayer.address, to).problems;

ok(problems(await wire(relayer.address, [ringIx()])).length === 0, "a lone Privacy Rings withdrawal the relayer pays for passes");
ok(problems(await wire(hop.address, [ringIx()])).includes("The relayer must be the fee payer"), "someone else as fee payer is refused");
{
  const drain = getTransferSolInstruction({ source: { address: relayer.address, signTransactions: async () => [] }, destination: hop.address, amount: 1_000_000_000n });
  const p = problems(await wire(relayer.address, [ringIx(), drain]));
  ok(p.includes("Only one instruction is allowed") && p.includes("Only the Privacy Rings program may be called"), "an extra transfer out of the relayer is refused");
}
{
  const drain = getTransferSolInstruction({ source: { address: relayer.address, signTransactions: async () => [] }, destination: hop.address, amount: 1n });
  ok(problems(await wire(relayer.address, [drain], [])).includes("Only the Privacy Rings program may be called"), "a plain transfer instead of a withdrawal is refused");
}
ok(problems(await wire(relayer.address, [ringIx()], [])).some((p) => p.startsWith("Missing signature")), "a withdrawal the one-time key hasn't signed is refused");
ok(problems(await wire(relayer.address, [ringIx()]), address("11111111111111111111111111111112")).includes("The recipient isn't in the transaction"), "a recipient that isn't in the transaction is refused");
ok(problems(new Uint8Array([1, 2, 3])).includes("The transaction can't be decoded"), "garbage is refused");

// the fee: both sides compute the same number
const info = { feeBps: 30, minFeeLamports: "3000000" };
for (const amount of [1n, 50_000_000n, 1_000_000_000n, 1_000_000_000_000n]) {
  ok(walletFee(amount, info) === serverFee(amount, 30, 3_000_000n), `fee for ${amount} lamports matches (${walletFee(amount, info)})`);
}
ok(walletFee(1_000_000_000n, info) === 3_000_000n, "0.3% of 1 SOL is 0.003 SOL");
ok(walletFee(10_000_000n, info) === 3_000_000n, "a small push pays the minimum");

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
