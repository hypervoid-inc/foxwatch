import { HOP_LIFT } from "./scene.ts";

function mix(a: number, b: number, t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return a + (b - a) * u;
}

export function layoutGlobe(w: number, h: number, rem: number) {
  const pad = 24;
  const envelope = 1 + HOP_LIFT;
  w = Math.max(1, w);
  h = Math.max(1, h);
  const t1280 = (w - 1100) / 180;
  const t1440 = (w - 1280) / 160;
  const yBias = mix(0.36, 0.4, t1280);
  const widthFrac = mix(0.4, mix(0.43, 0.46, t1440), t1280);
  let radius = Math.min(h * mix(0.7, 0.78, t1280), rem * mix(32, 38, t1280)) * 0.48;
  const targetCy = h * yBias;
  const maxR = Math.min(
    (w * widthFrac) / envelope,
    Math.max(8, (targetCy - pad) / envelope),
    Math.max(8, (h - pad - targetCy) / envelope),
  );
  if (maxR > 0 && radius > maxR) radius = maxR;
  if (!(radius > 0) || !Number.isFinite(radius)) radius = 80;
  let cy = targetCy;
  const minCy = pad + radius * envelope;
  const maxCy = h - pad - radius * envelope;
  if (minCy <= maxCy) cy = Math.min(maxCy, Math.max(minCy, cy));
  else cy = h / 2;
  let cx = w - pad - radius * envelope;
  if (cx + radius * envelope > w - pad) cx = w - pad - radius * envelope;
  if (cx - radius * envelope < pad) radius = Math.max(8, Math.min(radius, (cx - pad) / envelope));
  return { cx, cy, radius, envelope };
}

export function mat4Multiply(a: ArrayLike<number>, b: ArrayLike<number>, out = new Float32Array(16)): Float32Array {
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        (a[row] ?? 0) * (b[col * 4] ?? 0) +
        (a[row + 4] ?? 0) * (b[col * 4 + 1] ?? 0) +
        (a[row + 8] ?? 0) * (b[col * 4 + 2] ?? 0) +
        (a[row + 12] ?? 0) * (b[col * 4 + 3] ?? 0);
    }
  }
  return out;
}

export function globeRotation(yaw: number, pitch: number, out = new Float32Array(16)): Float32Array {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const ry = new Float32Array([cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1]);
  const rp = new Float32Array([1, 0, 0, 0, 0, cp, sp, 0, 0, -sp, cp, 0, 0, 0, 0, 1]);
  mat4Multiply(rp, ry, out);
  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 1;
  return out;
}

/** Off-center ortho matching CSS pixels: world (0,0) → (cx,cy), +X → right, +Y → up. */
export function orthoProjection(cx: number, cy: number, radius: number, w: number, h: number): Float32Array {
  const r = Math.max(1, radius);
  const left = -cx / r;
  const right = (w - cx) / r;
  const bottom = (cy - h) / r;
  const top = cy / r;
  return new Float32Array([
    2 / (right - left), 0, 0, 0,
    0, 2 / (top - bottom), 0, 0,
    0, 0, 1 / (0.1 - 20), 0,
    (right + left) / (left - right), (top + bottom) / (bottom - top), 0.1 / (0.1 - 20), 1,
  ]);
}

export function project(v: { x: number; y: number; z: number }, mvp: Float32Array, w: number, h: number) {
  const x = mvp[0]! * v.x + mvp[4]! * v.y + mvp[8]! * v.z + mvp[12]!;
  const y = mvp[1]! * v.x + mvp[5]! * v.y + mvp[9]! * v.z + mvp[13]!;
  const z = mvp[2]! * v.x + mvp[6]! * v.y + mvp[10]! * v.z + mvp[14]!;
  const clipW = mvp[3]! * v.x + mvp[7]! * v.y + mvp[11]! * v.z + mvp[15]!;
  const ndcX = x / clipW;
  const ndcY = y / clipW;
  return {
    x: (ndcX * 0.5 + 0.5) * w,
    y: (1 - (ndcY * 0.5 + 0.5)) * h,
    z: z / clipW,
    visible: clipW > 0,
  };
}
