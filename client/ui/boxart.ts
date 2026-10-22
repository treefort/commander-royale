// The front door (sign-in and passkey pages), after the original UFO Defense box: a starfield, a red planet lit
// from the left, the X-COM craft diving across it, and the tall "X-COM" title, reflowed to fill the window. The
// craft and the title are cut from a scan of the cover (/front/*.webp, see tools/front-art); the stars and the
// planet, which is kept dim so the craft stands out, are painted on canvases. The layers drift at different
// rates with the mouse (and a slow idle sway) for a sense of depth; with "reduce motion" they hold still.
import { el } from "../api.ts";

/** A deterministic random sequence, so the sky and the planet look the same on every visit. */
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
  g.fillStyle = "#000";
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

/** The red planet: lit from the left with a bright limb, mottled and cratered, falling to black on the right. */
function paintPlanet(c: HTMLCanvasElement, d: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pad = d * 0.12; // room for the atmosphere glow
  const size = d + pad * 2;
  c.width = Math.round(size * dpr);
  c.height = Math.round(size * dpr);
  c.style.width = c.style.height = `${size}px`;
  const g = c.getContext("2d")!;
  g.scale(dpr, dpr);
  const cx = size / 2, cy = size / 2, R = d / 2;
  // atmosphere glow, strongest on the lit (left) side
  const halo = g.createRadialGradient(cx, cy, R * 0.96, cx, cy, R * 1.2);
  halo.addColorStop(0, "rgba(255,110,40,0.16)");
  halo.addColorStop(1, "rgba(255,80,20,0)");
  g.fillStyle = halo;
  // only the lit side glows
  const side = g.createLinearGradient(cx - R * 1.2, 0, cx + R * 0.3, 0);
  side.addColorStop(0, "#000");
  side.addColorStop(1, "rgba(0,0,0,0)");
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = "destination-in";
  g.fillStyle = side;
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = "source-over";
  g.save();
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.clip();
  const base = g.createRadialGradient(cx - R * 0.62, cy - R * 0.1, R * 0.05, cx - R * 0.2, cy, R * 1.55);
  // muted: the planet sets the scene, the craft is the subject
  base.addColorStop(0, "#b8532a");
  base.addColorStop(0.22, "#963a18");
  base.addColorStop(0.5, "#6a2210");
  base.addColorStop(0.75, "#341007");
  base.addColorStop(1, "#0c0302");
  g.fillStyle = base;
  g.fillRect(cx - R, cy - R, d, d);
  // surface: broad dark and light patches, then craters
  const r = rng(51);
  // soft blotches, squashed and turned (the gradient goes through the same transform, so no hard edges)
  const blotch = (x: number, y: number, s: number, squash: number, turn: number, color: string) => {
    g.save();
    g.translate(x, y);
    g.rotate(turn);
    g.scale(1, squash);
    const p = g.createRadialGradient(0, 0, 0, 0, 0, s);
    p.addColorStop(0, color);
    p.addColorStop(1, color.replace(/[\d.]+\)$/, "0)"));
    g.fillStyle = p;
    g.beginPath();
    g.arc(0, 0, s, 0, Math.PI * 2);
    g.fill();
    g.restore();
  };
  g.globalCompositeOperation = "multiply";
  for (let i = 0; i < 70; i++) {
    blotch(cx + (r() * 2 - 1) * R, cy + (r() * 2 - 1) * R, R * (0.08 + r() * 0.35), 0.5 + r() * 0.6, r() * Math.PI, `rgba(120,30,10,${(0.1 + r() * 0.15).toFixed(3)})`);
  }
  g.globalCompositeOperation = "screen";
  for (let i = 0; i < 45; i++) {
    blotch(cx + (r() * 2 - 1.3) * R, cy + (r() * 2 - 1) * R, R * (0.05 + r() * 0.2), 0.4 + r() * 0.6, r() * Math.PI, `rgba(255,150,80,${(0.03 + r() * 0.06).toFixed(3)})`);
  }
  g.globalCompositeOperation = "source-over";
  for (let i = 0; i < 90; i++) {
    const x = cx + (r() * 2 - 1) * R, y = cy + (r() * 2 - 1) * R, s = R * (0.005 + Math.pow(r(), 4) * 0.03);
    // a crater: dark bowl, brighter rim on the side facing the light
    g.fillStyle = `rgba(60,10,4,${0.08 + r() * 0.12})`;
    g.beginPath();
    g.ellipse(x, y, s, s * 0.8, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = `rgba(255,170,110,${0.03 + r() * 0.05})`;
    g.lineWidth = Math.max(0.6, s * 0.18);
    g.beginPath();
    g.ellipse(x, y, s, s * 0.8, 0, Math.PI * 0.55, Math.PI * 1.45);
    g.stroke();
  }
  // night side: the terminator sweeps across the right of the disc
  const night = g.createLinearGradient(cx - R * 0.75, cy - R * 0.3, cx + R * 0.7, cy + R * 0.3);
  night.addColorStop(0, "rgba(0,0,0,0)");
  night.addColorStop(0.4, "rgba(30,0,0,0.35)");
  night.addColorStop(0.7, "rgba(10,0,0,0.78)");
  night.addColorStop(1, "rgba(0,0,0,0.97)");
  g.fillStyle = night;
  g.fillRect(cx - R, cy - R, d, d);
  g.restore();
  // the bright limb on the lit side
  g.save();
  g.shadowColor = "rgba(255,150,80,0.5)";
  g.shadowBlur = R * 0.04;
  g.strokeStyle = "rgba(255,170,110,0.35)";
  g.lineWidth = Math.max(1.5, R * 0.008);
  g.beginPath();
  g.arc(cx, cy, R - g.lineWidth / 2, Math.PI * 0.62, Math.PI * 1.38);
  g.stroke();
  g.restore();
}

/** Builds the scene with `content` (the sign-in or passkey card) over it. It stops animating once removed. */
export function boxArtScene(content: HTMLElement): HTMLElement {
  const stars = el("canvas", { class: "bx-layer bx-stars" }) as HTMLCanvasElement;
  const planet = el("canvas", { class: "bx-planet" }) as HTMLCanvasElement;
  const planetLayer = el("div", { class: "bx-layer bx-planet-layer" }, planet);
  const ship = el("div", { class: "bx-layer bx-ship-layer" }, el("img", { class: "bx-ship", src: "/front/ship.webp", alt: "", draggable: false }));
  const title = el("div", { class: "bx-title" }, el("h1", { class: "bx-title-text" }, "X-COM: UFO Defense"));
  // the cover's own lettering, with the text as a fallback (and for screen readers)
  const lettering = el("img", { class: "bx-title-art", src: "/front/title.webp", alt: "", draggable: false }) as HTMLImageElement;
  lettering.addEventListener("load", () => title.classList.add("art"));
  title.prepend(lettering);
  const scene = el("div", { class: "boxart" },
    stars, planetLayer, ship,
    el("div", { class: "bx-frame" }),
    title,
    el("div", { class: "bx-ui" }, content));

  // sizes follow the window: the planet fills most of the height (or width, on a tall screen)
  const layout = () => {
    const w = window.innerWidth, h = window.innerHeight;
    paintStars(stars, w + 60, h + 60);
    const portrait = h > w * 1.1;
    const d = portrait ? Math.max(w * 1.25, h * 0.75) : Math.max(h * 1.3, w * 0.72);
    paintPlanet(planet, d);
    const size = parseFloat(planet.style.width);
    planet.style.left = `${(portrait ? w * 0.78 : w * 0.7) - size / 2}px`;
    planet.style.top = `${(portrait ? h * 0.66 : h * 0.55) - size / 2}px`;
  };
  layout();
  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(layout, 150);
  };

  // depth: the farther the layer, the less it moves; the craft also tilts a little
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const target = { x: 0, y: 0 }, cur = { x: 0, y: 0 };
  const onMove = (e: PointerEvent) => {
    target.x = e.clientX / window.innerWidth - 0.5;
    target.y = e.clientY / window.innerHeight - 0.5;
  };
  let raf = 0;
  const t0 = performance.now();
  const frame = (now: number) => {
    if (!scene.isConnected) {
      // the page moved on: stop
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("resize", onResize);
      return;
    }
    raf = requestAnimationFrame(frame);
    if (still) return;
    const t = (now - t0) / 1000;
    cur.x += (target.x - cur.x) * 0.05;
    cur.y += (target.y - cur.y) * 0.05;
    const sway = { x: Math.sin(t * 0.21) * 0.25, y: Math.cos(t * 0.17) * 0.2 };
    const px = cur.x + sway.x, py = cur.y + sway.y;
    stars.style.transform = `translate3d(${-px * 10}px, ${-py * 8}px, 0)`;
    planetLayer.style.transform = `translate3d(${-px * 26}px, ${-py * 18}px, 0)`;
    ship.style.transform = `translate3d(${-px * 70}px, ${-py * 46 + Math.sin(t * 0.6) * 6}px, 0) rotate(${px * 2.5 + Math.sin(t * 0.33) * 0.8}deg)`;
  };
  window.addEventListener("resize", onResize);
  if (!still) window.addEventListener("pointermove", onMove);
  raf = requestAnimationFrame(frame);
  void raf;
  return scene;
}
