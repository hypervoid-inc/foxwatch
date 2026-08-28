import { latLngToVec, sampleTrajectory, type Vec3 } from "@foxwatch/engine";
import type { Gpu, Texture } from "vgpu";

export type NodeKind = "ok" | "warn" | "bad" | "empty";

export type GlobeNode = {
  id: string;
  lat: number;
  lng: number;
  kind: NodeKind;
  v: Vec3;
  label: string;
  read: string;
};

export type GlobeArc = { a: GlobeNode; b: GlobeNode };

export type YouHere = {
  lat: number;
  lng: number;
  v: Vec3;
  city: string;
};

export type GlobeScene = {
  nodes: GlobeNode[];
  arcs: GlobeArc[];
  you: YouHere | null;
  youTo: GlobeNode | null;
};

export type ThemeColors = {
  bg: [number, number, number];
  card: [number, number, number];
  hover: [number, number, number];
  line: [number, number, number];
  empty: [number, number, number];
  ink: [number, number, number];
  ok: [number, number, number];
  warn: [number, number, number];
  bad: [number, number, number];
  muted: [number, number, number];
};

const LAND_W = 2048;
const LAND_H = 1024;

export function parseColor(s: string): [number, number, number] {
  const raw = (s || "").trim();
  if (raw.charAt(0) === "#") {
    let h = raw.slice(1);
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    if (h.length >= 6) {
      return [
        parseInt(h.slice(0, 2), 16) / 255,
        parseInt(h.slice(2, 4), 16) / 255,
        parseInt(h.slice(4, 6), 16) / 255,
      ];
    }
  }
  const m = raw.match(/rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  return [80 / 255, 78 / 255, 74 / 255];
}

const LIGHT: ThemeColors = {
  bg: parseColor("#efece6"),
  card: parseColor("#f7f4ee"),
  hover: parseColor("#e8e4dc"),
  line: parseColor("#ddd8ce"),
  empty: parseColor("#e4dfd6"),
  ink: parseColor("#3a3732"),
  ok: parseColor("#2f8f73"),
  warn: parseColor("#c4841d"),
  bad: parseColor("#c75c6e"),
  muted: parseColor("#6d6860"),
};

const DARK: ThemeColors = {
  bg: parseColor("#2c2b28"),
  card: parseColor("#363530"),
  hover: parseColor("#3f3e39"),
  line: parseColor("#4a4842"),
  empty: parseColor("#4a4842"),
  ink: parseColor("#e4e0d8"),
  ok: parseColor("#5eb89a"),
  warn: parseColor("#d4a04a"),
  bad: parseColor("#e07a8a"),
  muted: parseColor("#a8a39a"),
};

export function isDarkTheme(): boolean {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "dark") return true;
  if (t === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function readTheme(): ThemeColors {
  return isDarkTheme() ? DARK : LIGHT;
}

export function kindColor(kind: NodeKind, theme: ThemeColors): [number, number, number] {
  if (kind === "bad") return theme.bad;
  if (kind === "warn") return theme.warn;
  if (kind === "empty") return theme.muted;
  return theme.ok;
}

export function arcTint(a: GlobeNode, b: GlobeNode, theme: ThemeColors): [number, number, number] {
  if (a.kind === "bad" || b.kind === "bad") return theme.bad;
  if (a.kind === "warn" || b.kind === "warn") return theme.warn;
  return theme.ok;
}

export function readLand(): number[][][] {
  const el = document.getElementById("globe-land");
  if (!el?.textContent) return [];
  try {
    const parsed = JSON.parse(el.textContent) as unknown;
    return Array.isArray(parsed) ? parsed as number[][][] : [];
  } catch {
    return [];
  }
}

function nodeKind(el: Element): NodeKind {
  if (el.classList.contains("bad")) return "bad";
  if (el.classList.contains("warn")) return "warn";
  if (el.classList.contains("empty")) return "empty";
  return "ok";
}

export function readScene(): GlobeScene | null {
  const nodes: GlobeNode[] = [];
  const root = document.getElementById("live-mesh");
  if (!root || root.hasAttribute("hidden")) return null;
  for (const n of root.querySelectorAll(".mesh-node")) {
    const lat = Number(n.getAttribute("data-lat"));
    const lng = Number(n.getAttribute("data-lng"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    nodes.push({
      id: n.getAttribute("data-region") ?? "",
      lat,
      lng,
      kind: nodeKind(n),
      v: latLngToVec(lat, lng),
      label: n.getAttribute("data-label") ?? "",
      read: n.getAttribute("data-read") ?? "",
    });
  }
  const arcs: GlobeArc[] = [];
  for (const path of root.querySelectorAll(".mesh-arc")) {
    const a = path.getAttribute("data-a");
    const b = path.getAttribute("data-b");
    const na = nodes.find((n) => n.id === a);
    const nb = nodes.find((n) => n.id === b);
    if (na && nb) arcs.push({ a: na, b: nb });
  }
  const here = window.__fwHere;
  const you =
    here && here.lat != null && here.lng != null
      ? { lat: here.lat, lng: here.lng, v: latLngToVec(here.lat, here.lng), city: here.city || here.colo || "" }
      : null;
  let youTo: GlobeNode | null = null;
  if (you) {
    let bestD = 1e9;
    for (const n of nodes) {
      const dd = 1 - (you.v.x * n.v.x + you.v.y * n.v.y + you.v.z * n.v.z);
      if (dd < bestD) {
        bestD = dd;
        youTo = n;
      }
    }
  }
  if (!nodes.length) return null;
  return { nodes, arcs, you, youTo };
}

export function bakeLand(gpu: Gpu, rings: number[][][]): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = LAND_W;
  canvas.height = LAND_H;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, LAND_W, LAND_H);
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#fff";
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.15;
    for (const ring of rings) {
      if (ring.length < 3) continue;
      ctx.beginPath();
      ring.forEach((pt, i) => {
        const lng = pt?.[0] ?? 0;
        const lat = pt?.[1] ?? 0;
        const x = ((lng + 180) / 360) * LAND_W;
        const y = ((90 - lat) / 180) * LAND_H;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  const pixels = ctx?.getImageData(0, 0, LAND_W, LAND_H).data ?? new Uint8ClampedArray(LAND_W * LAND_H * 4);
  const tex = gpu.device.createTexture({
    size: [LAND_W, LAND_H],
    format: "rgba8unorm",
    usage: ["texture_binding", "copy_dst"],
    label: "foxwatch-land",
  });
  gpu.gpu.queue.writeTexture(
    { texture: tex.gpu },
    pixels,
    { bytesPerRow: LAND_W * 4, rowsPerImage: LAND_H },
    { width: LAND_W, height: LAND_H },
  );
  return tex;
}

export const HOP_LIFT = 0.16;
export const HOP_STEPS = 40;

export function hopSamples(a: Vec3, b: Vec3): Vec3[] {
  return sampleTrajectory(a, b, HOP_STEPS, HOP_LIFT);
}

declare global {
  interface Window {
    __fwGlobe?: { refresh: () => void; paint: () => void };
    __fwGpuGlobe?: boolean;
    __fwGpuDispose?: () => void;
    __fwRevealGlobe?: () => void;
    __fwHere?: { lat: number; lng: number; city?: string; colo?: string };
    __fwPickRegion?: (id: string | null) => void;
  }
}
