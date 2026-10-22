// Renders the original General MIDI battle music (SOUND/GM*.MID) to Ogg Opus in gamedata/MUSIC, so
// browsers can stream it like any other game file. Run once after copying the game data:
//
//   bun tools/render-music.ts
//
// Synthesis is spessasynth_core with the GeneralUser GS soundfont (downloaded to tools/.cache on first
// run; its licence allows this use). Encoding needs ffmpeg on the PATH.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SpessaSynthProcessor, SpessaSynthSequencer, SoundBankLoader, BasicMIDI, audioToWav } from "spessasynth_core";

const ROOT = join(import.meta.dir, "..");
const GAME = process.env.GAME_DIR ?? join(ROOT, "gamedata");
const CACHE = join(import.meta.dir, ".cache");
const SF2 = join(CACHE, "GeneralUser-GS.sf2");
const SF2_URL = "https://github.com/mrbumpy409/GeneralUser-GS/raw/main/GeneralUser-GS.sf2";
/** battle tracks (OpenXcom's choices): tactical, alien base, Mars, and the end-of-battle stings */
const TRACKS = ["GMTACTIC", "GMENBASE", "GMMARS", "GMWIN", "GMLOSE"];
const RATE = 48000;

if (!existsSync(SF2)) {
  mkdirSync(CACHE, { recursive: true });
  console.log("downloading soundfont...");
  const r = await fetch(SF2_URL);
  if (!r.ok) throw new Error(`soundfont download failed: ${r.status}`);
  writeFileSync(SF2, new Uint8Array(await r.arrayBuffer()));
}
const sf = readFileSync(SF2);
const bank = SoundBankLoader.fromArrayBuffer(sf.buffer.slice(sf.byteOffset, sf.byteOffset + sf.byteLength));
const outDir = join(GAME, "MUSIC");
mkdirSync(outDir, { recursive: true });

for (const name of TRACKS) {
  const src = join(GAME, "SOUND", `${name}.MID`);
  if (!existsSync(src)) {
    console.log(`skip ${name} (no ${src})`);
    continue;
  }
  const t0 = performance.now();
  const synth = new SpessaSynthProcessor(RATE);
  await synth.processorInitialized;
  synth.soundBankManager.addSoundBank(bank, "main");
  const seq = new SpessaSynthSequencer(synth);
  const mid = readFileSync(src);
  seq.loadNewSongList([BasicMIDI.fromArrayBuffer(mid.buffer.slice(mid.byteOffset, mid.byteOffset + mid.byteLength), name)]);
  seq.loopCount = 0;
  seq.play();
  // the whole piece plus a couple of seconds for notes and reverb to ring out
  const total = Math.ceil((seq.duration + 2.5) * RATE);
  const left = new Float32Array(total), right = new Float32Array(total);
  const BLOCK = 128;
  for (let i = 0; i < total; i += BLOCK) {
    seq.processTick();
    synth.process(left, right, i, Math.min(BLOCK, total - i));
  }
  // a little headroom: the loudest chords otherwise hit full scale and clip
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  const gain = peak > 0.7 ? 0.7 / peak : 1;
  for (let i = 0; i < total; i++) {
    left[i] *= gain;
    right[i] *= gain;
  }
  const wav = join(outDir, `${name}.wav`);
  writeFileSync(wav, new Uint8Array(audioToWav([left, right], RATE, { normalizeAudio: false })));
  const ogg = join(outDir, `${name}.ogg`);
  const enc = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-c:a", "libopus", "-b:a", "96k", ogg]);
  if (enc.status !== 0) throw new Error(`ffmpeg failed for ${name}: ${enc.stderr}`);
  rmSync(wav);
  console.log(`${name}: ${seq.duration.toFixed(0)}s rendered in ${((performance.now() - t0) / 1000).toFixed(1)}s -> MUSIC/${name}.ogg`);
}
