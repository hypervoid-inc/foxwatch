import { describe, expect, it } from "vitest";
import { globeRotation, layoutGlobe, mat4Multiply, orthoProjection, project } from "./math.ts";

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
});
