// The trading dot's settings (src/dock.ts), shown inside the wallet: Settings → Dot settings (src/popup.ts). They need
// no key, so they're read and written straight in the extension's storage; the background tells every open dot. If
// this browser still has the gateway an earlier version of the extension held, the screen also offers its recovery
// key (behind its passphrase).
import { dockPrefsFrom, fundAmount, fundIsAuto, type DockAction, type DockPrefs, type Response, type SettingsRequest } from "./messages";

const SITES = ["pump.fun", "Axiom", "Photon", "BullX", "GMGN", "DexScreener", "Birdeye", "Jupiter", "Raydium", "Meteora", "Padre", "letsbonk.fun"];

type Child = Node | string | null | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, style, ...rest } = props;
  if (cls) e.className = String(cls);
  if (style) e.setAttribute("style", String(style));
  Object.assign(e, rest);
  for (const k of kids) if (k) e.append(k);
  return e;
}
/** To the extension's background (src/ext-background.ts), not the wallet's key worker. */
function toBackground<T>(req: SettingsRequest): Promise<T> {
  return chrome.runtime.sendMessage(req).then((r: Response<T>) => {
    if (!r.ok) throw new Error(r.error);
    return r.data;
  });
}

function check(label: string, on: boolean, change: (v: boolean) => void, disabled = false): HTMLElement {
  const box = h("input", { type: "checkbox", checked: on, disabled });
  box.onchange = () => change(box.checked);
  return h("label", { class: "check" }, box, label);
}
function seg<T extends number>(options: { v: T; label: string }[], cur: T, change: (v: T) => void, disabled = false): HTMLElement {
  return h("div", { class: "seg" },
    ...options.map((o) => {
      const b = h("button", { class: cur === o.v ? "on" : "", textContent: o.label, disabled });
      b.onclick = () => change(o.v);
      return b;
    }));
}
const group = (label: string, ...kids: Child[]) => h("div", {}, h("div", { class: "section-label", textContent: label }), h("div", { class: "stack" }, ...kids));

/** The whole screen's content; it loads the settings and redraws itself on every change. */
export function dotSettingsView(): HTMLElement {
  const root = h("div", { class: "content" }, h("div", { class: "msg", textContent: "Loading…" }));
  let prefs: DockPrefs;
  let legacy: string | null = null;

  async function save(next: Partial<DockPrefs>) {
    prefs = { ...prefs, ...next };
    await chrome.storage.local.set({ dock: prefs }); // the background tells every open dot
    draw();
  }

  function draw() {
    const off = !prefs.enabled;
    const labels: Record<DockAction, string> = { push: "Push to a wallet", shield: "Shield SOL", receive: "Receive", home: "Open the gateway" };
    const actionChecks = (Object.keys(labels) as DockAction[]).map((a) =>
      check(labels[a], prefs.actions[a], (v) => void save({ actions: { ...prefs.actions, [a]: v } }), off));

    const f = prefs.fund;
    const fundOff = off || !f.enabled;
    const example = fundAmount(1.37, f);
    const fund = group("Unshield for pump.fun buys",
      check("Add Unshield buttons to pump.fun's buy panel: one for the amount I type, and an orange one under each quick-buy amount", f.enabled, (v) => void save({ fund: { ...f, enabled: v } }), off),
      h("div", { class: "msg", textContent: "Leeway on the ≈ SOL estimate (its price moves)" }),
      seg([{ v: 0, label: "None" }, { v: 1, label: "1%" }, { v: 3, label: "3%" }, { v: 5, label: "5%" }, { v: 10, label: "10%" }], f.bufferPct, (v) => void save({ fund: { ...f, bufferPct: v } }), fundOff),
      h("div", { class: "msg", textContent: "Plus, for network fees and the token account" }),
      seg([{ v: 0, label: "None" }, { v: 0.003, label: "0.003" }, { v: 0.005, label: "0.005" }, { v: 0.01, label: "0.01 SOL" }], f.bufferSol, (v) => void save({ fund: { ...f, bufferSol: v } }), fundOff),
      h("div", { class: "msg", textContent: "Round up to" }),
      seg([{ v: 0.001, label: "0.001" }, { v: 0.01, label: "0.01" }, { v: 0.1, label: "0.1" }, { v: 1, label: "1 SOL" }], f.roundSol, (v) => void save({ fund: { ...f, roundSol: v } }), fundOff),
      h("div", { class: "msg", textContent: "One click unshields up to" }),
      seg([{ v: 0, label: "Always review" }, { v: 0.5, label: "0.5" }, { v: 1, label: "1" }, { v: 2, label: "2" }, { v: 5, label: "5 SOL" }], f.autoMax, (v) => void save({ fund: { ...f, autoMax: v } }), fundOff),
      h("div", { class: "notice" },
        f.autoMax > 0
          ? `A 1.37 SOL buy would unshield ${example} SOL${fundIsAuto(example, f) ? " in one click" : ", which is above your limit, so you'd review it first"}. One-click pushes only ever go to the main wallet saved in your gateway, and the gateway must be unlocked. Larger amounts open the review. `
          : `A 1.37 SOL buy would push ${example} SOL. You review and confirm every push in the gateway. `,
        h("strong", {}, "Pushes are public, "),
        "so a push that matches the buy to the lamport, seconds before it, links the two. Rounding up and keeping some SOL in your trading wallet makes that harder."),
      check("Add my shielded SOL to pump.fun's wallet balance and list it in its dropdown", prefs.showShielded, (v) => void save({ showShielded: v }), off),
      h("div", { class: "msg", textContent: "Uses the amount your gateway last read while unlocked, kept for 10 minutes; after that it shows as expired until you unlock the gateway again. A devnet gateway's test SOL is only listed in the dropdown, never added to the total. The combined total is written into pump.fun's page, so pump.fun's own scripts could read it; turn this off if that matters to you." }));

    const reset = h("button", { class: "btn secondary small", textContent: "Move the dot back to the right edge", disabled: off });
    reset.onclick = () => void save({ side: "right", y: 0.62 });
    const hiddenRows = prefs.hidden.map((site) => {
      const show = h("button", { class: "btn secondary small", textContent: "Show" });
      show.onclick = () => void save({ hidden: prefs.hidden.filter((s) => s !== site) });
      return h("div", { class: "row-item" }, h("div", { class: "meta" }, h("div", { class: "s mono", textContent: site })), show);
    });

    root.replaceChildren(
      h("div", { class: "stack", style: "gap:18px" },
        group("The dot",
          check("Show the Helium dot on trading sites", prefs.enabled, (v) => void save({ enabled: v })),
          check("Tuck it half off the edge when idle", prefs.tuck, (v) => void save({ tuck: v }), off),
          reset,
          h("div", { class: "msg", textContent: `Shows on ${SITES.join(", ")}. Its actions open this wallet in a small window.` })),
        group("Quick actions in the fan", ...actionChecks),
        fund,
        hiddenRows.length ? group("Hidden on", h("div", { class: "list" }, ...hiddenRows)) : null,
        legacy ? legacyGroup(legacy) : null));
  }

  void (async () => {
    prefs = dockPrefsFrom((await chrome.storage.local.get("dock")).dock);
    legacy = (await toBackground<{ address: string | null }>({ type: "legacy" }).catch(() => ({ address: null }))).address;
    draw();
  })();
  return root;
}

/** The gateway an earlier version of this extension held: its keys stay here until the user moves them. */
function legacyGroup(address: string): HTMLElement {
  const pw = h("input", { class: "input", type: "password", placeholder: "Its passphrase", autocomplete: "off" });
  const btn = h("button", { class: "btn secondary small", textContent: "Reveal recovery key" });
  const out = h("div", { class: "addr-card mono", style: "display:none" });
  const msg = h("div", { class: "msg" });
  btn.onclick = async () => {
    btn.disabled = true;
    msg.className = "msg";
    msg.textContent = "Checking…";
    try {
      const r = await toBackground<{ seedHex: string }>({ type: "legacyExport", passphrase: pw.value });
      out.textContent = r.seedHex;
      out.style.display = "block";
      msg.className = "msg err";
      msg.textContent = "Anyone who sees this can spend everything in that gateway. To use it here, choose “I already have a recovery key” when creating a gateway and paste it.";
    } catch (e) {
      msg.className = "msg err";
      msg.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      btn.disabled = false;
    }
  };
  return group("Gateway from an earlier version",
    h("div", { class: "notice" }, `The gateway an earlier version of this extension held (${address.slice(0, 4)}…${address.slice(-4)}) is still stored in this browser. Reveal its recovery key with its passphrase to keep it.`),
    pw, btn, out, msg);
}
