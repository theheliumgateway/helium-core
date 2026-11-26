// Builds the three open bundles of the Helium extension with exactly the settings the release uses:
//   background.js     the extension's service worker (src/ext-background.ts)
//   wallet.js         the wallet page (src/ext-wallet.ts)
//   wallet-worker.js  the worker that holds the key and signs (src/web/worker.ts -> src/background.ts)
// The fourth file in the extension, dock.js (the trading dot), isn't part of this repository. It runs inside trading
// sites as a content script, never sees the key, and can only send the requests listed in src/messages.ts
// (DockRequest), which src/ext-background.ts checks.
import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

const shared = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  sourcemap: false,
  logLevel: "info",
  define: { global: "globalThis" },
};

await build({ ...shared, entryPoints: { background: "src/ext-background.ts" }, outdir: "dist" });
await build({ ...shared, entryPoints: { wallet: "src/ext-wallet.ts" }, outdir: "dist" });
await build({ ...shared, inject: ["src/buffer-shim.ts"], entryPoints: { "wallet-worker": "src/web/worker.ts" }, outdir: "dist" });
console.log("built -> dist/ (compare with the published extension: npm run verify -- <extension .zip, .crx or folder>)");
