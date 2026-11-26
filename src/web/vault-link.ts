// The wallet UI (src/popup.ts) talks to the key-holding worker (src/background.ts in a dedicated Web Worker) through
// this: one request, one answer. The key never crosses it, except the recovery key at creation and on explicit export.
export function vaultLink(workerUrl: string): (req: unknown) => Promise<unknown> {
  const worker = new Worker(workerUrl, { type: "module" });
  let next = 1;
  const pending = new Map<number, (res: unknown) => void>();
  worker.onmessage = (ev: MessageEvent<{ id: number; res: unknown }>) => {
    const done = pending.get(ev.data.id);
    if (done) {
      pending.delete(ev.data.id);
      done(ev.data.res);
    }
  };
  worker.onerror = (e) => {
    for (const [, done] of pending) done({ ok: false, error: `Gateway worker failed to start: ${e.message ?? "unknown error"}` });
    pending.clear();
  };
  return (req) =>
    new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      worker.postMessage({ id, req });
    });
}
