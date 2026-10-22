// Fetches original game files from the server (signed-in only) and keeps them in the browser's
// Cache Storage so they're downloaded once.
const CACHE = "xcom-gamedata-v1";
const files = new Map<string, Uint8Array>();

function key(path: string) {
  return path.toUpperCase().replace(/\\/g, "/");
}

export async function preload(paths: string[], onProgress?: (done: number, total: number) => void): Promise<void> {
  const todo = [...new Set(paths.map(key))].filter((p) => !files.has(p));
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
  } catch {
    cache = null;
  }
  let done = 0;
  const total = todo.length;
  const queue = [...todo];
  const worker = async () => {
    while (queue.length) {
      const p = queue.shift()!;
      const url = "/game/" + p;
      let res = cache ? await cache.match(url) : undefined;
      if (!res) {
        res = await fetch(url, { credentials: "same-origin" });
        if (res.ok && cache) await cache.put(url, res.clone()).catch(() => {});
      }
      if (res.ok) files.set(p, new Uint8Array(await res.arrayBuffer()));
      onProgress?.(++done, total);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

export function getFile(path: string): Uint8Array {
  const d = files.get(key(path));
  if (!d) throw new Error("game file not loaded: " + path);
  return d;
}

export function hasFile(path: string): boolean {
  return files.has(key(path));
}
