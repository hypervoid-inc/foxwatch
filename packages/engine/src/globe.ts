export type Vec3 = { x: number; y: number; z: number };

/** Unit sphere: +Z toward the camera at lat 0, lng 0. +Y north. +X east. */
export function latLngToVec(lat: number, lng: number): Vec3 {
  const phi = (lat * Math.PI) / 180;
  const lam = (lng * Math.PI) / 180;
  const c = Math.cos(phi);
  return { x: c * Math.sin(lam), y: Math.sin(phi), z: c * Math.cos(lam) };
}

export function rotateYawPitch(v: Vec3, yaw: number, pitch: number): Vec3 {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = v.x * cy + v.z * sy;
  const z1 = -v.x * sy + v.z * cy;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return { x: x1, y: v.y * cp - z1 * sp, z: v.y * sp + z1 * cp };
}

export function lookAtYawPitch(lat: number, lng: number): { yaw: number; pitch: number } {
  return { yaw: (-lng * Math.PI) / 180, pitch: (lat * Math.PI) / 180 * 0.55 };
}

export function clampPitch(pitch: number): number {
  const max = 0.95;
  return Math.min(max, Math.max(-max, pitch));
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const d = Math.min(1, Math.max(-1, dot(a, b)));
  const omega = Math.acos(d);
  if (omega < 1e-6) return a;
  const s = Math.sin(omega);
  return add(scale(a, Math.sin((1 - t) * omega) / s), scale(b, Math.sin(t * omega) / s));
}

/** Great-circle hop, lifted off the surface so it reads as a trajectory. */
export function trajectoryPoint(a: Vec3, b: Vec3, t: number, lift = 0.16): Vec3 {
  const p = slerp(a, b, t);
  const alt = 1 + lift * Math.sin(Math.PI * t);
  return scale(p, alt);
}

export function sampleTrajectory(a: Vec3, b: Vec3, steps = 24, lift = 0.16): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= steps; i++) out.push(trajectoryPoint(a, b, i / steps, lift));
  return out;
}
