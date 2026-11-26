// The wallet, as a page of the Helium extension (wallet.html). The key-holding worker runs under the extension's own
// origin, so its storage and memory are out of reach of web pages and of other extensions (Chrome doesn't let one
// extension run scripts in another's pages). The real chrome.runtime stays available to this page for the dot's
// one-time Unshield codes and the balance shown on pump.fun (src/ext-background.ts).
// The link to the worker is installed first (imports run in order), then the wallet UI.
import "./ext-wallet-link";
import "./popup";
