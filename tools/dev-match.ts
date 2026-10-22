// Dev helper: creates and starts a test match on a running local server (dev login), so you can jump
// straight into a battle in the browser. Players are "Alice" and either "Bob" or an AI squad.
//
//   bun tools/dev-match.ts [--biome CULTA] [--time day] [--budget 400000] [--ufo none] [--bot swarm]
//                          [--drops 3] [--kit STR_RIFLE:STR_RIFLE_CLIP] [--url http://localhost:3000]
//
// Then open http://localhost:3000/auth/dev?name=Alice&next=/m/<id> (and Bob in another browser profile).
// End someone's turn without a browser: bun tools/dev-endturn.ts Bob <id>
export {};
const arg = (name: string, def?: string) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const base = arg("url", "http://localhost:3000")!;

async function login(name: string) {
  const r = await fetch(`${base}/auth/dev?name=${encodeURIComponent(name)}&next=/`, { redirect: "manual" });
  const cookie = r.headers.get("set-cookie");
  if (!cookie) throw new Error("dev login failed: is the server running with dev login enabled?");
  return cookie.split(";")[0];
}
async function call(cookie: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method: body ? "POST" : "GET", headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`);
  return j;
}

const settings: Record<string, unknown> = {
  name: "Dev Match", biome: arg("biome", "CULTA"), timeOfDay: arg("time", "day"), ufo: arg("ufo", "none"),
  mapBlocks: Number(arg("blocks", "4")), budget: Number(arg("budget", "400000")),
};
if (arg("drops")) settings.supplyDrops = { enabled: true, everyRounds: Number(arg("drops")), warningRounds: 2, tier: "mixed" };
const [weapon, clip] = (arg("kit", "STR_RIFLE:STR_RIFLE_CLIP")!).split(":");

const alice = await login("Alice");
const { id } = await call(alice, "/api/matches", { settings });
const bot = arg("bot");
const bob = bot ? null : await login("Bob");
if (bot) await call(alice, `/api/matches/${id}/addbot`, { strategy: bot });
else await call(bob!, `/api/matches/${id}/join`, {});
const st = await call(alice, `/api/matches/${id}`);
const soldiers = st.pool.filter((p: { kind: string }) => p.kind === "soldier");
const squad = (from: number) => ({
  squad: soldiers.slice(from, from + 6).map((r: { id: string }) => ({
    recruitId: r.id, armor: "STR_NONE_UC",
    items: [{ type: weapon, slot: "STR_RIGHT_HAND", x: 0, y: 0, ...(clip ? { ammo: clip } : {}) }, { type: "STR_GRENADE", slot: "STR_BELT", x: 0, y: 0 }],
  })),
  stash: [],
});
for (const [cookie, from] of [[alice, 0], ...(bob ? [[bob, 6]] : [])] as [string, number][]) {
  const r = await call(cookie, `/api/matches/${id}/loadout`, { loadout: squad(from) });
  if (!r.check.ok) throw new Error("loadout rejected: " + r.check.errors.join("; "));
  await call(cookie, `/api/matches/${id}/ready`, { ready: true });
}
await call(alice, `/api/matches/${id}/start`, {});
console.log(id);
console.log(`${base}/auth/dev?name=Alice&next=/m/${id}`);
