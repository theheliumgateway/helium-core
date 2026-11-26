# Helium core

This is the source of the code in the Helium browser extension that handles your key and your SOL. You can read it, build it, and check that the extension in the Chrome Web Store runs exactly this code.

Helium keeps SOL in a Helius Privacy Rings balance that only your key can read. You move SOL in, then push it back out to wallets you've saved.

## What's here

| Path | What it does |
|---|---|
| `src/background.ts` | The wallet worker: creates, encrypts, unlocks and locks the key, and builds and signs every transaction. The key exists only inside this worker. Logging out sets a gateway aside on the device, still encrypted, so another can be opened. |
| `src/crypto.ts` | Encrypts the key with your passphrase (PBKDF2-SHA256, 600,000 rounds, then AES-256-GCM), or with a passkey (WebAuthn PRF, then HKDF and AES-256-GCM). |
| `src/spr.ts` | Shielding, private transfers and pushes through the Privacy Rings SDK (`@heliuslabs/spr`). |
| `src/product.ts`, `src/fees.ts`, `src/tiers.ts`, `src/quotes.ts` | The service fee and how it's quoted. On mainnet: 0.5% of each push, at most 0.2 SOL, paid to `7xjjCNA696brh5PAcyuYKQwZWBKpKDdqWoL9as3c6uuf`, from 28 Nov 2026, 17:30 UTC. |
| `src/staking.ts`, `src/stakeEntry.ts` | Staking. |
| `src/ext-background.ts` | The extension's service worker. It never sees the key. It checks every message from the trading dot, and answers only the requests in `DockRequest` (`src/messages.ts`). |
| `src/popup.ts`, `src/dot-settings.ts`, `src/ext-wallet.ts` | The wallet page you see. It sends the worker the requests in `src/messages.ts` and nothing else. |
| `src/hop.ts`, `server/relay.mjs` | The relayed push (prototype, devnet only, see below). |
| `test/` | Tests for all of the above. |

### What isn't here

The trading dot (`dock.js` in the extension) and the website are left out.

The dot runs inside trading sites as a content script. It never holds the key or sees an address. All it can do is send the service worker the requests listed in `DockRequest`, and `src/ext-background.ts` checks them. The answer it gets back is `DockState`:

- On pump.fun, it includes the private balance the wallet last reported, so it can be added to pump.fun's wallet balance. This is on by default and can be turned off in Dot settings. The balance is deleted 10 minutes after the wallet last reported it.
- Anywhere else, it never includes a balance.

Clicking the dot's Unshield only opens the wallet window with an amount filled in. The push itself happens in the wallet page and its worker, which are in this repository.

## Check the extension against this code

You need Node 22 or later.

```
npm ci
npm run verify -- <path to the extension>
```

The path can be:

- the `.crx` file from the Chrome Web Store;
- or the folder Chrome installed it in. Open `chrome://version`, find the line called Profile Path, and look in `<Profile Path>/Extensions/<extension id>/<version>/`.

`verify` builds `background.js`, `wallet.js` and `wallet-worker.js` from this source, then compares each one byte for byte with the extension's copy. It prints `SAME` or `DIFFERENT` for each file. The bundles aren't minified, so you can also read them in the installed folder.

## Run the tests

```
npm test
```

They run offline:

- `test/vault.test.mjs`: passphrase rules, passkey unlock, changing the passphrase, auto-lock.
- `test/load-bg.mjs`: what the trading dot is allowed to ask the service worker.
- `test/relay.test.mjs`: the relayer's transaction checks, and that the wallet and the relayer agree on the fee.
- The fee, staking and send-everything tests.

`test/relay-devnet.mjs` runs a full relayed push on Solana devnet, using worthless test keys. It needs a Helius API key in `HELIUS_API_KEY`.

## What other people can see

The chain is public, so here is what anyone can see, and what they can't.

- **Moving SOL into the ring.** Public: your gateway address and the amount.
- **Inside the ring.** Private: the balance, and who paid whom. Anyone can see that a private transfer happened, and which gateway signed it.
- **A push out.** Public: the gateway that sent it, the amount and the destination. Your gateway signs the push and pays its network fee, so a push to your main wallet links the two.

### The relayed push (prototype)

The relayed push is how we plan to stop a push linking back to your gateway. It isn't in the extension yet.

1. Your gateway privately sends the amount to a one-time key of its own. In the same private transfer, it pays the service fee to Helium's treasury.
2. The one-time key withdraws the amount to the destination. Helium's relayer pays the network fee.

The withdrawal names only the one-time key, never your gateway. The relayer signs it only if all of these hold:

- it's a single Privacy Rings instruction;
- the relayer is the fee payer;
- every other signer has already signed;
- simulated, it pays the stated recipient exactly the stated amount;
- step 1 paid the treasury at least the fee for that amount;
- that fee hasn't already paid for another push.

The relayer never holds a key that can move your SOL. It keeps one record: the fee payments already used, so one fee can't pay for two pushes.

The relayer can still see which one-time key matches which withdrawal, and the time between the two steps can link them. Both are listed as open problems, and fixing them comes before mainnet.

Relay API (JSON over HTTPS):

- `GET /api/relay/info` returns `{ network, relayer, treasury, feeBps, minFeeLamports }`.
- `POST /api/relay/push` takes `{ feeSignature, amount, recipient, tx }`, where `tx` is the withdrawal in base64, already signed by the one-time key. It returns `{ signature, cost }`.

## Reporting a security problem

Please open a private security advisory on this repository (the Security tab, then "Report a vulnerability") rather than a public issue.

## License

Business Source License 1.1. See [LICENSE](LICENSE). Anyone can read, build, verify, audit and test this code, and run the Helium extension for their own use. Commercial use needs a license from Helium. On 2030-11-26 the code becomes Apache 2.0.
