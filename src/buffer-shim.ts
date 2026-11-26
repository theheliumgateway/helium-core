// Service workers have no Node `Buffer`, but @solana/web3.js, Anchor and the Streamflow SDK use it (some at load time).
// esbuild's `inject` (see build.mjs) rewrites every free `Buffer` reference in the bundle to this browser implementation.
import { Buffer } from "buffer";
export { Buffer };
