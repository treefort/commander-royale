// Plays match specs on a pool of worker threads (tools/balance-worker.ts). A worker that crashes is
// replaced and its match counted as failed, so one bad match can't take a long run down with it.
import type { MatchSpec, MatchResult } from "./arena.ts";

export async function playAll<S extends MatchSpec>(
  specs: S[], workers: number, onResult: (spec: S, result: MatchResult | null, error?: string) => void,
): Promise<void> {
  const url = new URL("./balance-worker.ts", import.meta.url).href;
  let next = 0;
  await new Promise<void>((resolve) => {
    let live = 0;
    const start = () => {
      if (next >= specs.length) {
        if (live === 0) resolve();
        return;
      }
      live++;
      const w = new Worker(url);
      let current: S | null = null;
      const feed = () => {
        if (next >= specs.length) {
          w.terminate();
          live--;
          if (live === 0) resolve();
          return;
        }
        current = specs[next++];
        w.postMessage(current);
      };
      w.onmessage = (e: MessageEvent<{ ok: boolean; result?: MatchResult; error?: string }>) => {
        onResult(current!, e.data.ok ? e.data.result! : null, e.data.error);
        feed();
      };
      w.onerror = (e: ErrorEvent) => {
        e.preventDefault?.();
        if (current) onResult(current, null, `worker crashed: ${e.message}`);
        current = null;
        w.terminate();
        live--;
        start();
      };
      feed();
    };
    for (let i = 0; i < Math.min(workers, specs.length); i++) start();
  });
}
