import { api } from "./api.ts";
import { renderHome, renderLogin, renderGate, type Me } from "./ui/home.ts";
import { LobbyPage } from "./ui/lobby.ts";
import { BattleScreen } from "./battle/screen.ts";
import { renderChallenge } from "./ui/challenge.ts";
import { renderMaps } from "./ui/maps.ts";
import { MapEditor } from "./ui/editor.ts";

const root = document.getElementById("app")!;
let me: Me;
let current: { destroy(): void } | null = null;

function go(path: string) {
  history.pushState(null, "", path);
  route();
}
window.addEventListener("popstate", route);

async function route() {
  current?.destroy();
  current = null;
  document.body.classList.remove("battle");
  const path = location.pathname;
  // keep the query too: a ?settings= link from an AI assistant survives signing in
  if (!me.user) return renderLogin(root, me, path + location.search);
  // signed in, but this server wants something more first, e.g. a passkey (then carry on to where they were going)
  if (me.gate) return renderGate(root, me, async () => {
    me = await api<Me>("/api/me");
    await route();
  });
  if (path === "/maps") return renderMaps(root, me, go);
  const map = path.match(/^\/maps\/(new|[A-Za-z0-9]+)$/);
  if (map) {
    current = new MapEditor(root, me, go, map[1] === "new" ? null : map[1]);
    return;
  }
  const c = path.match(/^\/c\/([A-Za-z0-9]+)/);
  if (c) return renderChallenge(root, me, c[1], go);
  const m = path.match(/^\/m\/([A-Za-z0-9]+)/);
  if (m) {
    const id = m[1];
    try {
      const state = await api(`/api/matches/${id}`);
      // a battle in progress can be joined too: hire, equip and deploy from the lobby page
      if (state.status === "lobby" || (state.status === "playing" && !state.you?.deployed)) {
        // following an invite link joins the match automatically (with a squad of your own)
        if (!state.you) await api(`/api/matches/${id}/join`, { body: {} });
        current = new LobbyPage(root, id, me, go, () => route());
      } else {
        if (!state.you) throw new Error("this battle is over");
        document.body.classList.add("battle");
        current = new BattleScreen(root, id, { id: me.user.id, name: me.user.name }, () => go("/"), go);
      }
    } catch (e) {
      root.innerHTML = "";
      root.append(Object.assign(document.createElement("div"), { className: "wrap panel err", textContent: `Can't open this match: ${(e as Error).message}` }));
    }
    return;
  }
  await renderHome(root, me, go);
}

(async () => {
  me = await api<Me>("/api/me");
  await route();
})();
