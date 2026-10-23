// "Share as challenge": a link anyone can follow to play your side of this battle from its start, against the AI.
import { api, el } from "../api.ts";

/** Opens the dialog over the battle; `go` leaves the battle for the challenge's page. */
export function shareDialog(root: HTMLElement, matchId: string, defaultTitle: string, existing: string | null, go: (path: string) => void) {
  const close = () => bg.remove();
  const title = el("input", { value: defaultTitle, maxlength: 40, style: { width: "100%", boxSizing: "border-box" } }) as HTMLInputElement;
  const body = el("div", {});
  const error = el("div", { class: "err" });
  const box = el("div", { class: "panel share-box" }, el("h2", {}, "SHARE AS CHALLENGE"), body, error);
  const bg = el("div", { class: "modal-bg" }, box);
  // the battle listens for keys on the window: typing here mustn't move units
  bg.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
  });
  bg.addEventListener("mousedown", (e) => e.target === bg && close());

  const showLink = (id: string) => {
    const url = `${location.origin}/c/${id}`;
    const link = el("input", { class: "invite", value: url, readonly: true, style: { width: "100%", boxSizing: "border-box" } }) as HTMLInputElement;
    const copy = el("button", { class: "primary", onclick: async () => {
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = "Copied";
      } catch {
        link.select();
      }
    } }, "Copy link");
    body.replaceChildren(
      el("p", { class: "muted" }, "Whoever follows this link plays your squad from the very start of this battle, against the AI. Their results go on the challenge's page."),
      link,
      el("div", { class: "row", style: { marginTop: "12px" } }, copy, el("button", { onclick: () => go(`/c/${id}`) }, "Challenge page"), el("span", { class: "grow" }), el("button", { onclick: close }, "Close")),
    );
    link.select();
  };
  const create = async () => {
    error.textContent = "";
    try {
      const r = await api<{ id: string }>(`/api/matches/${matchId}/challenge`, { body: { title: title.value } });
      showLink(r.id);
    } catch (e) {
      error.textContent = (e as Error).message;
    }
  };

  if (existing) showLink(existing);
  else {
    title.addEventListener("keydown", (e) => e.key === "Enter" && create());
    body.append(
      el("p", { class: "muted" }, "Same map, same soldiers and gear, same enemies, same starting positions. Who can beat it?"),
      el("label", { style: { display: "block", marginBottom: "4px" } }, "Challenge name"),
      title,
      el("div", { class: "row", style: { marginTop: "12px" } }, el("button", { class: "primary", onclick: create }, "Create link"), el("span", { class: "grow" }), el("button", { onclick: close }, "Cancel")),
    );
  }
  root.append(bg);
  if (!existing) title.select();
}
