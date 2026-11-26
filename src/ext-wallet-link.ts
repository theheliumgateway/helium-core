// wallet.html: vault requests go to the worker beside the page (popup.ts reads globalThis.__heliumVault).
import { vaultLink } from "./web/vault-link";

(globalThis as unknown as { __heliumVault: unknown }).__heliumVault = vaultLink("wallet-worker.js");
