import { api } from "./api.ts";
import { renderHome, renderLogin, type Me } from "./ui/home.ts";
import { LobbyPage } from "./ui/lobby.ts";
import { BattleScreen } from "./battle/screen.ts";

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
  if (!me.user) return renderLogin(root, me, path);
  const m = path.match(/^\/m\/([A-Za-z0-9]+)/);
  if (m) {
    const id = m[1];
    try {
      const state = await api(`/api/matches/${id}`);
      if (state.status === "lobby") {
        // following an invite link joins the match automatically (with a squad of your own if there's a slot,
        // else as a teammate in a co-op squad with room; the server says if it's full)
        if (!state.you) await api(`/api/matches/${id}/join`, { body: {} });
        current = new LobbyPage(root, id, me, go, () => route());
      } else {
        if (!state.you) throw new Error("this battle has already started without you");
        document.body.classList.add("battle");
        current = new BattleScreen(root, id, { id: me.user.id, name: me.user.name }, () => go("/"));
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
