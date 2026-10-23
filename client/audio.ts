// Original battlescape sound effects (SAMPLE2.CAT: a catalog of WAV files).
import { getFile, hasFile } from "./files.ts";

let ctx: AudioContext | null = null;
const buffers: (AudioBuffer | null)[] = [];
let loading: Promise<void> | null = null;
export const audioSettings = { volume: 0.6, muted: false, music: true, musicVolume: 0.5 };

try {
  const s = JSON.parse(localStorage.getItem("xcom.audio") ?? "null");
  if (s) Object.assign(audioSettings, s);
} catch {
  /* private mode */
}

export function saveAudioSettings() {
  try {
    localStorage.setItem("xcom.audio", JSON.stringify(audioSettings));
  } catch {
    /* ignore */
  }
}

export function initAudio(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    if (!hasFile("SOUND/SAMPLE2.CAT")) return;
    ctx = new AudioContext();
    const cat = getFile("SOUND/SAMPLE2.CAT");
    const dv = new DataView(cat.buffer, cat.byteOffset, cat.byteLength);
    const n = dv.getUint32(0, true) / 8;
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < n; i++) {
      const off = dv.getUint32(i * 8, true), size = dv.getUint32(i * 8 + 4, true);
      const ns = cat[off];
      const start = ns <= 56 ? off + 1 + ns : off;
      const wav = cat.slice(start, start + size);
      buffers[i] = null;
      jobs.push(ctx.decodeAudioData(wav.buffer).then((buf) => { buffers[i] = buf; }, () => {}));
    }
    await Promise.all(jobs);
  })();
  return loading;
}

/** Resume audio after a user gesture (browser autoplay rules). */
export function unlockAudio() {
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
}

export function playSound(index: number, pan = 0) {
  if (!ctx || audioSettings.muted || index < 0) return;
  const buf = buffers[index];
  if (!buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const gain = ctx.createGain();
  gain.gain.value = audioSettings.volume;
  const panner = ctx.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  src.connect(gain).connect(panner).connect(ctx.destination);
  src.start();
}

// ------------------------------------------------------------------------------------------
// music: the original General MIDI battle tracks, pre-rendered by tools/render-music.ts
// ------------------------------------------------------------------------------------------

let musicGain: GainNode | null = null;
/** fades the music out while the page isn't in front (another tab or window), and back in after */
let focusGain: GainNode | null = null;
let musicSrc: AudioBufferSourceNode | null = null;
let musicTrack = "";
const musicCache = new Map<string, Promise<AudioBuffer | null>>();

function musicLevel() {
  return audioSettings.music ? audioSettings.musicVolume * 0.6 : 0;
}

/** Plays a track (looping unless `loop` is false); asking for the one already playing does nothing. */
export async function playMusic(name: string, loop = true) {
  if (musicTrack === name) return;
  musicTrack = name;
  stopCurrentMusic();
  if (!ctx) return;
  let job = musicCache.get(name);
  if (!job) {
    job = fetch(`/game/MUSIC/${name}.ogg`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((buf) => (buf && ctx ? ctx.decodeAudioData(buf) : null))
      .catch(() => null);
    musicCache.set(name, job);
  }
  const buf = await job;
  if (!buf || !ctx || musicTrack !== name) return;
  if (!musicGain) {
    musicGain = ctx.createGain();
    musicGain.connect(musicOut(ctx));
  }
  musicGain.gain.cancelScheduledValues(ctx.currentTime);
  musicGain.gain.setValueAtTime(0, ctx.currentTime);
  musicGain.gain.linearRampToValueAtTime(musicLevel(), ctx.currentTime + 1.5);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = loop;
  src.connect(musicGain);
  src.start();
  musicSrc = src;
}

function stopCurrentMusic() {
  const src = musicSrc;
  musicSrc = null;
  if (!src || !ctx || !musicGain) return;
  // a short fade so tracks don't cut off mid-note
  const g = ctx.createGain();
  g.gain.setValueAtTime(musicLevel(), ctx.currentTime);
  g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.8);
  src.disconnect();
  src.connect(g).connect(musicOut(ctx));
  src.stop(ctx.currentTime + 0.85);
}

function pageInFront(): boolean {
  return !document.hidden && document.hasFocus();
}

function musicOut(c: AudioContext): GainNode {
  if (!focusGain) {
    focusGain = c.createGain();
    focusGain.gain.value = pageInFront() ? 1 : 0;
    focusGain.connect(c.destination);
  }
  return focusGain;
}

/** Fades the music down when the tab or window loses focus, and back up when it's in front again. */
function onFocusChange() {
  if (!ctx || !focusGain) return;
  const up = pageInFront();
  const g = focusGain.gain;
  g.cancelScheduledValues(ctx.currentTime);
  g.setValueAtTime(g.value, ctx.currentTime);
  g.linearRampToValueAtTime(up ? 1 : 0, ctx.currentTime + (up ? 1 : 1.5));
}
for (const ev of ["focus", "blur"]) window.addEventListener(ev, onFocusChange);
document.addEventListener("visibilitychange", onFocusChange);

export function stopMusic() {
  musicTrack = "";
  stopCurrentMusic();
}

/** Applies a changed music on/off or volume setting to what's playing. */
export function applyMusicSettings() {
  if (ctx && musicGain) musicGain.gain.setTargetAtTime(musicLevel(), ctx.currentTime, 0.1);
}

/** A soft two-note chime (synthesized: every original sample is a gunshot, door or scream). */
export function playTurnChime() {
  if (!ctx || audioSettings.muted) return;
  const t0 = ctx.currentTime + 0.02;
  const out = ctx.createGain();
  out.gain.value = audioSettings.volume * 0.18;
  out.connect(ctx.destination);
  [[660, 0], [990, 0.13]].forEach(([freq, delay]) => {
    const osc = ctx!.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const env = ctx!.createGain();
    const start = t0 + delay;
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(1, start + 0.015);
    env.gain.exponentialRampToValueAtTime(0.001, start + 0.45);
    osc.connect(env).connect(out);
    osc.start(start);
    osc.stop(start + 0.5);
  });
}

export const SND = { DOOR: 3, UFO_DOOR: 20, UFO_DOOR_CLOSE: 21, SMALL_EXPLOSION: 2, LARGE_EXPLOSION: 5, ITEM_DROP: 38, ITEM_THROW: 39, RELOAD: 17, WALK: 22, FLY: 15 };
