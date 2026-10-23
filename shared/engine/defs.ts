export const enum VoxelType { EMPTY = -1, FLOOR = 0, WESTWALL = 1, NORTHWALL = 2, OBJECT = 3, UNIT = 4, OUTOFBOUNDS = 5 }

export const enum BigWall {
  NONE = 0, BLOCK = 1, NESW = 2, NWSE = 3, WEST = 4, NORTH = 5, EAST = 6, SOUTH = 7, EAST_AND_SOUTH = 8, WEST_AND_NORTH = 9,
}

export const DIR_UP = 8;
export const DIR_DOWN = 9;
export const MAX_VIEW_DISTANCE = 20;
export const MAX_VIEW_DISTANCE_SQR = MAX_VIEW_DISTANCE * MAX_VIEW_DISTANCE;
export const MAX_VOXEL_VIEW_DISTANCE = MAX_VIEW_DISTANCE * 16;
export const MAX_DARKNESS_TO_SEE_UNITS = 9;

export const enum UnitStatus { STANDING = 0, WALKING = 1, FLYING = 2, TURNING = 3, AIMING = 4, COLLAPSING = 5, DEAD = 6, UNCONSCIOUS = 7, IGNORE_ME = 8 }

export const enum Side { FRONT = 0, LEFT = 1, RIGHT = 2, REAR = 3, UNDER = 4 }
export const enum BodyPart { HEAD = 0, TORSO = 1, RIGHTARM = 2, LEFTARM = 3, RIGHTLEG = 4, LEFTLEG = 5 }

export type ActionType = "none" | "snap" | "aimed" | "auto" | "throw" | "prime" | "hit" | "launch" | "use" | "mindcontrol" | "panic";

export const DX = [0, 1, 1, 1, 0, -1, -1, -1, 0, 0];
export const DY = [-1, -1, 0, 1, 1, 1, 0, -1, 0, 0];
export const DZ = [0, 0, 0, 0, 0, 0, 0, 0, 1, -1];

export interface Pos { x: number; y: number; z: number }
export const pos = (x: number, y: number, z: number): Pos => ({ x, y, z });
export const posEq = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y && a.z === b.z;
export const posAdd = (a: Pos, b: Pos): Pos => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

export function vectorToDirection(dx: number, dy: number): number {
  for (let i = 0; i < 8; i++) if (DX[i] === dx && DY[i] === dy) return i;
  return -1;
}

/** Direction from a to b in X-COM's 8-way convention (0 = north / -y, clockwise). */
export function directionTo(from: Pos, to: Pos): number {
  const ox = to.x - from.x;
  const oy = to.y - from.y;
  const angle = Math.atan2(ox, -oy);
  const q = Math.PI / 4;
  const pie = [q * 4 - q / 2, q * 3 - q / 2, q * 2 - q / 2, q - q / 2];
  if (angle > pie[0] || angle < -pie[0]) return 4;
  if (angle > pie[1]) return 3;
  if (angle > pie[2]) return 2;
  if (angle > pie[3]) return 1;
  if (angle < -pie[1]) return 5;
  if (angle < -pie[2]) return 6;
  if (angle < -pie[3]) return 7;
  return 0;
}

export function tileDistance(a: Pos, b: Pos): number {
  const x = a.x - b.x, y = a.y - b.y;
  return Math.ceil(Math.sqrt(x * x + y * y));
}
export function distanceSq(a: Pos, b: Pos, considerZ = true): number {
  const x = a.x - b.x, y = a.y - b.y, z = considerZ ? a.z - b.z : 0;
  return x * x + y * y + z * z;
}

/** The Mysterious Stranger's unit id in events: he's never in the battle's unit list (clients draw him briefly). */
export const STRANGER_ID = 999_999;
