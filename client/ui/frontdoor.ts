// The front door (sign-in and gate pages): the Commander Royale logo and the card under it, centered on a
// starfield. The stars drift a little with the mouse (and a slow idle sway); with "reduce motion" they hold still.
import { el } from "../api.ts";

/** A deterministic random sequence, so the sky looks the same on every visit. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function paintStars(c: HTMLCanvasElement, w: number, h: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const g = c.getContext("2d")!;
  g.scale(dpr, dpr);
  // deep space, a shade lighter around the middle where the logo sits
  const bg = g.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h * 0.42, Math.max(w, h) * 0.7);
  bg.addColorStop(0, "#0b0f1c");
  bg.addColorStop(1, "#000");
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  const r = rng(1993);
  const n = Math.round((w * h) / 2200);
  for (let i = 0; i < n; i++) {
    const x = r() * w, y = r() * h;
    const b = r();
    const size = b > 0.985 ? 1.6 : b > 0.9 ? 1.1 : 0.7;
    const a = 0.25 + r() * 0.65;
    // a few faintly warm or cold stars among the white
    const tint = r();
    g.fillStyle = tint > 0.9 ? `rgba(255,214,170,${a})` : tint > 0.8 ? `rgba(190,210,255,${a})` : `rgba(255,255,255,${a})`;
    g.beginPath();
    g.arc(x, y, size, 0, Math.PI * 2);
    g.fill();
    if (b > 0.993) {
      // the odd bright one gets a soft glow and glints
      const glow = g.createRadialGradient(x, y, 0, x, y, 7);
      glow.addColorStop(0, "rgba(255,255,255,0.45)");
      glow.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = glow;
      g.fillRect(x - 7, y - 7, 14, 14);
      g.fillStyle = "rgba(255,255,255,0.35)";
      g.fillRect(x - 6, y - 0.4, 12, 0.8);
      g.fillRect(x - 0.4, y - 6, 0.8, 12);
    }
  }
}

/** Builds the page with `content` (the sign-in card, or what the server asks for before playing) under the logo. */
export function frontDoor(content: HTMLElement): HTMLElement {
  const stars = el("canvas", { class: "fd-stars" }) as HTMLCanvasElement;
  const title = el("h1", { class: "fd-title" }, "Commander Royale");
  // the logo, with the text as a fallback (and for screen readers)
  const logo = el("img", { class: "fd-logo", src: "/logo.webp", alt: "", draggable: false }) as HTMLImageElement;
  logo.addEventListener("load", () => title.classList.add("art"));
  title.prepend(logo);
  const scene = el("div", { class: "frontdoor" }, stars, el("div", { class: "fd-center" }, title, content));

  const layout = () => paintStars(stars, window.innerWidth + 40, window.innerHeight + 40);
  layout();
  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(layout, 150);
  };

  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const target = { x: 0, y: 0 }, cur = { x: 0, y: 0 };
  const onMove = (e: PointerEvent) => {
    target.x = e.clientX / window.innerWidth - 0.5;
    target.y = e.clientY / window.innerHeight - 0.5;
  };
  const t0 = performance.now();
  const frame = (now: number) => {
    if (!scene.isConnected) {
      // the page moved on: stop
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("resize", onResize);
      return;
    }
    requestAnimationFrame(frame);
    if (still) return;
    const t = (now - t0) / 1000;
    cur.x += (target.x - cur.x) * 0.05;
    cur.y += (target.y - cur.y) * 0.05;
    const px = cur.x + Math.sin(t * 0.21) * 0.25, py = cur.y + Math.cos(t * 0.17) * 0.2;
    stars.style.transform = `translate3d(${-px * 14}px, ${-py * 10}px, 0)`;
  };
  window.addEventListener("resize", onResize);
  if (!still) window.addEventListener("pointermove", onMove);
  requestAnimationFrame(frame);
  return scene;
}
