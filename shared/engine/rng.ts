// Small deterministic PRNG (xoshiro128**) whose state is serialized with the battle.
export class RNG {
  s: Uint32Array;
  constructor(seed: number | number[]) {
    this.s = new Uint32Array(4);
    if (Array.isArray(seed)) {
      this.s.set(seed);
    } else {
      // splitmix32 to expand the seed
      let x = seed >>> 0;
      for (let i = 0; i < 4; i++) {
        x = (x + 0x9e3779b9) >>> 0;
        let z = x;
        z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
        z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
        this.s[i] = (z ^ (z >>> 16)) >>> 0;
      }
    }
  }
  next(): number {
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return result;
  }
  /** Float in [0,1). */
  float(): number {
    return this.next() / 4294967296;
  }
  /** Inclusive integer range, like OpenXcom's RNG::generate(min,max). */
  int(min: number, max: number): number {
    min = Math.trunc(min);
    max = Math.trunc(max);
    if (max < min) [min, max] = [max, min];
    return min + Math.floor(this.float() * (max - min + 1));
  }
  /** True with the given percent chance. */
  percent(p: number): boolean {
    return this.int(0, 99) < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  state(): number[] {
    return Array.from(this.s);
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}
