// Passphrase-based encryption for the vault seed (PBKDF2-SHA256 -> AES-256-GCM).
const ITERATIONS = 600_000;

export interface EncryptedBlob {
  salt: string;
  iv: string;
  ct: string;
  iterations: number;
}

const b64 = (u: Uint8Array): string => {
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSeed(passphrase: string, seed: Uint8Array): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, seed as BufferSource));
  return { salt: b64(salt), iv: b64(iv), ct: b64(ct), iterations: ITERATIONS };
}

/** Throws "Wrong passphrase" when authentication fails. */
export async function decryptSeed(passphrase: string, blob: EncryptedBlob): Promise<Uint8Array> {
  const key = await deriveKey(passphrase, unb64(blob.salt), blob.iterations);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) }, key, unb64(blob.ct));
    return new Uint8Array(pt);
  } catch {
    throw new Error("Wrong passphrase");
  }
}

/* ── passkey unlock ──
 * A passkey with the WebAuthn PRF extension returns 32 secret bytes for a given input (salt), and only after the user
 * verifies (fingerprint, face, PIN). Those bytes never leave the authenticator unasked and are never stored: they are
 * stretched with HKDF into an AES key that wraps the same seed the passphrase wraps. */
export interface PasskeyWrap {
  iv: string;
  ct: string;
}
async function prfKey(prf: Uint8Array): Promise<CryptoKey> {
  if (prf.length < 32) throw new Error("The passkey returned too little key material");
  const base = await crypto.subtle.importKey("raw", prf as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("helium passkey unlock v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function wrapSeedWithPasskey(prf: Uint8Array, seed: Uint8Array): Promise<PasskeyWrap> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await prfKey(prf), seed as BufferSource));
  return { iv: b64(iv), ct: b64(ct) };
}
/** Throws "That passkey can't unlock this gateway" when the key material doesn't match. */
export async function unwrapSeedWithPasskey(prf: Uint8Array, w: PasskeyWrap): Promise<Uint8Array> {
  const key = await prfKey(prf);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(w.iv) }, key, unb64(w.ct)));
  } catch {
    throw new Error("That passkey can't unlock this gateway");
  }
}

export const toHex = (u: Uint8Array): string => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
export function fromHex(h: string): Uint8Array {
  const clean = h.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) throw new Error("Invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
