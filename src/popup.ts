import { AUTOLOCK_CHOICES, type Balances, type FundClaim, type PasskeyInfo, type Quote, type Request, type Response, type Status } from "./messages";
import { MIN_PASSPHRASE_LENGTH, passphraseProblem, passphraseScore } from "./strength";
import { NETWORK_FEE_LAMPORTS, RENT_EXEMPT_MIN, planPublicSend } from "./sweep";
import { AUTO_SHIELD_MIN_LAMPORTS } from "./config";
import { dotSettingsView } from "./dot-settings";
import { fmtUtc } from "./fees";

/* ───────────────────────── helpers ───────────────────────── */

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** The wallet page (wallet.html, src/ext-wallet.ts): vault requests go to the key-holding worker beside the page;
 *  chrome.runtime is the extension's own (the dot's one-time codes, the pump.fun balance). */
const toVault = (globalThis as unknown as { __heliumVault?: (req: unknown) => Promise<unknown> }).__heliumVault
  ?? (async () => ({ ok: false, error: "The wallet's worker isn't running. Reopen the wallet." }));

function send<T>(req: Request): Promise<T> {
  return (toVault(req) as Promise<Response<T>>).then((r) => {
    if (!r.ok) throw new Error(r.error);
    return r.data;
  });
}

/** Exact decimal string for a lamport amount (used for inputs and summaries). */
const fmt = (lamports: string | bigint): string => {
  const v = BigInt(lamports);
  const whole = v / LAMPORTS_PER_SOL;
  const frac = (v % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
};
/** Compact display value (never used for logic). */
const fmtShort = (lamports: string | bigint): string => {
  const v = BigInt(lamports);
  if (v === 0n) return "0";
  if (v < 100_000n) return "<0.0001";
  return (Number(v) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 });
};
/** Token amount in smallest units -> decimal string. */
const fmtToken = (raw: string, decimals: number): string => {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${(v / base).toLocaleString()}${frac ? "." + frac : ""}`;
};
/** "0.25" -> 250000000n. Rejects more than 9 decimals and anything non-numeric. */
function parseSol(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(s.trim());
  if (!m) throw new Error("Enter an amount in SOL, e.g. 0.25");
  return BigInt(m[1]!) * LAMPORTS_PER_SOL + BigInt((m[2] ?? "").padEnd(9, "0"));
}
const short = (a: string): string => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

type Child = Node | string | null | false;
type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], "style" | "className">> & {
  class?: string;
  style?: string;
};
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, style, ...rest } = props as Record<string, unknown>;
  if (cls) e.className = String(cls);
  if (style) e.setAttribute("style", String(style));
  Object.assign(e, rest);
  for (const k of kids) if (k) e.append(k);
  return e;
}

/* Static, trusted icon markup only (never interpolate user data here). */
const ICONS: Record<string, string> = {
  logo: '<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/>',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/>',
  down: '<path d="M12 4v12m0 0l-5-5m5 5l5-5M5 20h14"/>',
  up: '<path d="M7 17L17 7M9 7h8v8"/>',
  receive: '<path d="M17 7L7 17M15 17H7V9"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5"/>',
  sliders: '<path d="M4 7h9M19 7h1M4 17h1M11 17h9"/><circle cx="16" cy="7" r="2.2"/><circle cx="8" cy="17" r="2.2"/>',
  lock: '<rect x="5.5" y="11" width="13" height="9" rx="2.5"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  eye: '<path d="M2 12s3.7-7 10-7 10 7 10 7-3.7 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  sol: '<path d="M6 8h12l-2 2.5H4L6 8zM6 13.5h12L16 16H4l2-2.5zM6 19h12l-2-2.5H4L6 19z" transform="translate(0 -3.5)"/>',
  wallet: '<rect x="3.5" y="6.5" width="17" height="13" rx="3"/><path d="M3.5 10.5h17M16 15h1.5"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9 6.8 19.6l1-5.8-4.3-4.1 5.9-.9L12 3.5z"/>',
  logout: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>',
  user: '<circle cx="12" cy="9" r="3.5"/><path d="M5 20c1-3.6 3.8-5.5 7-5.5s6 1.9 7 5.5"/>',
};
function icon(name: keyof typeof ICONS | string, size = 20): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.9");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.innerHTML = ICONS[name] ?? "";
  return svg;
}

const app = document.getElementById("app")!;

/* ───────────────────────── toast ───────────────────────── */

let toastTimer: number | undefined;
/** "5 h 12 min" until `at`, for the service fee's countdown. */
function untilText(at: number): string {
  const min = Math.max(0, Math.ceil((at - Date.now()) / 60_000));
  const d = Math.floor(min / 1440), hrs = Math.floor((min % 1440) / 60), m = min % 60;
  return d > 0 ? `${d} d ${hrs} h` : hrs > 0 ? `${hrs} h ${m} min` : `${m} min`;
}

/** The notice that counts down to the service fee's start, updated every 20 seconds while it's on screen. */
function feeCountdown(feeBps: number, at: number): HTMLElement {
  const left = h("strong", {});
  const el = h("div", { class: "notice" }, h("strong", {}, `Service fee of ${feeBps / 100}% per push starts in `), left,
    ` (${fmtUtc(at)}). Pushes until then have no service fee. Every fee is shown before you confirm.`);
  const tick = () => {
    if (Date.now() < at) return void (left.textContent = untilText(at));
    clearInterval(timer);
    el.replaceChildren(h("strong", {}, `Service fee ${feeBps / 100}% per push. `), "Shown in full before you confirm.");
  };
  // Stops once the screen is repainted without this notice.
  const timer = setInterval(() => (el.isConnected ? tick() : clearInterval(timer)), 20_000);
  tick();
  return el;
}

/** Shown on the download version once it runs signed token settings newer than its build: the full build is on the site.
 *  Replacing the files in the same folder keeps the extension's id, so the gateway stays. */
function updateNotice(): HTMLElement {
  return h("div", { class: "notice warn" }, h("strong", {}, "New version of Helium. "),
    "This copy got the latest coin settings automatically. ",
    h("a", { href: "https://heliumgateway.net/docs/#install", target: "_blank", rel: "noopener noreferrer", textContent: "Download it again" }),
    ", unzip it over the same folder (replace the files), then click the reload arrow on chrome://extensions. Your gateway stays.");
}

function toast(text: string, kind: "ok" | "err", linkUrl?: string) {
  document.querySelector(".toast")?.remove();
  const t = h("div", { class: `toast ${kind}` }, icon(kind === "ok" ? "check" : "lock", 18), h("span", {}, text));
  if (linkUrl) t.append(h("a", { href: linkUrl, target: "_blank", rel: "noopener noreferrer", textContent: "View" }));
  // Lives on <body>, outside #app, so screen re-renders don't wipe it.
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.remove(), kind === "err" ? 7000 : 9000);
}

async function copyText(text: string, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(what, "ok");
  } catch {
    toast("Could not copy to clipboard", "err");
  }
}

/** Run an async action: disables the button, shows a spinner label, surfaces errors inline. */
async function guarded(btn: HTMLButtonElement, msg: HTMLElement | null, working: string, fn: () => Promise<void>) {
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = working;
  if (msg) setMsg(msg, "");
  try {
    await fn();
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    if (msg) setMsg(msg, text, "err");
    else toast(text, "err");
  } finally {
    if (btn.isConnected) {
      btn.disabled = false;
      btn.textContent = prev;
    }
  }
}
function setMsg(el: HTMLElement, text: string, kind: "ok" | "err" | "" = "") {
  el.className = `msg ${kind}`;
  el.textContent = text;
}

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h("div", { class: "field" }, h("label", {}, label), input, hint ? h("div", { class: "msg", textContent: hint }) : null);
}

function passwordInput(placeholder: string): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = h("input", { class: "input has-btn", type: "password", placeholder, autocomplete: "off" });
  const eye = h("button", { class: "iconbtn", type: "button", title: "Show / hide" }, icon("eye", 18));
  eye.onclick = () => {
    input.type = input.type === "password" ? "text" : "password";
    input.focus();
  };
  return { wrap: h("div", { class: "input-wrap" }, input, eye), input };
}

/** A strength line under a new-passphrase field: the same rule the worker enforces. */
function strengthMeter(input: HTMLInputElement): HTMLElement {
  const bar = h("div", { class: "pw-meter" }, h("i"), h("i"), h("i"));
  const text = h("div", { class: "msg" });
  const paint = () => {
    const v = input.value;
    const score = v ? passphraseScore(v) : 0;
    bar.dataset.score = String(v ? score : "");
    const why = v ? passphraseProblem(v) : null;
    text.className = !v ? "msg" : why ? "msg err" : "msg ok";
    text.textContent = !v
      ? `At least ${MIN_PASSPHRASE_LENGTH} characters. Four or more random words work well.`
      : why ?? (score === 3 ? "Strong" : "Good");
  };
  input.addEventListener("input", paint);
  paint();
  return h("div", { class: "pw-strength" }, bar, text);
}

/* ── passkeys (WebAuthn with the PRF extension) ──
 * The browser asks the authenticator (Windows Hello, Touch ID, a phone, a security key) for 32 secret bytes tied to
 * this site, the passkey and a stored input. The worker turns them into the key that unwraps the gateway key. */
const b64url = (u: Uint8Array): string => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const hexOf = (b: ArrayBuffer | ArrayBufferView): string => {
  const u = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("");
};
type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | ArrayBufferView } } };
const passkeysAvailable = (): boolean => typeof PublicKeyCredential !== "undefined" && !!navigator.credentials && window.isSecureContext;
/** Chrome and Safari report PRF support up front; elsewhere, null (we find out when the passkey is made). */
async function prfSupport(): Promise<boolean | null> {
  if (!passkeysAvailable()) return false;
  const caps = await (PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> })
    .getClientCapabilities?.().catch(() => null);
  return caps && "extension:prf" in caps ? !!caps["extension:prf"] : null;
}
function passkeyError(e: unknown): Error {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError") return new Error("Cancelled, or the passkey prompt timed out");
  if (name === "InvalidStateError") return new Error("That device already has a passkey for this gateway");
  return e instanceof Error ? e : new Error(String(e));
}
/** Ask for the PRF output of one of these passkeys. */
async function passkeyPrf(list: PasskeyInfo[]): Promise<{ id: string; prf: string }> {
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: list.map((p) => ({ type: "public-key" as const, id: unb64url(p.id) })),
        userVerification: "required",
        timeout: 120_000,
        extensions: { prf: { evalByCredential: Object.fromEntries(list.map((p) => [p.id, { first: unb64url(p.salt) }])) } },
      } as PublicKeyCredentialRequestOptions,
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw passkeyError(e);
  }
  const first = (cred?.getClientExtensionResults() as PrfResults | undefined)?.prf?.results?.first;
  if (!cred || !first) throw new Error("This passkey can't unlock the gateway (its device doesn't support the PRF extension)");
  return { id: cred.id, prf: hexOf(first) };
}
/** Make a passkey for this gateway and read its PRF output (a second prompt where the browser can't do both at once). */
async function makePasskey(): Promise<{ id: string; salt: string; prf: string; label: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: "Helium gateway" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `Helium ${short(status.address ?? "")}`, displayName: "Helium gateway" },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        timeout: 120_000,
        extensions: { prf: { eval: { first: salt } } },
      } as PublicKeyCredentialCreationOptions,
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw passkeyError(e);
  }
  if (!cred) throw new Error("No passkey was made");
  const ext = cred.getClientExtensionResults() as PrfResults;
  if (ext.prf?.enabled === false) throw new Error("That device made a passkey but can't use it to unlock (no PRF support). Try Windows Hello, iCloud Keychain, Google Password Manager or a recent security key. You can delete the unused passkey there.");
  const id = cred.id;
  const prf = ext.prf?.results?.first ? hexOf(ext.prf.results.first) : (await passkeyPrf([{ id, salt: b64url(salt), label: "", added: 0 }])).prf;
  const t = (cred as unknown as { authenticatorAttachment?: string }).authenticatorAttachment;
  return { id, salt: b64url(salt), prf, label: t === "platform" ? "This device" : t === "cross-platform" ? "Phone or security key" : "Passkey" };
}

/** Enter key handler. NB: must never return false — that would cancel the keystroke and block typing. */
function onEnter(el: HTMLElement, fn: () => void) {
  el.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") fn();
  });
}
function focusSoon(el: HTMLElement) {
  setTimeout(() => el.focus(), 30);
}

/* ───────────────────────── state ───────────────────────── */

type View = "home" | "rewards" | "shield" | "push" | "receive" | "private" | "settings" | "dot";
let status: Status;
let balances: Balances | null = null;
let balError: string | null = null;
let loadingBal = false;
let view: View = "home";

/* The trading dot (src/dock.ts, the extension) opens this page as …?dock#push: a small window, straight to one screen.
 * "Unshield" on pump.fun adds an amount and a one-time code (#push&sol=1.4&fund=…). The amount alone only fills in the
 * Push form. The code is redeemed with the extension's background (src/ext-background.ts); if it says it is
 * real and within the user's one-tap limit, the gateway pushes that amount to the saved main wallet without a review.
 * A link from anywhere else has no valid code, so at most it fills in the form. */
const ROUTES: readonly View[] = ["home", "rewards", "shield", "push", "receive"];
/** A push amount suggested by the dot, kept until the user leaves the Push screen. */
let suggestedSol: string | null = null;
/** The dot's one-time code, redeemed once the gateway is unlocked. */
let pendingFund: string | null = null;
function readHash(): View | null {
  const raw = location.hash.slice(1);
  const amp = raw.indexOf("&");
  const v = (amp < 0 ? raw : raw.slice(0, amp)) as View;
  const rest = amp < 0 ? "" : raw.slice(amp + 1);
  if (!ROUTES.includes(v)) return null;
  const q = new URLSearchParams(rest);
  const sol = q.get("sol"), fund = q.get("fund");
  suggestedSol = v === "push" && sol && /^\d{1,5}(\.\d{1,9})?$/.test(sol) && Number(sol) > 0 ? sol : null;
  pendingFund = suggestedSol && fund && /^[A-Za-z0-9_-]{16,64}$/.test(fund) ? fund : null;
  return v;
}

/** Ask the extension's background whether the dot's code is real. null: refused or expired. */
async function claimFund(id: string): Promise<FundClaim | null> {
  const r = (await chrome.runtime.sendMessage({ type: "fund.claim", id }).catch(() => null)) as Response<Partial<FundClaim>> | null;
  const c = r?.ok ? r.data : null;
  return c && typeof c.sol === "number" && Number.isFinite(c.sol) && c.sol > 0 && c.sol <= 10_000 && typeof c.auto === "boolean"
    ? { sol: c.sol, auto: c.auto } : null;
}

/** The one-tap push in progress (drawn by pushView instead of the form). */
let fundRun: { sol: string } | null = null;
async function runFund() {
  const id = pendingFund;
  pendingFund = null;
  if (!id) return;
  if (fundRun) return toast("A push is already running", "err");
  // drop the code from the address bar: it is single use anyway
  history.replaceState(null, "", `${location.pathname}${location.search}#push${suggestedSol ? `&sol=${suggestedSol}` : ""}`);
  const claim = await claimFund(id);
  if (!claim) return; // stays a filled-in Push form for the user to review
  const sol = claim.sol.toFixed(9).replace(/\.?0+$/, "");
  suggestedSol = sol;
  if (!claim.auto || !status.mainWallet) {
    if (view === "push" && !formTouched) renderShell();
    return;
  }
  const to = status.mainWallet;
  fundRun = { sol };
  view = "push";
  renderShell();
  try {
    const lamports = parseSol(sol);
    if (balances && lamports > BigInt(balances.privateLamports)) throw new Error(`Your private balance is ${fmtShort(balances.privateLamports)} SOL, less than ${sol}`);
    const q = await send<Quote>({ type: "quote", lamports: lamports.toString() });
    if (!q.sufficientPublic) {
      throw new Error(`The gateway needs about ${fmt(q.requiredPublicLamports)} SOL of public SOL for fees and has ${fmt(q.publicLamports)}. Send some to it (Receive).`);
    }
    const r = await send<{ lamports: string; feeLamports: string; burned: string; url: string }>({ type: "push", lamports: lamports.toString(), to, payWithToken: q.mode === "token", quotedAt: q.at });
    fundRun = null;
    suggestedSol = null;
    // One-click skips the review screen, so the confirmation names the service fee that was paid.
    const paid = BigInt(r.feeLamports) > 0n ? ` · service fee ${fmt(r.feeLamports)} SOL` : "";
    toast(`Unshielded ${fmtShort(r.lamports)} SOL to ${short(to)}${paid}`, "ok", r.url);
    balances = null;
    go("home");
    void loadBalances();
  } catch (e) {
    fundRun = null;
    toast(e instanceof Error ? e.message : String(e), "err");
    if (view === "push") renderShell(); // back to the Push form, amount filled in
  }
}
view = readHash() ?? "home";
if (new URLSearchParams(location.search).has("dock")) document.body.classList.add("docked");
// The dot reuses its window: a new action only changes the hash, so an unlocked gateway stays unlocked.
addEventListener("hashchange", () => {
  const v = readHash();
  if (!v) return;
  view = v;
  formTouched = false;
  void render();
});
/** Set once the user types in a Push/Shield amount, so a late balance load doesn't redraw the form under them. */
let formTouched = false;

/** Log out: lock and set this gateway aside on this device (still encrypted), then show the gateway picker. */
async function logOut() {
  await send({ type: "logOut" });
  // pump.fun must never keep showing the balance of a gateway that is no longer open
  void chrome.runtime.sendMessage({ type: "balance.clear" }).catch(() => undefined);
  balances = null;
  balError = null;
  view = "home";
  await render();
  toast("Logged out. Your gateway stays saved on this device.", "ok");
}

async function render() {
  status = await send<Status>({ type: "status" });
  app.replaceChildren();
  if (!status.hasVault) return renderWelcome();
  if (!status.unlocked) return renderUnlock();
  renderShell();
  if (balances === null && !loadingBal && balError === null) void loadBalances();
  if (pendingFund) void runFund();
}

/** Auto-shield: after a balance read finds public SOL above the reserve, ask the worker to shield it (the worker checks
 *  the setting and picks the amount). A failure waits five minutes before the next try, so a broken RPC can't loop. */
let autoShieldPausedUntil = 0, autoShielding = false;
async function maybeAutoShield() {
  if (!status.autoShield || !balances || autoShielding || Date.now() < autoShieldPausedUntil) return;
  const spare = BigInt(balances.publicLamports) - BigInt(balances.feeReserveLamports);
  if (spare < AUTO_SHIELD_MIN_LAMPORTS) return;
  autoShielding = true;
  try {
    const r = await send<{ lamports: string; url: string } | null>({ type: "autoShield" });
    if (r) {
      toast(`Shielded ${fmtShort(r.lamports)} SOL automatically`, "ok", r.url);
      autoShielding = false;
      await loadBalances(true);
    }
  } catch (e) {
    autoShieldPausedUntil = Date.now() + 5 * 60_000;
    toast(`Auto-shield failed: ${e instanceof Error ? e.message : String(e)}`, "err");
  } finally {
    autoShielding = false;
  }
}
// with auto-shield on, look for arriving SOL once a minute while the wallet is open (a quiet read: it doesn't hold the
// idle lock off, so an unattended wallet still locks)
setInterval(() => {
  if (status?.unlocked && status.autoShield && !document.hidden && !loadingBal) void loadBalances(true);
}, 60_000);

async function loadBalances(quiet = false) {
  if (loadingBal) return;
  if (!status.hasApiKey) {
    balError = "Add your Helius API key in Settings to read balances.";
    if (isMainView()) renderShell();
    return;
  }
  loadingBal = true;
  balError = null;
  if (isMainView()) renderShell();
  try {
    balances = await send<Balances>({ type: "balances", quiet });
    // the dot shows this in pump.fun's wallet balance for 10 minutes (a devnet balance only as its own row, never
    // added to pump.fun's real-money totals)
    chrome.runtime.sendMessage({ type: "balance.report", lamports: balances.privateLamports, network: status.network }).catch(() => undefined);
  } catch (e) {
    balError = e instanceof Error ? e.message : String(e);
  } finally {
    loadingBal = false;
    // Push and Shield show the balance too (the dot opens them directly); redraw them until the user starts typing.
    if (isMainView() || ((view === "push" || view === "shield") && !formTouched)) renderShell();
  }
  void maybeAutoShield();
}

/** The two tabbed screens that show balances/tier and so repaint when balances load. */
const isMainView = () => view === "home" || view === "rewards";

function go(v: View) {
  view = v;
  formTouched = false;
  if (v !== "push") suggestedSol = null;
  // keep the hash on the current screen, so the dot asking for a screen always counts as a change
  if (location.hash !== `#${v}`) history.replaceState(null, "", `${location.pathname}${location.search}#${v}`);
  renderShell();
}

/* ───────────────────────── onboarding ───────────────────────── */

function splash(...kids: Child[]): HTMLElement {
  return h("div", { class: "splash" }, ...kids);
}
/* Helium's logo, shipped beside this page (logo-mark.png in the extension root and in /app/). */
function logoImg(size: number): HTMLImageElement {
  return h("img", { src: "logo-mark.png", alt: "", width: size, height: size, draggable: false });
}
function logoMark(): HTMLElement {
  return h("div", { class: "logo logo--img" }, logoImg(76));
}

/** The gateway an older version of this extension held, in the extension's own storage (same format, same passphrase). */
async function storedLegacy(): Promise<{ address: string; blob: unknown; settings: unknown } | null> {
  const { vault, settings } = (await chrome.storage.local.get(["vault", "settings"]).catch(() => ({}))) as { vault?: { address?: unknown; blob?: unknown }; settings?: unknown };
  return vault && typeof vault.address === "string" ? { address: vault.address, blob: vault.blob, settings } : null;
}

function renderWelcome() {
  const legacySlot = h("div", { class: "stack", style: "width:100%" });
  void storedLegacy().then((old) => {
    if (!old) return;
    const msg = h("div", { class: "msg", style: "text-align:center" });
    const b = h("button", { class: "btn", textContent: `Use my gateway ${short(old.address)}` });
    b.onclick = () =>
      guarded(b, msg, "Opening…", async () => {
        await send({ type: "adopt", address: old.address, blob: old.blob, settings: old.settings } as Request);
        await render();
      });
    legacySlot.replaceChildren(h("div", { class: "notice" }, "This extension already holds a gateway from an earlier version. Use it with the passphrase you set then."), b, msg);
  });
  const savedMsg = h("div", { class: "msg", style: "text-align:center" });
  const savedSlot = status.saved.length
    ? h("div", { class: "stack", style: "width:100%" },
        h("div", { class: "section-label", textContent: "Your gateways on this device" }),
        ...status.saved.map((a) => {
          const b = h("button", { class: "btn" }, icon("wallet", 18), `Gateway ${short(a)}`);
          b.onclick = () =>
            guarded(b, savedMsg, "Opening…", async () => {
              await send({ type: "switchTo", address: a });
              await render();
            });
          return b;
        }),
        savedMsg,
        h("div", { class: "section-label", textContent: "Or add another" }))
    : null;
  app.replaceChildren(
    splash(
      logoMark(),
      h("h1", {}, "Helium"),
      h("p", {}, "Hold SOL privately in a Helius Privacy Ring and push it to your main wallet in one click."),
      savedSlot,
      legacySlot,
      (() => {
        const b = h("button", { class: status.saved.length ? "btn secondary" : "btn", textContent: "Create a new gateway" });
        b.onclick = renderCreate;
        return b;
      })(),
      (() => {
        const b = h("button", { class: "btn secondary", textContent: "I already have a recovery key" });
        b.onclick = renderImport;
        return b;
      })(),
    ),
  );
}

function backBar(title: string, onBack: () => void): HTMLElement {
  const back = h("button", { class: "iconbtn", title: "Back" }, icon("back", 20));
  back.onclick = onBack;
  return h("div", { class: "top" }, back, h("div", { class: "grow title", textContent: title }), h("div", { style: "width:34px" }));
}

function renderCreate() {
  const p1 = passwordInput(`Passphrase (${MIN_PASSPHRASE_LENGTH}+ characters)`);
  const p2 = passwordInput("Confirm passphrase");
  const meter = strengthMeter(p1.input);
  const msg = h("div", { class: "msg" });
  const btn = h("button", { class: "btn", textContent: "Create gateway" });
  const submit = () =>
    guarded(btn, msg, "Creating…", async () => {
      if (p1.input.value !== p2.input.value) throw new Error("Passphrases do not match");
      const r = await send<{ address: string; seedHex: string }>({ type: "create", passphrase: p1.input.value });
      renderBackup(r.seedHex);
    });
  btn.onclick = submit;
  onEnter(p2.input, submit);
  app.replaceChildren(
    backBar("New gateway", renderWelcome),
    h("div", { class: "content" },
      h("div", { class: "stack" },
        h("div", { class: "steps" }, h("i", { class: "on" }), h("i"), h("i")),
        h("div", { class: "notice" }, "Your passphrase encrypts the gateway key on this device. ", h("strong", {}, "It can't be reset"), " — if you forget it you'll need your recovery key."),
        field("Passphrase", p1.wrap), meter, field("Confirm passphrase", p2.wrap), btn, msg)),
  );
  focusSoon(p1.input);
}

function renderBackup(seedHex: string) {
  const ack = h("input", { type: "checkbox" });
  const go2 = h("button", { class: "btn", textContent: "Continue", disabled: true });
  ack.onchange = () => (go2.disabled = !ack.checked);
  go2.onclick = () => void render();
  const copyBtn = h("button", { class: "btn secondary small" }, icon("copy", 16), "Copy recovery key");
  copyBtn.onclick = () => void copyText(seedHex, "Recovery key copied — paste it somewhere safe");
  app.replaceChildren(
    h("div", { class: "top" }, h("div", { class: "grow title", textContent: "Back up your key" })),
    h("div", { class: "content" },
      h("div", { class: "stack" },
        h("div", { class: "steps" }, h("i", { class: "on" }), h("i", { class: "on" }), h("i")),
        h("div", { class: "notice warn" }, h("strong", {}, "Shown once. "), "Anyone with this key controls the gateway and its private balance. Store it offline."),
        h("div", { class: "addr-card mono", textContent: seedHex }),
        copyBtn,
        h("label", { class: "check" }, ack, "I have saved my recovery key somewhere safe"),
        go2)),
  );
}

function renderImport() {
  const seed = passwordInput("Recovery key (64 hex characters)");
  const p1 = passwordInput(`New passphrase (${MIN_PASSPHRASE_LENGTH}+ characters)`);
  const meter = strengthMeter(p1.input);
  const msg = h("div", { class: "msg" });
  const btn = h("button", { class: "btn", textContent: "Import gateway" });
  const submit = () =>
    guarded(btn, msg, "Importing…", async () => {
      await send({ type: "import", passphrase: p1.input.value, seedHex: seed.input.value });
      await render();
    });
  btn.onclick = submit;
  onEnter(p1.input, submit);
  app.replaceChildren(
    backBar("Import gateway", renderWelcome),
    h("div", { class: "content" }, h("div", { class: "stack" }, field("Recovery key", seed.wrap), field("Passphrase for this browser", p1.wrap), meter, btn, msg)),
  );
  focusSoon(seed.input);
}

function renderUnlock() {
  const p = passwordInput("Passphrase");
  const msg = h("div", { class: "msg", style: "text-align:center" });
  const withPasskey = status.passkeys.length > 0 && passkeysAvailable();
  const btn = h("button", { class: withPasskey ? "btn secondary" : "btn", textContent: withPasskey ? "Unlock with passphrase" : "Unlock" });
  const opened = async () => {
    view = readHash() ?? "home";
    balError = null;
    await render();
    if (status.weakPassphrase) toast("Your passphrase is easier to guess than Helium now allows. Change it in Settings.", "err");
  };
  const submit = () =>
    guarded(btn, msg, "Unlocking…", async () => {
      await send({ type: "unlock", passphrase: p.input.value });
      await opened();
    });
  btn.onclick = submit;
  onEnter(p.input, submit);
  let pkBtn: HTMLButtonElement | null = null;
  if (withPasskey) {
    const b = h("button", { class: "btn" }, icon("lock", 18), "Unlock with passkey");
    b.onclick = () =>
      guarded(b, msg, "Waiting for your passkey…", async () => {
        const { id, prf } = await passkeyPrf(status.passkeys);
        await send({ type: "unlockPasskey", id, prf });
        await opened();
      });
    pkBtn = b;
  }
  app.replaceChildren(
    splash(
      logoMark(),
      h("h1", {}, "Welcome back"),
      h("p", {}, status.address ? `Gateway ${short(status.address)}` : "Enter your passphrase to unlock"),
      pkBtn,
      withPasskey ? h("div", { class: "or", textContent: "or" }) : null,
      p.wrap, btn, msg,
      (() => {
        const other = h("button", { class: "link", textContent: status.saved.length ? "Switch gateway" : "Use another gateway" });
        other.onclick = () => void logOut().catch((e: unknown) => setMsg(msg, e instanceof Error ? e.message : String(e), "err"));
        return other;
      })()),
  );
  if (pkBtn) pkBtn.focus();
  else focusSoon(p.input);
}

/* ───────────────────────── shell ───────────────────────── */

function renderShell() {
  const sub = !isMainView();
  const titles: Record<View, string> = { home: "", rewards: "", shield: "Shield SOL", push: "Push to main", receive: "Receive", private: "Send privately", settings: "Settings", dot: "Dot settings" };

  let header: HTMLElement;
  if (!sub) {
    const who = h("button", { class: "who", title: "Copy gateway address" },
      h("div", { class: "avatar avatar--img" }, logoImg(34)),
      h("div", {},
        h("div", { class: "name", textContent: "Helium" }),
        h("div", { class: "addr" }, short(status.address ?? ""), icon("copy", 12))));
    who.onclick = () => void copyText(status.address ?? "", "Gateway address copied");
    const lockBtn = h("button", { class: "iconbtn", title: "Lock" }, icon("lock", 18));
    lockBtn.onclick = async () => {
      await send({ type: "lock" });
      balances = null;
      await render();
    };
    const outBtn = h("button", { class: "iconbtn", title: "Log out and switch gateway" }, icon("logout", 18));
    outBtn.onclick = () => void logOut().catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "err"));
    const setBtn = h("button", { class: "iconbtn", title: "Settings" }, icon("sliders", 18));
    setBtn.onclick = () => go("settings");
    header = h("div", { class: "top" }, who, h("div", { class: "grow" }),
      h("span", { class: `pill ${status.network}`, textContent: status.network }), lockBtn, outBtn, setBtn);
  } else {
    header = backBar(titles[view], () => go(view === "dot" ? "settings" : "home"));
  }

  const body =
    view === "home" ? homeView() : view === "rewards" ? rewardsView() : view === "shield" ? shieldView() : view === "push" ? pushView() : view === "receive" ? receiveView() : view === "private" ? privateView() : view === "dot" ? dotSettingsView() : settingsView();
  app.replaceChildren(header, body);
  if (!sub) app.append(tabBar());
}

function tabBar(): HTMLElement {
  const tab = (v: View, label: string, ic: string) => {
    const b = h("button", { class: view === v ? "on" : "", type: "button" }, icon(ic, 20), label);
    b.onclick = () => go(v);
    return b;
  };
  return h("nav", { class: "tabs" }, tab("home", "Gateway", "wallet"), tab("rewards", "Rewards", "star"));
}

/* ───────────────────────── home ───────────────────────── */

/** Which unit the two home balance cards display. Per popup session; "token" only applies if a token is configured. */
let unit: "sol" | "token" = "sol";

function homeView(): HTMLElement {
  const b = balances;
  const sym = status.product.tokenSymbol;
  const inToken = unit === "token" && !!sym;

  // Two balance cards. Tapping either flips both between SOL and the product token.
  const card = (kind: "public" | "private") => {
    const amount = h("div", { class: "amount" });
    let sub: string;
    if (inToken) {
      if (kind === "public") {
        if (b?.vaultToken != null) amount.append(fmtToken(b.vaultToken, status.product.tokenDecimals), h("small", {}, sym!));
        else if (loadingBal) amount.append(h("span", { class: "skeleton" }));
        else amount.append("—");
        sub = "Gateway";
      } else {
        // Only SOL can be shielded today, so there is never a private token balance.
        amount.append("0", h("small", {}, sym!));
        sub = "Private tokens not supported yet";
      }
    } else {
      const v = b ? (kind === "public" ? b.publicLamports : b.privateLamports) : null;
      if (v !== null) amount.append(fmtShort(v), h("small", {}, "SOL"));
      else if (loadingBal) amount.append(h("span", { class: "skeleton" }));
      else amount.append("—");
      sub = !b ? (balError ? "Unavailable" : "Syncing…") : kind === "public" ? "Visible on-chain · pays fees" : "Encrypted inside the ring";
    }
    const el = h("button", { class: `bal ${kind}`, type: "button", title: sym ? `Show in ${inToken ? "SOL" : sym}` : "" },
      h("div", { class: "label" }, icon(kind === "private" ? "shield" : "sol", 14), kind === "private" ? "Private" : "Public"),
      amount,
      h("div", { class: "sub", textContent: sub }));
    if (sym) {
      el.onclick = () => {
        unit = inToken ? "sol" : "token";
        renderShell();
      };
    } else {
      el.style.cursor = "default";
    }
    return el;
  };
  const hero = h("div", { class: "balances" }, card("public"), card("private"));

  const act = (name: string, label: string, onClick: () => void, primary = false, spinning = false) => {
    const btn = h("button", { class: `act ${spinning ? "spin" : ""}`, title: label }, h("div", { class: `ico ${primary ? "primary" : ""}` }, icon(name, 22)), label);
    btn.onclick = onClick;
    return btn;
  };
  const actions = h("div", { class: "actions" },
    act("down", "Shield", () => go("shield"), true),
    act("up", "Push", () => go("push"), true),
    act("receive", "Receive", () => go("receive")),
    act("refresh", "Refresh", () => void loadBalances(), false, loadingBal));

  const mainRow = status.mainWallet
    ? h("div", { class: "row-item" },
        h("div", { class: "badge" }, icon("user", 20)),
        h("div", { class: "meta" }, h("div", { class: "t", textContent: "Main wallet" }), h("div", { class: "s", textContent: short(status.mainWallet) })),
        h("div", { class: "v" }, "Push target"))
    : (() => {
        const r = h("button", { class: "row-item" },
          h("div", { class: "badge accent" }, icon("user", 20)),
          h("div", { class: "meta" }, h("div", { class: "t", textContent: "Set your main wallet" }), h("div", { class: "s", textContent: "Needed before you can push funds out" })));
        r.onclick = () => go("settings");
        return r;
      })();

  const prod = status.product;
  const tierRow =
    prod.tokenSymbol && prod.tiers.length > 0
      ? h("div", { class: "row-item" },
          h("div", { class: `badge ${b?.tier && b.tier.level > 0 ? "accent" : ""}` }, icon("check", 20)),
          h("div", { class: "meta" },
            h("div", { class: "t", textContent: "Holder tier" }),
            h("div", { class: "s", textContent: b?.tier ? `${fmtToken(b.tier.held, prod.tokenDecimals)} ${prod.tokenSymbol} ${heldWord(prod.tierSource)}` : "Checking…" })),
          h("div", { class: "v" }, b?.tier ? b.tier.name : "—",
            b?.tier && b.tier.discountBps > 0 ? h("small", {}, `−${b.tier.discountBps / 100}% fee`) : null))
      : null;

  const tokenRow = prod.tokenSymbol
    ? h("div", { class: "row-item" },
        h("div", { class: "badge" }, icon("sol", 20)),
        h("div", { class: "meta" }, h("div", { class: "t", textContent: prod.tokenSymbol }), h("div", { class: "s", textContent: `Gateway · ${status.network}` })),
        h("div", { class: "v" }, b?.vaultToken != null ? fmtToken(b.vaultToken, prod.tokenDecimals) : "—"))
    : null;

  const list = h("div", { class: "list" },
    h("div", { class: "row-item" },
      h("div", { class: "badge accent" }, icon("shield", 20)),
      h("div", { class: "meta" }, h("div", { class: "t", textContent: "Private SOL" }), h("div", { class: "s", textContent: "Hidden in the ring" })),
      h("div", { class: "v" }, b ? fmtShort(b.privateLamports) : "—")),
    h("div", { class: "row-item" },
      h("div", { class: "badge" }, icon("sol", 20)),
      h("div", { class: "meta" }, h("div", { class: "t", textContent: "Public SOL" }), h("div", { class: "s", textContent: "Gateway · pays fees" })),
      h("div", { class: "v" }, b ? fmtShort(b.publicLamports) : "—")),
    tokenRow, tierRow, mainRow);

  const notices: Child[] = [];
  if (prod.updateReady) notices.push(updateNotice());
  if (prod.feeActive) {
    notices.push(h("div", { class: "notice" }, h("strong", {}, `Service fee ${prod.feeBps / 100}% per push. `), "Shown in full before you confirm."));
  } else if (prod.feeStartsAt > 0) {
    notices.push(feeCountdown(prod.feeBps, prod.feeStartsAt));
  }
  if (balError) notices.push(h("div", { class: "notice bad" }, balError));
  else if (b && BigInt(b.publicLamports) < BigInt(b.feeReserveLamports) && BigInt(b.privateLamports) > 0n) {
    notices.push(h("div", { class: "notice warn" }, h("strong", {}, "Low fee balance. "),
      `Withdrawals are paid from the gateway's public SOL. Send about ${fmt(b.feeReserveLamports)} SOL to the gateway address (Receive).`));
  }

  return h("div", { class: "content" }, hero, actions, h("div", { class: "section-label" }, "Assets"), list, ...notices);
}

/* ───────────────────────── rewards ───────────────────────── */

type Metal = { a: string; b: string; c: string };
const METALS: Record<"bronze" | "silver" | "gold", Metal> = {
  bronze: { a: "#9c6130", b: "#efb987", c: "#cf8d4e" },
  silver: { a: "#8f98a8", b: "#f3f5f9", c: "#c5ccd8" },
  gold: { a: "#c1900f", b: "#ffe796", c: "#f3c13d" },
};
/** Tier colour: by name when it's Bronze/Silver/Gold, otherwise by rank (1 bronze, 2 silver, 3+ gold). */
function metalFor(name: string, level: number): Metal {
  const n = name.toLowerCase();
  if (n.includes("bronze")) return METALS.bronze;
  if (n.includes("silver")) return METALS.silver;
  if (n.includes("gold")) return METALS.gold;
  return level <= 1 ? METALS.bronze : level === 2 ? METALS.silver : METALS.gold;
}
const metalVars = (m: Metal) => `--m-a:${m.a};--m-b:${m.b};--m-c:${m.c}`;

/** What the amount in the tier card refers to, given where the tier comes from. */
const heldWord = (src: "holding" | "staking" | "both"): string => (src === "staking" ? "staked" : src === "both" ? "held + staked" : "in your gateway");

/** Exact decimal string for a token amount in smallest units (no thousands separators; safe for inputs). */
function rawToDecimal(raw: string, decimals: number): string {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${v / base}.${frac}` : (v / base).toString();
}
function parseUnits(s: string, decimals: number, sym: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m || (m[2]?.length ?? 0) > decimals) throw new Error(`Enter an amount in ${sym} with at most ${decimals} decimals`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
}
function fmtDuration(sec: number): string {
  if (sec < 120) return `${sec}s`;
  if (sec < 7200) return `${Math.round(sec / 60)} min`;
  if (sec < 172_800) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86_400)} days`;
}

/** Stake / unstake the product token. Tokens are locked in the configured pool; the lock length is set in product.ts. */
function stakePanel(): HTMLElement {
  const prod = status.product;
  const sym = prod.tokenSymbol ?? "";
  const dec = prod.tokenDecimals;
  const b = balances;
  const available = b?.vaultToken ?? "0";
  const staked = b?.staked ?? null;

  const input = h("input", { class: "input", type: "text", placeholder: "0", inputMode: "decimal", autocomplete: "off" });
  const max = h("button", { class: "chip", type: "button", textContent: "Max" });
  max.onclick = () => {
    input.value = rawToDecimal(available, dec);
    input.focus();
  };
  const msg = h("div", { class: "msg" });
  const stakeBtn = h("button", { class: "btn small", textContent: `Stake ${sym}` });
  const unstakeBtn = h("button", { class: "btn secondary small", textContent: "Unstake unlocked" });

  stakeBtn.onclick = () =>
    guarded(stakeBtn, msg, "Staking…", async () => {
      const amount = parseUnits(input.value, dec, sym);
      if (amount <= 0n) throw new Error("Enter an amount");
      if (BigInt(available) < amount) throw new Error(`The gateway only holds ${fmtToken(available, dec)} ${sym}`);
      const r = await send<{ amount: string; lockSeconds: number; url: string }>({ type: "stake", amount: amount.toString() });
      toast(`Staked ${fmtToken(r.amount, dec)} ${sym} for ${fmtDuration(r.lockSeconds)}`, "ok", r.url);
      void loadBalances();
    });
  unstakeBtn.onclick = () =>
    guarded(unstakeBtn, msg, "Unstaking…", async () => {
      const r = await send<{ amount: string; url: string }>({ type: "unstake" });
      toast(`Unstaked ${fmtToken(r.amount, dec)} ${sym}`, "ok", r.url);
      void loadBalances();
    });
  onEnter(input, () => stakeBtn.click());

  const now = Math.floor(Date.now() / 1000);
  const entryRows = (staked?.entries ?? []).map((e) =>
    h("div", { class: "line" },
      h("span", { class: "k", textContent: `${fmtToken(e.amount, dec)} ${sym}` }),
      h("span", { class: "vv", textContent: e.unlockTs <= now ? "Unlocked" : `Unlocks in ${fmtDuration(e.unlockTs - now)}` })));

  return h("div", { class: "panel" },
    h("div", { class: "panel-title" }, "Stake ", sym),
    h("div", { class: "panel-sub", textContent: `Locks ${sym} from your gateway for ${fmtDuration(prod.stakeLockSeconds)}. Available: ${fmtToken(available, dec)} ${sym}.` }),
    h("div", { class: "stake-input" }, input, max),
    h("div", { class: "stack", style: "margin-top:10px" }, stakeBtn),
    entryRows.length ? h("div", { class: "summary", style: "margin-top:12px" }, ...entryRows) : null,
    entryRows.length ? h("div", { class: "stack", style: "margin-top:10px" }, unstakeBtn) : null,
    msg);
}

function rewardsView(): HTMLElement {
  const prod = status.product;
  const root = h("div", { class: "content" });
  if (!prod.tokenSymbol || prod.tiers.length === 0) {
    root.append(h("div", { class: "notice" }, `Rewards aren't set up on ${status.network} yet.`));
    return root;
  }
  const sym = prod.tokenSymbol;
  const tok = (raw: string) => `${fmtToken(raw, prod.tokenDecimals)} ${sym}`;
  const t = balances?.tier ?? null;

  if (!t) {
    root.append(
      h("div", { class: "tier-card none" },
        h("div", { class: "tc-label" }, icon("star", 14), "Holder tier"),
        h("div", { class: "tc-name" }, balError ? "Unavailable" : h("span", { class: "skeleton" })),
        h("div", { class: "tc-sub", textContent: balError ?? "Checking your gateway…" })));
    return root;
  }

  const held = BigInt(t.held);
  const next = prod.tiers[t.level]; // undefined at the top tier
  const curMin = t.level > 0 ? BigInt(prod.tiers[t.level - 1]!.min) : 0n;

  const card = h("div", { class: `tier-card ${t.level > 0 ? "metal" : "none"}`, style: t.level > 0 ? metalVars(metalFor(t.name, t.level)) : "" },
    h("div", { class: "tc-label" }, icon("star", 14), "Holder tier"),
    h("div", { class: "tc-name", textContent: t.level > 0 ? t.name : "No tier yet" }),
    h("div", { class: "tc-sub", textContent: `${tok(t.held)} ${heldWord(prod.tierSource)}` }),
    t.level > 0 && t.discountBps > 0
      ? h("div", { class: "tc-chip", textContent: t.discountBps >= 10_000 ? "No service fee" : `${t.discountBps / 100}% off the service fee` })
      : null);

  // Progress toward the next tier (or a note when already at the top).
  let progress: HTMLElement;
  if (next) {
    const nextMin = BigInt(next.min);
    const span = nextMin - curMin;
    const pct = span > 0n ? Number(((held > curMin ? held - curMin : 0n) * 1000n) / span) / 10 : 0;
    const bar = h("div", { class: "bar" }, h("div", { class: "fill", style: `width:${Math.min(100, Math.max(0, pct))}%` }));
    progress = h("div", { class: "progress" },
      h("div", { class: "pl" }, h("span", { textContent: t.level > 0 ? t.name : "Start" }), h("span", { textContent: next.name })),
      bar,
      h("div", { class: "ps", textContent: `${tok((nextMin > held ? nextMin - held : 0n).toString())} more to reach ${next.name}` }));
  } else {
    progress = h("div", { class: "notice" }, h("strong", {}, "Top tier. "), "You've reached the highest tier.");
  }

  // The full ladder, current tier highlighted.
  const ladder = h("div", { class: "list" },
    ...prod.tiers.map((tier, i) => {
      const lvl = i + 1;
      const m = metalFor(tier.name, lvl);
      const mine = lvl === t.level;
      return h("div", { class: `row-item ${mine ? "mine" : ""}` },
        h("div", { class: "badge metal-dot", style: metalVars(m) }, icon("star", 18)),
        h("div", { class: "meta" },
          h("div", { class: "t", textContent: tier.name }),
          h("div", { class: "s", textContent: `Hold ${tok(tier.min)}` })),
        h("div", { class: "v" }, tier.discountBps >= 10_000 ? "No fee" : `−${tier.discountBps / 100}% fee`,
          mine ? h("small", { textContent: "Your tier" }) : null));
    }));

  const perks: Child[] = [];
  if (BigInt(prod.burnPerPush) > 0n) {
    perks.push(h("li", { textContent: `Pay the service fee by burning ${tok(prod.burnPerPush)} per push instead of SOL.` }));
  }
  if (prod.extraDestinationsMinTier > 0) {
    const need = prod.tiers[prod.extraDestinationsMinTier - 1]?.name ?? `tier ${prod.extraDestinationsMinTier}`;
    perks.push(h("li", { textContent: `Save extra push destinations from the ${need} tier.` }));
  }

  root.append(card, progress);
  if (prod.stakingEnabled) root.append(stakePanel());
  root.append(h("div", { class: "section-label", textContent: "Tiers" }), ladder);
  if (perks.length) root.append(h("ul", { class: "perks" }, ...perks));
  if (!prod.feeActive) root.append(h("div", { class: "notice" }, prod.feeStartsAt > 0 ? `The service fee starts ${fmtUtc(prod.feeStartsAt)}. Discounts apply from then.` : "No service fee is charged right now, so discounts have no effect yet."));
  root.append(h("div", { class: "msg", textContent: prod.tierSource === "staking" ? `Your tier counts ${sym} staked from your gateway. Staked tokens stay counted when you burn ${sym} to pay a fee.` : `Your tier is read from the ${sym} at the gateway's public address. Burning ${sym} to pay a fee lowers it.` }));
  return root;
}

/* ───────────────────────── shield ───────────────────────── */

function amountBox(unitNote: string, onMax: () => string): { box: HTMLElement; input: HTMLInputElement } {
  const input = h("input", { type: "text", placeholder: "0", inputMode: "decimal", autocomplete: "off" });
  input.addEventListener("input", () => (formTouched = true));
  const max = h("button", { class: "chip", type: "button", textContent: "Max" });
  max.onclick = () => {
    input.value = onMax();
    formTouched = true;
    input.focus();
  };
  const box = h("div", { class: "amount-box" },
    h("div", { class: "row" }, input, h("span", { class: "unit", textContent: "SOL" })),
    h("div", { class: "avail" }, unitNote, max));
  return { box, input };
}

function shieldView(): HTMLElement {
  const pub = balances ? BigInt(balances.publicLamports) : 0n;
  const reserve = balances ? BigInt(balances.feeReserveLamports) : 10_000_000n;
  const spendable = pub > reserve ? pub - reserve : 0n;
  const { box, input } = amountBox(`Available: ${fmtShort(spendable)} SOL (keeps ${fmt(reserve)} for fees)`, () => fmt(spendable));
  const msg = h("div", { class: "msg", style: "text-align:center" });
  const btn = h("button", { class: "btn", textContent: "Shield" });
  const submit = () =>
    guarded(btn, msg, "Shielding…", async () => {
      const lamports = parseSol(input.value);
      const r = await send<{ signature: string; url: string }>({ type: "shield", lamports: lamports.toString() });
      toast("Shielded into the ring", "ok", r.url);
      view = "home";
      renderShell();
      void loadBalances();
    });
  btn.onclick = submit;
  onEnter(input, submit);
  focusSoon(input);
  return h("div", { class: "content" },
    box,
    h("div", { class: "notice" }, h("strong", {}, "This step is public. "), "The deposit reveals this gateway's address and the amount. Afterwards the balance is encrypted."),
    h("div", { style: "height:14px" }), btn, msg);
}

/* ───────────────────────── push ───────────────────────── */

function pushView(): HTMLElement {
  const root = h("div", { class: "content" });
  if (!status.mainWallet) {
    const b = h("button", { class: "btn", textContent: "Set main wallet" });
    b.onclick = () => go("settings");
    root.append(h("div", { class: "notice warn" }, "Set the destination wallet first. Push can only ever send to wallets you've saved."), h("div", { style: "height:14px" }), b,
      h("div", { style: "height:10px" }), privateSendLink());
    return root;
  }
  if (fundRun) {
    root.append(
      h("div", { class: "amount-box" }, h("div", { class: "row" }, h("span", { style: "font-size:40px;font-weight:700;letter-spacing:-.02em", textContent: fundRun.sol }), h("span", { class: "unit", textContent: "SOL" }))),
      h("div", { class: "summary" },
        h("div", { class: "line" }, h("span", { class: "k", textContent: "From" }), h("span", { class: "vv", textContent: "Private balance" })),
        h("div", { class: "line" }, h("span", { class: "k", textContent: "To" }), h("span", { class: "vv mono", textContent: status.mainWallet }))),
      h("div", { style: "height:12px" }),
      h("div", { class: "notice" }, h("strong", {}, "Unshielding for your pump.fun buy. "), "Proving can take a minute; keep this window open."));
    return root;
  }
  const priv = balances ? BigInt(balances.privateLamports) : 0n;
  const pubBal = balances ? BigInt(balances.publicLamports) : 0n;
  const msg = h("div", { class: "msg", style: "text-align:center" });
  let dest = status.mainWallet;
  // "Fund this trade" from the dot: the amount comes from a pump.fun page, so it is only filled in, never sent as is.
  let lastAmount = suggestedSol ?? "";
  // "private": withdraw from the ring to the destination. "public": plain transfer of the vault wallet's own SOL.
  let source: "private" | "public" = "private";

  /** Review screen for a public (non-ring) transfer. No prover, no service fee: just a normal SOL transfer. */
  const showPublicReview = (lamports: bigint) => {
    const everything = lamports === pubBal;
    let plan: { amount: bigint; remaining: bigint };
    try {
      // The destination's balance isn't known here; the worker re-checks with the real value.
      plan = planPublicSend(pubBal, everything ? "all" : lamports, RENT_EXEMPT_MIN);
    } catch (e) {
      setMsg(msg, e instanceof Error ? e.message : String(e), "err");
      return;
    }
    const line = (k: string, v: string, mono = false) =>
      h("div", { class: "line" }, h("span", { class: "k", textContent: k }), h("span", { class: mono ? "vv mono" : "vv", textContent: v }));
    const confirm = h("button", { class: "btn", textContent: "Confirm & send" });
    const back = h("button", { class: "btn secondary", textContent: "Edit" });
    back.onclick = form;
    confirm.onclick = () =>
      guarded(confirm, msg, "Sending…", async () => {
        back.disabled = true;
        const r = await send<{ signature: string; lamports: string; remaining: string; to: string; url: string }>({
          type: "sendPublic",
          lamports: everything ? "all" : lamports.toString(),
          to: dest,
        });
        toast(`Sent ${fmt(r.lamports)} SOL`, "ok", r.url);
        view = "home";
        renderShell();
        void loadBalances();
      }).finally(() => {
        back.disabled = false;
      });
    root.replaceChildren(
      h("div", { class: "amount-box" }, h("div", { class: "row" }, h("span", { style: "font-size:40px;font-weight:700;letter-spacing:-.02em", textContent: fmt(plan.amount) }), h("span", { class: "unit", textContent: "SOL" }))),
      h("div", { class: "summary" },
        line("From", "Gateway (public)"),
        line("To", dest, true),
        line("Network", status.network),
        line("Network fee", `${fmt(NETWORK_FEE_LAMPORTS)} SOL`),
        line("Left in gateway", `${fmt(plan.remaining)} SOL`)),
      h("div", { style: "height:12px" }),
      h("div", { class: "stack" },
        plan.remaining === 0n
          ? h("div", { class: "notice warn" }, h("strong", {}, "This empties the gateway's public SOL. "), "Withdrawals from your private balance are paid from it, so send some SOL back to the gateway before you shield or push again.")
          : null,
        h("div", { class: "notice warn" }, h("strong", {}, "This is a normal public transfer. "), "The amount and destination are visible on-chain."),
        confirm, back, msg));
  };

  const form = () => {
    const isPub = source === "public";
    const avail = isPub ? pubBal : priv;
    const { box, input } = amountBox(
      isPub ? `Gateway (public): ${fmtShort(pubBal)} SOL` : `Private balance: ${fmtShort(priv)} SOL`,
      () => fmt(avail),
    );
    input.value = lastAmount;
    const review = h("button", { class: "btn", textContent: "Review" });
    const go1 = () => {
      try {
        const lamports = parseSol(input.value);
        if (lamports <= 0n) throw new Error("Enter an amount");
        if (balances && lamports > avail) throw new Error(isPub ? "That's more than the gateway's public balance" : "That's more than your private balance");
        lastAmount = input.value;
        if (isPub) showPublicReview(lamports);
        else void showReview(lamports);
      } catch (e) {
        setMsg(msg, e instanceof Error ? e.message : String(e), "err");
      }
    };
    const seg = h("div", { class: "seg", style: "margin-bottom:12px" },
      ...(["private", "public"] as const).map((s) => {
        const b = h("button", { class: source === s ? "on" : "", textContent: s === "private" ? "Private balance" : "Gateway (public)" });
        b.onclick = () => {
          if (source === s) return;
          source = s;
          lastAmount = "";
          form();
        };
        return b;
      }));
    review.onclick = go1;
    onEnter(input, go1);

    let toRow: HTMLElement;
    if (status.extraDestinations.length > 0) {
      const sel = h("select", { class: "input" });
      for (const a of [status.mainWallet, ...status.extraDestinations]) {
        sel.append(h("option", { value: a, textContent: a === status.mainWallet ? `Main · ${short(a)}` : short(a) }));
      }
      sel.value = dest;
      // the full address under the picker: check it against your wallet before you push
      const full = h("div", { class: "msg mono dest-full", textContent: dest });
      sel.onchange = () => {
        dest = sel.value;
        full.textContent = dest;
      };
      toRow = field("Send to", h("div", {}, sel, full));
    } else {
      toRow = h("div", { class: "summary" }, h("div", { class: "line" }, h("span", { class: "k", textContent: "To" }), h("span", { class: "vv mono", textContent: status.mainWallet })));
    }
    const fromDot = suggestedSol && !isPub && input.value === suggestedSol
      ? h("div", { class: "notice" }, h("strong", {}, "Filled in from your pump.fun buy. "), "Check the amount and where it goes before you push.")
      : null;
    root.replaceChildren(seg, box, toRow, fromDot ?? "", h("div", { style: "height:14px" }), review, msg,
      isPub ? "" : h("div", { style: "height:10px" }), isPub ? "" : privateSendLink());
    focusSoon(input);
  };

  const showReview = async (lamports: bigint, payWithToken = false) => {
    const all = balances !== null && lamports === priv;
    root.replaceChildren(
      h("div", { class: "amount-box" }, h("div", { class: "row" }, h("span", { style: "font-size:40px;font-weight:700;letter-spacing:-.02em", textContent: fmt(lamports) }), h("span", { class: "unit", textContent: "SOL" }))),
      h("div", { class: "notice", textContent: "Calculating fee…" }),
    );

    let q: Quote;
    try {
      q = await send<Quote>({ type: "quote", lamports: lamports.toString(), payWithToken });
    } catch (e) {
      root.replaceChildren(h("div", { class: "notice bad", textContent: e instanceof Error ? e.message : String(e) }), h("div", { style: "height:12px" }), (() => {
        const b = h("button", { class: "btn secondary", textContent: "Back" });
        b.onclick = form;
        return b;
      })());
      return;
    }

    const lines: HTMLElement[] = [
      h("div", { class: "line" }, h("span", { class: "k", textContent: "From" }), h("span", { class: "vv", textContent: "Private balance" })),
      h("div", { class: "line" }, h("span", { class: "k", textContent: "To" }), h("span", { class: "vv mono", textContent: dest })),
      h("div", { class: "line" }, h("span", { class: "k", textContent: "Network" }), h("span", { class: "vv", textContent: status.network })),
    ];
    const tok = q.token;
    const fmtTok = (raw: string) => (tok ? fmtToken(raw, tok.decimals) : raw);
    if (q.feeBps > 0 && BigInt(q.grossFeeLamports) > 0n) {
      const feeText =
        q.mode === "token" && tok
          ? `Burn ${fmtTok(tok.burnAmount)} ${tok.symbol}`
          : BigInt(q.feeLamports) === 0n
            ? "None"
            : `${fmt(q.feeLamports)} SOL`;
      lines.push(h("div", { class: "line" }, h("span", { class: "k", textContent: `Service fee (${(q.feeBps / 100).toString()}%)` }), h("span", { class: "vv", textContent: feeText })));
      if (q.discountBps > 0) {
        lines.push(h("div", { class: "line" }, h("span", { class: "k", textContent: `${q.tierName} discount` }), h("span", { class: "vv", textContent: `−${q.discountBps / 100}%` })));
      }
    }

    const extras: Child[] = [];
    if (tok && tok.canPay !== undefined && BigInt(q.grossFeeLamports) > 0n && BigInt(q.feeLamports) + (q.mode === "token" ? 1n : 0n) > 0n) {
      const tgl = h("label", { class: "check" });
      const box = h("input", { type: "checkbox", checked: q.mode === "token", disabled: !tok.canPay && q.mode !== "token" });
      box.onchange = () => void showReview(lamports, box.checked);
      tgl.append(box, `Pay the fee by burning ${fmtTok(tok.burnAmount)} ${tok.symbol} (gateway holds ${fmtTok(tok.vaultBalance)})`);
      extras.push(tgl);
    }
    if (q.notice) extras.push(h("div", { class: "notice" }, q.notice));
    if (!q.sufficientPublic) {
      extras.push(h("div", { class: "notice bad" }, `The gateway needs about ${fmt(q.requiredPublicLamports)} SOL of public SOL (network fees${q.mode === "sol" ? " + service fee" : ""}); it has ${fmt(q.publicLamports)}. Send some SOL to the gateway address (Receive).`));
    }

    const confirm = h("button", { class: "btn", textContent: "Confirm & push", disabled: !q.sufficientPublic });
    const back = h("button", { class: "btn secondary", textContent: "Edit" });
    back.onclick = form;
    confirm.onclick = () =>
      guarded(confirm, msg, "Proving & sending… (can take a minute)", async () => {
        back.disabled = true;
        const r = await send<{ signature: string; lamports: string; feeLamports: string; burned: string; url: string }>({
          type: "push",
          lamports: all ? "all" : lamports.toString(),
          to: dest,
          payWithToken: q.mode === "token",
          quotedAt: q.at,
        });
        const paid = BigInt(r.burned) > 0n && tok ? ` · burned ${fmtTok(r.burned)} ${tok.symbol}` : BigInt(r.feeLamports) > 0n ? ` · fee ${fmt(r.feeLamports)} SOL` : "";
        toast(`Sent ${fmtShort(r.lamports)} SOL${paid}`, "ok", r.url);
        view = "home";
        renderShell();
        void loadBalances();
      }).finally(() => {
        back.disabled = false;
      });

    root.replaceChildren(
      h("div", { class: "amount-box" }, h("div", { class: "row" }, h("span", { style: "font-size:40px;font-weight:700;letter-spacing:-.02em", textContent: fmt(lamports) }), h("span", { class: "unit", textContent: "SOL" }))),
      h("div", { class: "summary" }, ...lines),
      h("div", { style: "height:12px" }),
      h("div", { class: "stack" },
        ...extras,
        h("div", { class: "notice warn" }, h("strong", {}, "Withdrawals are public. "), "The amount and destination become visible on-chain."),
        confirm, back, msg));
  };

  form();
  return root;
}

/* ───────────────────────── private send ───────────────────────── */

function privateSendLink(): HTMLElement {
  const b = h("button", { class: "btn secondary small" }, icon("shield", 16), "Send privately to another gateway");
  b.onclick = () => go("private");
  return b;
}

/** Private balance -> another gateway's private address: a confidential transfer, nothing public but the fee. */
function privateView(): HTMLElement {
  const root = h("div", { class: "content" });
  const priv = balances ? BigInt(balances.privateLamports) : 0n;
  const msg = h("div", { class: "msg", style: "text-align:center" });
  let toText = "", amountText = "";

  const form = () => {
    const to = h("textarea", { class: "input mono", rows: 3, placeholder: "The other gateway's private address", spellcheck: false, autocomplete: "off" });
    to.value = toText;
    const { box, input } = amountBox(`Private balance: ${fmtShort(priv)} SOL`, () => fmt(priv));
    input.value = amountText;
    const review = h("button", { class: "btn", textContent: "Review" });
    const go1 = () => {
      try {
        const lamports = parseSol(input.value);
        if (lamports <= 0n) throw new Error("Enter an amount");
        if (balances && lamports > priv) throw new Error("That's more than your private balance");
        const addr = to.value.replace(/\s+/g, "");
        if (addr.length < 80) throw new Error("Paste the other gateway's private address (from its Receive screen)");
        toText = addr;
        amountText = input.value;
        confirmStep(addr, lamports);
      } catch (e) {
        setMsg(msg, e instanceof Error ? e.message : String(e), "err");
      }
    };
    review.onclick = go1;
    root.replaceChildren(
      field("Send to", to),
      box,
      h("div", { class: "notice" }, h("strong", {}, "Stays inside the pool. "), "Only the other gateway can see that it received this, or how much. The chain shows your gateway paying a network fee, nothing more."),
      h("div", { style: "height:14px" }), review, msg);
    focusSoon(toText ? input : to);
  };

  const confirmStep = (addr: string, lamports: bigint) => {
    const pass = passwordInput("Passphrase (required for private sends)");
    const confirm = h("button", { class: "btn", textContent: "Confirm & send" });
    const back = h("button", { class: "btn secondary", textContent: "Edit" });
    back.onclick = form;
    const submit = () =>
      guarded(confirm, msg, "Proving & sending… (can take a minute)", async () => {
        back.disabled = true;
        const r = await send<{ signature: string; lamports: string; url: string }>({ type: "sendPrivate", to: addr, lamports: lamports.toString(), passphrase: pass.input.value });
        toast(`Sent ${fmtShort(r.lamports)} SOL privately`, "ok", r.url);
        view = "home";
        renderShell();
        void loadBalances();
      }).finally(() => {
        back.disabled = false;
      });
    confirm.onclick = submit;
    onEnter(pass.input, submit);
    const line = (k: string, v: string, mono = false) =>
      h("div", { class: "line" }, h("span", { class: "k", textContent: k }), h("span", { class: mono ? "vv mono" : "vv", textContent: v }));
    root.replaceChildren(
      h("div", { class: "amount-box" }, h("div", { class: "row" }, h("span", { style: "font-size:40px;font-weight:700;letter-spacing:-.02em", textContent: fmt(lamports) }), h("span", { class: "unit", textContent: "SOL" }))),
      h("div", { class: "summary" },
        line("From", "Private balance"),
        line("To", addr, true),
        line("Network", status.network),
        line("Service fee", "None")),
      h("div", { style: "height:12px" }),
      h("div", { class: "stack" },
        h("div", { class: "notice warn" }, h("strong", {}, "Check the address. "), "A private send can't be undone, and no one but the receiver can see where it went."),
        field("Passphrase", pass.wrap), confirm, back, msg));
    focusSoon(pass.input);
  };

  form();
  return root;
}

/* ───────────────────────── receive ───────────────────────── */

function receiveView(): HTMLElement {
  const copyBtn = h("button", { class: "btn" }, icon("copy", 18), "Copy address");
  copyBtn.onclick = () => void copyText(status.address ?? "", "Gateway address copied");
  // the private address (for other gateways) and the payment link (for the pay page), both derived from the unlocked key
  const privCard = h("div", { class: "addr-card" }, h("div", { class: "section-label", textContent: "Private address" }), h("div", { class: "mono", textContent: "…" }));
  const copyPriv = h("button", { class: "btn secondary small", disabled: true }, icon("copy", 16), "Copy private address");
  const copyLink = h("button", { class: "btn secondary small", disabled: true }, icon("copy", 16), "Copy payment link");
  void send<{ address: string; link: string }>({ type: "privateAddress" }).then((r) => {
    privCard.lastElementChild!.textContent = r.address;
    copyPriv.disabled = copyLink.disabled = false;
    copyPriv.onclick = () => void copyText(r.address, "Private address copied");
    copyLink.onclick = () => void copyText(r.link, "Payment link copied");
  }).catch((e: unknown) => { privCard.lastElementChild!.textContent = e instanceof Error ? e.message : String(e); });
  return h("div", { class: "content" },
    h("div", { class: "stack" },
      h("div", { class: "addr-card" }, h("div", { class: "section-label", textContent: "Gateway address (public)" }), h("div", { class: "mono", textContent: status.address ?? "" })),
      copyBtn,
      h("div", { class: "notice" }, `Send SOL here on ${status.network} to fund deposits and to cover withdrawal fees (keep a little public SOL in the gateway).`),
      h("div", { style: "height:6px" }),
      privCard,
      h("div", { class: "row-btns" }, copyPriv, copyLink),
      h("div", { class: "notice" }, h("strong", {}, "Straight into your private balance. "),
        "Another Helium gateway can send to this address privately. Anyone else can pay you from their own wallet with the payment link, without your gateway's public address showing up. Share them only with people paying you: whoever has either one can see every deposit to it, your own shields included.")));
}

/* ───────────────────────── settings ───────────────────────── */

function settingsView(): HTMLElement {
  // Main wallet
  const mainIn = h("input", { class: "input", type: "text", placeholder: "Main wallet address", value: status.mainWallet, autocomplete: "off" });
  const mainPass = passwordInput("Passphrase (required to change)");
  const mainBtn = h("button", { class: "btn secondary small", textContent: "Save main wallet" });
  const mainMsg = h("div", { class: "msg" });
  mainBtn.onclick = () =>
    guarded(mainBtn, mainMsg, "Saving…", async () => {
      await send({ type: "setMain", passphrase: mainPass.input.value, main: mainIn.value });
      toast("Main wallet saved", "ok");
      await render();
      view = "settings";
      renderShell();
    });

  // Network
  let net = status.network;
  const seg = h("div", { class: "seg" });
  const confirmRow = h("label", { class: "check", style: "display:none" });
  const confirmBox = h("input", { type: "checkbox" });
  confirmRow.append(confirmBox, "I understand mainnet uses real funds");
  const paintSeg = () => {
    seg.replaceChildren(
      ...(["devnet", "mainnet"] as const).map((n) => {
        const b = h("button", { class: net === n ? "on" : "", textContent: n === "devnet" ? "Devnet (test)" : "Mainnet (real)" });
        b.onclick = () => {
          net = n;
          paintSeg();
        };
        return b;
      }),
    );
    confirmRow.style.display = net === "mainnet" && status.network !== "mainnet" ? "flex" : "none";
  };
  paintSeg();
  const keyIn = passwordInput(status.hasApiKey ? "API key saved — leave blank to keep" : "Helius API key");
  const netBtn = h("button", { class: "btn secondary small", textContent: "Save network settings" });
  const netMsg = h("div", { class: "msg" });
  netBtn.onclick = () =>
    guarded(netBtn, netMsg, "Saving…", async () => {
      await send({ type: "saveSettings", apiKey: keyIn.input.value, network: net, confirmMainnet: confirmBox.checked });
      balances = null;
      balError = null;
      toast("Network settings saved", "ok");
      await render();
      view = "settings";
      renderShell();
    });

  // Backup
  const expPass = passwordInput("Passphrase");
  const expBtn = h("button", { class: "btn secondary small", textContent: "Reveal recovery key" });
  const expOut = h("div", { class: "addr-card mono", style: "display:none" });
  const expMsg = h("div", { class: "msg" });
  expBtn.onclick = () =>
    guarded(expBtn, expMsg, "Checking…", async () => {
      const r = await send<{ seedHex: string }>({ type: "exportSeed", passphrase: expPass.input.value });
      expOut.textContent = r.seedHex;
      expOut.style.display = "block";
      setMsg(expMsg, "Anyone who sees this can spend everything in the gateway.", "err");
    });

  const group = (label: string, ...kids: Child[]) => h("div", {}, h("div", { class: "section-label", textContent: label }), h("div", { class: "stack" }, ...kids));

  // Extra push destinations (optionally tier-gated)
  const prodI = status.product;
  let destGroup: HTMLElement | null = null;
  if (prodI.maxExtraDestinations > 0) {
    const needTier = prodI.extraDestinationsMinTier > 0 ? prodI.tiers[prodI.extraDestinationsMinTier - 1]?.name : null;
    const dAddr = h("input", { class: "input", type: "text", placeholder: "Extra destination address", autocomplete: "off" });
    const dPass = passwordInput("Passphrase");
    const dBtn = h("button", { class: "btn secondary small", textContent: "Add destination" });
    const dMsg = h("div", { class: "msg" });
    dBtn.onclick = () =>
      guarded(dBtn, dMsg, "Saving…", async () => {
        await send({ type: "addDestination", passphrase: dPass.input.value, address: dAddr.value });
        toast("Destination saved", "ok");
        await render();
        view = "settings";
        renderShell();
      });
    const rows = status.extraDestinations.map((a) => {
      const rm = h("button", { class: "iconbtn", title: "Remove" }, icon("back", 16));
      rm.textContent = "✕";
      rm.onclick = async () => {
        await send({ type: "removeDestination", address: a });
        await render();
        view = "settings";
        renderShell();
      };
      return h("div", { class: "row-item" }, h("div", { class: "meta" }, h("div", { class: "s mono", textContent: a })), rm);
    });
    destGroup = group(
      "Extra destinations",
      needTier ? h("div", { class: "notice" }, `Saving extra destinations needs the ${needTier} tier (hold ${prodI.tokenSymbol ?? "tokens"} in your gateway).`) : null,
      rows.length ? h("div", { class: "list" }, ...rows) : null,
      dAddr, dPass.wrap, dBtn, dMsg);
  }

  // Security: passkeys, auto-lock, passphrase
  const pkMsg = h("div", { class: "msg" });
  const pkRows = status.passkeys.map((p) => {
    const rm = h("button", { class: "btn secondary small", textContent: "Remove" });
    rm.onclick = () =>
      guarded(rm, pkMsg, "Removing…", async () => {
        await send({ type: "removePasskey", id: p.id });
        toast("Passkey removed. It stays in your password manager until you delete it there.", "ok");
        await render();
        view = "settings";
        renderShell();
      });
    const added = new Date(p.added).toLocaleDateString(undefined, { dateStyle: "medium" });
    return h("div", { class: "row-item" }, h("div", { class: "meta" }, h("div", { class: "s", textContent: p.label }), h("div", { class: "msg", textContent: `Added ${added}` })), rm);
  });
  const pkPass = passwordInput("Passphrase (required to add one)");
  const pkAdd = h("button", { class: "btn secondary small", textContent: status.passkeys.length ? "Add another passkey" : "Add a passkey" });
  pkAdd.onclick = () =>
    guarded(pkAdd, pkMsg, "Follow your browser's passkey prompt…", async () => {
      if (!passkeysAvailable()) throw new Error("This browser can't use passkeys here");
      if ((await prfSupport()) === false) throw new Error("This browser can't unlock with passkeys yet (no PRF support). Chrome, Edge and Safari can.");
      const pass = pkPass.input.value;
      await send({ type: "checkPassphrase", passphrase: pass }); // before a passkey is made, so a typo leaves nothing behind
      const pk = await makePasskey();
      await send({ type: "addPasskey", passphrase: pass, ...pk });
      toast("Passkey added. Use it next time you unlock.", "ok");
      await render();
      view = "settings";
      renderShell();
    });

  const alSeg = h("div", { class: "seg" },
    ...AUTOLOCK_CHOICES.map((m) => {
      const b = h("button", { class: status.autolockMinutes === m ? "on" : "", textContent: `${m} min` });
      b.onclick = async () => {
        try {
          await send({ type: "setAutolock", minutes: m });
          await render();
          view = "settings";
          renderShell();
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e), "err");
        }
      };
      return b;
    }));

  const cpOld = passwordInput("Current passphrase");
  const cpNew = passwordInput(`New passphrase (${MIN_PASSPHRASE_LENGTH}+ characters)`);
  const cpNew2 = passwordInput("Confirm new passphrase");
  const cpMeter = strengthMeter(cpNew.input);
  const cpBtn = h("button", { class: "btn secondary small", textContent: "Change passphrase" });
  const cpMsg = h("div", { class: "msg" });
  cpBtn.onclick = () =>
    guarded(cpBtn, cpMsg, "Re-encrypting…", async () => {
      if (cpNew.input.value !== cpNew2.input.value) throw new Error("The new passphrases do not match");
      await send({ type: "changePassphrase", passphrase: cpOld.input.value, next: cpNew.input.value });
      toast("Passphrase changed", "ok");
      await render();
      view = "settings";
      renderShell();
    });

  const asSeg = h("div", { class: "seg" },
    ...([false, true] as const).map((on) => {
      const b = h("button", { class: status.autoShield === on ? "on" : "", textContent: on ? "On" : "Off" });
      b.onclick = async () => {
        try {
          await send({ type: "setAutoShield", on });
          await render();
          view = "settings";
          renderShell();
          if (on) void loadBalances();
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e), "err");
        }
      };
      return b;
    }));

  const lockNow = h("button", { class: "btn secondary", textContent: "Lock gateway" });
  lockNow.onclick = async () => {
    await send({ type: "lock" });
    balances = null;
    view = "home";
    await render();
  };

  const outNow = h("button", { class: "btn secondary" }, icon("logout", 18), "Log out and switch gateway");
  outNow.onclick = () => void logOut().catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "err"));

  const dotBtn = h("button", { class: "btn secondary", textContent: "Dot settings" });
  dotBtn.onclick = () => go("dot");

  return h("div", { class: "content" },
    h("div", { class: "stack", style: "gap:18px" },
      group("Trading dot", dotBtn,
        h("div", { class: "msg", textContent: "Turn the dot on trading sites on or off, pick its actions, and set the pump.fun Unshield buttons." })),
      group("Main wallet (push destination)", mainIn, mainPass.wrap, mainBtn, mainMsg),
      destGroup,
      group("Helius network", seg, confirmRow, keyIn.wrap, netBtn, netMsg),
      group("Shield incoming SOL automatically", asSeg,
        h("div", { class: "msg", textContent: "While this wallet is open and unlocked, SOL that arrives at the gateway's public address is shielded within a minute, keeping 0.01 SOL for fees. Amounts under 0.005 SOL are left alone." })),
      group("Unlock with a passkey",
        h("div", { class: "notice" }, "Unlock with Windows Hello, Touch ID, your phone or a security key instead of typing your passphrase, so there's nothing for a keylogger to catch. Your passphrase still works, and is still needed to change wallets or reveal the recovery key."),
        pkRows.length ? h("div", { class: "list" }, ...pkRows) : null,
        pkPass.wrap, pkAdd, pkMsg),
      group("Lock after idle", alSeg, h("div", { class: "msg", textContent: "The key leaves memory when the gateway locks. Shorter is safer." })),
      group("Passphrase",
        status.weakPassphrase ? h("div", { class: "notice warn" }, h("strong", {}, "Your passphrase is easy to guess. "), "Anyone who copies this browser's data could try passphrases offline. Change it to a longer one.") : null,
        cpOld.wrap, cpNew.wrap, cpMeter, cpNew2.wrap, cpBtn, cpMsg),
      group("Backup", expPass.wrap, expBtn, expOut, expMsg),
      lockNow,
      group("Other gateways", outNow,
        h("div", { class: "msg", textContent: "Logging out locks this gateway and keeps it saved here, encrypted. Pick it again from the start screen and unlock it with its own passphrase or passkey. Each gateway keeps its own main wallet and destinations." })),
      h("div", { class: "notice" }, "Keep your recovery key offline. It's the only way back into this gateway.")));
}

/* ───────────────────────── boot ───────────────────────── */

void render();
