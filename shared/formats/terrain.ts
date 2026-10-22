// MCD (terrain object definitions), MAP (map blocks) and LOFTEMPS (voxel templates).

export const enum TilePart { FLOOR = 0, WESTWALL = 1, NORTHWALL = 2, OBJECT = 3 }

export interface MapData {
  set: number; // dataset index within the battle's terrain list
  local: number; // index within its dataset
  sprites: number[]; // 8 animation frames (indices into the dataset PCK)
  loft: number[]; // 12 voxel layers (2 voxels high each)
  scanG: number;
  ufoDoor: boolean;
  stopLOS: boolean;
  noFloor: boolean;
  bigWall: number;
  gravLift: boolean;
  door: boolean;
  blockFire: boolean;
  blockSmoke: boolean;
  tuWalk: number;
  tuSlide: number;
  tuFly: number;
  armor: number;
  heBlock: number;
  dieMCD: number; // global id or 0
  flammable: number;
  altMCD: number; // global id or 0
  terrainLevel: number;
  yOffset: number;
  lightBlock: number;
  footstep: number;
  objectType: TilePart;
  heType: number;
  heStrength: number;
  smokeBlockage: number;
  fuel: number;
  lightSource: number;
  specialType: number;
  baseModule: boolean;
}

export const MCD_RECORD = 62;

/** Parses one MCD file. die/alt references are left local; callers convert them to global ids. */
export function parseMcd(buf: Uint8Array, set: number): MapData[] {
  const out: MapData[] = [];
  for (let o = 0; o + MCD_RECORD <= buf.length; o += MCD_RECORD) {
    const b = (i: number) => buf[o + i];
    const sb = (i: number) => (buf[o + i] << 24) >> 24;
    out.push({
      set,
      local: out.length,
      sprites: Array.from({ length: 8 }, (_, i) => b(i)),
      loft: Array.from({ length: 12 }, (_, i) => b(8 + i)),
      scanG: b(20) | (b(21) << 8),
      ufoDoor: b(30) !== 0,
      stopLOS: b(31) !== 0,
      noFloor: b(32) !== 0,
      bigWall: b(33),
      gravLift: b(34) !== 0,
      door: b(35) !== 0,
      blockFire: b(36) !== 0,
      blockSmoke: b(37) !== 0,
      tuWalk: b(39),
      tuSlide: b(40),
      tuFly: b(41),
      armor: b(42),
      heBlock: b(43),
      dieMCD: b(44),
      flammable: b(45),
      altMCD: b(46),
      terrainLevel: sb(48),
      yOffset: b(49),
      lightBlock: b(51),
      footstep: b(52),
      objectType: b(53) as TilePart,
      heType: b(54),
      heStrength: b(55),
      smokeBlockage: b(56),
      fuel: b(57),
      lightSource: b(58),
      specialType: b(59),
      baseModule: b(60) !== 0,
    });
  }
  return out;
}

/** LOFTEMPS.DAT: each template is 16 rows of 16-bit masks. */
export function parseLoftemps(buf: Uint8Array): Uint16Array {
  const out = new Uint16Array(Math.floor(buf.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = buf[i * 2] | (buf[i * 2 + 1] << 8);
  return out;
}

export interface MapBlockData {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  /** [z][y][x][part] raw values (0 = empty, otherwise 1-based into the concatenated terrain list) — z=0 is the bottom. */
  parts: Uint8Array;
}

/** MAP: header (rows, cols, levels) then 4 bytes per tile, top level first. */
export function parseMap(buf: Uint8Array): MapBlockData {
  const sizeY = buf[0], sizeX = buf[1], sizeZ = buf[2];
  const parts = new Uint8Array(sizeX * sizeY * sizeZ * 4);
  let p = 3;
  for (let z = sizeZ - 1; z >= 0; z--) {
    for (let y = 0; y < sizeY; y++) {
      for (let x = 0; x < sizeX; x++) {
        const dst = (((z * sizeY + y) * sizeX + x) * 4);
        for (let k = 0; k < 4; k++) parts[dst + k] = p < buf.length ? buf[p++] : 0;
      }
    }
  }
  return { sizeX, sizeY, sizeZ, parts };
}
