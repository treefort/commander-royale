// Dev helper: ends the current turn for a (dev login) player over the websocket, e.g. to fast-forward
// rounds in a test match without a second browser.
//
//   bun tools/dev-endturn.ts <name> <matchId> [--url http://localhost:3000]
export {};
const [name, id] = process.argv.slice(2);
if (!name || !id) throw new Error("usage: bun tools/dev-endturn.ts <name> <matchId>");
const i = process.argv.indexOf("--url");
const base = i >= 0 ? process.argv[i + 1] : "http://localhost:3000";
const r = await fetch(`${base}/auth/dev?name=${encodeURIComponent(name)}&next=/`, { redirect: "manual" });
const cookie = r.headers.get("set-cookie")?.split(";")[0];
if (!cookie) throw new Error("dev login failed");
const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?match=${id}`, { headers: { cookie } } as never);
ws.onopen = () => setTimeout(() => ws.send(JSON.stringify({ t: "cmd", seq: 1, cmd: { c: "endturn" } })), 500);
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.t === "result") {
    console.log(m.ok ? "turn ended" : `refused: ${m.error}`);
    setTimeout(() => process.exit(m.ok ? 0 : 1), 300);
  }
};
setTimeout(() => {
  console.error("timed out");
  process.exit(1);
}, 8000);
