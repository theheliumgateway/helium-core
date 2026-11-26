// How hard a passphrase is to guess. The encrypted key sits in the browser, so anyone who copies it can try passphrases
// offline as fast as their hardware allows (PBKDF2 slows each guess, it can't save a common one). The worker refuses a
// weak passphrase for a new gateway, an import and a change; the page shows the same verdict while it is typed.

const COMMON = [
  "password", "passphrase", "passwort", "qwerty", "azerty", "letmein", "iloveyou", "welcome", "admin", "monkey", "dragon",
  "sunshine", "princess", "football", "baseball", "master", "shadow", "trustno1", "abc123", "helium", "solana", "phantom",
  "bitcoin", "ethereum", "crypto", "wallet", "gateway", "private", "secret", "changeme", "default",
];
const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890", "abcdefghijklmnopqrstuvwxyz"];

/** Characters that only continue a run (aaaa, abcd, 4321, qwer) add almost nothing to a guesser's work. */
function effectiveLength(p: string): number {
  const s = p.toLowerCase();
  let n = s.length ? 1 : 0;
  for (let i = 1; i < s.length; i++) {
    const a = s.charAt(i - 1), b = s.charAt(i);
    const same = a === b;
    const run = ROWS.some((r) => {
      const x = r.indexOf(a), y = r.indexOf(b);
      return x >= 0 && y >= 0 && Math.abs(x - y) === 1;
    });
    n += same || run ? 0.25 : 1;
  }
  return n;
}

/** Rough guessing work in bits: the character pool per effective character. Deliberately conservative. */
export function passphraseBits(p: string): number {
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/\d/.test(p)) pool += 10;
  if (/[^a-zA-Z\d]/.test(p)) pool += 33;
  if (!pool) return 0;
  let bits = effectiveLength(p) * Math.log2(pool);
  const lower = p.toLowerCase();
  // a common word inside it is guessed as one unit, not letter by letter
  for (const w of COMMON) if (lower.includes(w)) bits -= (w.length - 1) * Math.log2(26);
  return Math.max(0, Math.round(bits));
}

export const MIN_PASSPHRASE_LENGTH = 12;
export const MIN_PASSPHRASE_BITS = 55;

/** Why this passphrase is too weak, or null when it is fine. */
export function passphraseProblem(p: string): string | null {
  if (p.length < MIN_PASSPHRASE_LENGTH) return `Use at least ${MIN_PASSPHRASE_LENGTH} characters`;
  if (new Set(p.toLowerCase()).size < 6) return "Too repetitive: use more different characters";
  const lower = p.toLowerCase().replace(/[^a-z]/g, "");
  if (COMMON.some((w) => lower === w || lower === `${w}${w}`)) return "That passphrase is one of the first that gets guessed";
  if (passphraseBits(p) < MIN_PASSPHRASE_BITS) return "Too easy to guess: add more words, or mix in numbers and symbols";
  return null;
}

/** For the meter under the field: 0 (weak) to 3 (strong). */
export function passphraseScore(p: string): 0 | 1 | 2 | 3 {
  if (passphraseProblem(p)) return p.length >= 8 ? 1 : 0;
  return passphraseBits(p) >= 80 ? 3 : 2;
}
