// Worker thread for tools/balance.ts: plays the matches it is sent and posts back the results.
import { runMatch, type MatchSpec } from "./arena.ts";

declare const self: Worker;

self.onmessage = (e: MessageEvent<MatchSpec>) => {
  try {
    postMessage({ ok: true, result: runMatch(e.data) });
  } catch (err) {
    postMessage({ ok: false, seed: e.data.seed, error: String((err as Error)?.stack ?? err) });
  }
};
