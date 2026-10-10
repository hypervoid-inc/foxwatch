import { describe, expect, it } from "vitest";
import { REGIONS } from "@foxwatch/config";
import { meshArcs } from "@foxwatch/engine";
import { HOP_STEPS, hopSamples, MAX_HOPS, MAX_PROBES } from "./scene.ts";
import { globeBox, globeRotation, layoutGlobe, mat4Multiply, orthoProjection, project } from "./math.ts";

describe("globe projection", () => {
  it("maps the sphere origin and +X to the gutter layout", () => {
    const { cx, cy, radius } = layoutGlobe(1440, 900, 16);
    expect(radius).toBeGreaterThan(80);
    expect(cx).toBeGreaterThan(900);
    const mvp = orthoProjection(cx, cy, radius, 1440, 900);
    const origin = project({ x: 0, y: 0, z: 0 }, mvp, 1440, 900);
    const east = project({ x: 1, y: 0, z: 0 }, mvp, 1440, 900);
    const north = project({ x: 0, y: 1, z: 0 }, mvp, 1440, 900);
    expect(origin.x).toBeCloseTo(cx, 4);
    expect(origin.y).toBeCloseTo(cy, 4);
    expect(east.x).toBeCloseTo(cx + radius, 4);
    expect(east.y).toBeCloseTo(cy, 4);
    expect(north.x).toBeCloseTo(cx, 4);
    expect(north.y).toBeCloseTo(cy - radius, 4);
  });

  it("sits in the upper-right gutter and stays on-screen when narrow", () => {
    const wide = layoutGlobe(1440, 900, 16);
    expect(wide.cy).toBeLessThan(900 / 2);
    expect(wide.cx).toBeGreaterThan(900);
    expect(wide.cy - wide.radius * wide.envelope).toBeGreaterThanOrEqual(20);
    expect(wide.cx + wide.radius * wide.envelope).toBeLessThanOrEqual(1440 - 20);

    const compact = layoutGlobe(1100, 800, 16);
    expect(compact.cy).toBeLessThan(800 / 2);
    expect(compact.cy - compact.radius * compact.envelope).toBeGreaterThanOrEqual(20);
    expect(compact.cx + compact.radius * compact.envelope).toBeLessThanOrEqual(1100 - 20);
    expect(compact.radius).toBeLessThan(wide.radius);
  });

  it("moves the globe gutter continuously as the viewport narrows", () => {
    const a = layoutGlobe(1280, 800, 16);
    const b = layoutGlobe(1279, 800, 16);
    expect(Math.abs(a.radius - b.radius)).toBeLessThan(2);
    expect(Math.abs(a.cx - a.radius - (b.cx - b.radius))).toBeLessThan(4);
    const wideLeft = layoutGlobe(1600, 900, 16);
    const midLeft = layoutGlobe(1400, 900, 16);
    expect(midLeft.cx - midLeft.radius).toBeLessThan(wideLeft.cx - wideLeft.radius);
  });

  it("matches the public gutter boot (cx - radius)", () => {
    const { cx, radius } = layoutGlobe(1440, 900, 16);
    expect(Math.round(cx - radius)).toBe(790);
  });

  it("keeps labels on the globe after yaw (model applied once)", () => {
    const { cx, cy, radius } = layoutGlobe(1440, 900, 16);
    const vp = orthoProjection(cx, cy, radius, 1440, 900);
    const model = globeRotation(0.4, 0.2);
    const mvp = mat4Multiply(vp, model);
    const p = project({ x: 0, y: 0, z: 1 }, mvp, 1440, 900);
    const d = Math.hypot(p.x - cx, p.y - cy);
    expect(d).toBeLessThan(radius + 1);
    expect(d).toBeGreaterThan(8);
  });

  it("fits the canvas to the globe instead of the viewport", () => {
    for (const [w, h, rem] of [[1100, 700, 16], [1440, 900, 16], [2560, 1440, 16], [3840, 2160, 16], [1100, 420, 16], [1600, 600, 18]] as const) {
      const layout = layoutGlobe(w, h, rem);
      const box = globeBox(layout, w, h);
      for (const n of [box.x, box.y, box.w, box.h]) expect(Number.isInteger(n)).toBe(true);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(w);
      expect(box.y + box.h).toBeLessThanOrEqual(h);
      // Hops rise to the envelope and a hovered marker is 6.4px across the rim: both stay inside.
      const reach = Math.max(layout.radius * layout.envelope + 1.1, layout.radius * 1.02 + 6.4);
      expect(box.x).toBeLessThanOrEqual(layout.cx - reach);
      expect(box.y).toBeLessThanOrEqual(layout.cy - reach);
      expect(box.x + box.w).toBeGreaterThanOrEqual(layout.cx + reach);
      expect(box.y + box.h).toBeGreaterThanOrEqual(layout.cy + reach);
    }
    const wide = globeBox(layoutGlobe(3840, 2160, 16), 3840, 2160);
    expect(wide.w * wide.h).toBeLessThan((3840 * 2160) / 10);
  });

  it("draws the globe at the same viewport pixels through the smaller canvas", () => {
    const layout = layoutGlobe(1440, 900, 16);
    const { cx, cy, radius } = layout;
    const box = globeBox(layout, 1440, 900);
    const model = globeRotation(0.4, 0.2);
    const full = mat4Multiply(orthoProjection(cx, cy, radius, 1440, 900), model);
    const boxed = mat4Multiply(orthoProjection(cx - box.x, cy - box.y, radius, box.w, box.h), model);
    for (const v of [{ x: 0, y: 0, z: 1 }, { x: 0.6, y: -0.3, z: 0.74 }, { x: -1.16, y: 0, z: 0 }]) {
      const a = project(v, full, 1440, 900);
      const b = project(v, boxed, box.w, box.h);
      expect(b.x + box.x).toBeCloseTo(a.x, 2);
      expect(b.y + box.y).toBeCloseTo(a.y, 2);
    }
  });
});

describe("globe instance buffers", () => {
  it("hold every region's marker and the visitor's", () => {
    expect(REGIONS.length + 1).toBeLessThanOrEqual(MAX_PROBES);
  });

  it("hold every hop of a full mesh and the visitor's, whole", () => {
    const segments = hopSamples({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }).length - 1;
    expect(segments).toBe(HOP_STEPS);
    const arcs = meshArcs([...REGIONS]).length;
    expect(arcs).toBeGreaterThan(REGIONS.length);
    expect((arcs + 1) * segments).toBeLessThanOrEqual(MAX_HOPS);
    // Whatever regions are added later, a mesh has at most two arcs a region.
    expect(((MAX_PROBES - 1) * 2 + 1) * segments).toBeLessThanOrEqual(MAX_HOPS);
  });
});
