// The original game files in ./gamedata, for tools and tests running outside the server.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const G = join(import.meta.dir, "..", "gamedata");
const cache = new Map<string, Uint8Array>();
export const files = (p: string) => {
  let d = cache.get(p.toUpperCase());
  if (!d) {
    d = new Uint8Array(readFileSync(join(G, p)));
    cache.set(p.toUpperCase(), d);
  }
  return d;
};
export const has = (p: string) => existsSync(join(G, p));
