// Runs the extension's background logic (src/background.ts) inside a dedicated Web Worker on the website.
// It provides the small part of the `chrome` API that background.ts uses:
//  - storage.local   -> IndexedDB (the encrypted vault blob and settings; per-origin, survives reloads)
//  - storage.session -> worker memory only (the unlocked seed: gone on reload, tab close or Lock)
//  - alarms          -> timers (auto-lock)
//  - runtime.onMessage <- postMessage from the page
// The page never receives the seed except through the explicit, passphrase-gated export.
type Listener = (req: unknown, sender: { id: string; url: string }, reply: (res: unknown) => void) => boolean | void;

const DB = "private-vault";
const STORE = "kv";
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = fn(d.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const keysOf = (k: string | string[]) => (Array.isArray(k) ? k : [k]);

const local = {
  async get(k: string | string[]) {
    const out: Record<string, unknown> = {};
    for (const key of keysOf(k)) {
      const v = await tx("readonly", (s) => s.get(key));
      if (v !== undefined) out[key] = v;
    }
    return out;
  },
  async set(items: Record<string, unknown>) {
    for (const [k, v] of Object.entries(items)) await tx("readwrite", (s) => s.put(v, k));
  },
  async remove(k: string | string[]) {
    for (const key of keysOf(k)) await tx("readwrite", (s) => s.delete(key));
  },
};

const mem = new Map<string, unknown>();
const session = {
  async get(k: string | string[]) {
    const out: Record<string, unknown> = {};
    for (const key of keysOf(k)) if (mem.has(key)) out[key] = mem.get(key);
    return out;
  },
  async set(items: Record<string, unknown>) {
    for (const [k, v] of Object.entries(items)) mem.set(k, v);
  },
  async remove(k: string | string[]) {
    for (const key of keysOf(k)) mem.delete(key);
  },
};

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const alarmListeners: ((a: { name: string }) => void)[] = [];
const alarms = {
  async create(name: string, info: { delayInMinutes?: number }) {
    clearTimeout(timers.get(name));
    timers.set(name, setTimeout(() => {
      timers.delete(name);
      for (const f of alarmListeners) f({ name });
    }, (info.delayInMinutes ?? 1) * 60_000));
  },
  async clear(name: string) {
    clearTimeout(timers.get(name));
    return timers.delete(name);
  },
  onAlarm: { addListener: (f: (a: { name: string }) => void) => void alarmListeners.push(f) },
};

const listeners: Listener[] = [];
const ID = "private-vault-web";
// background.ts trusts messages whose sender URL is under runtime.getURL(""): here that is only the page that owns
// this worker (there are no content scripts on the website).
const BASE = `${ID}:/`;
// Messages can arrive before background.ts has registered its listener; hold them until it has.
const early: MessageEvent<{ id: number; req: unknown }>[] = [];
// defineProperty, not assignment: in an extension's worker `chrome` may already exist (and not be writable)
Object.defineProperty(globalThis, "chrome", { configurable: true, writable: true, value: {
  runtime: {
    id: ID,
    getURL: (path: string) => BASE + path,
    onMessage: {
      addListener: (f: Listener) => {
        listeners.push(f);
        for (const ev of early.splice(0)) dispatch(ev);
      },
    },
  },
  storage: { local, session, onChanged: { addListener: () => undefined } },
  alarms,
} });

function dispatch(ev: MessageEvent<{ id: number; req: unknown }>) {
  const { id, req } = ev.data ?? ({} as { id: number; req: unknown });
  const reply = (res: unknown) => (self as unknown as Worker).postMessage({ id, res });
  const f = listeners[0];
  if (!f) {
    early.push(ev);
    return;
  }
  f(req, { id: ID, url: `${BASE}app` }, reply);
}
self.onmessage = dispatch;
