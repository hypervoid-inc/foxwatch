import { describe, expect, it } from "vitest";
import {
  aimOrbit,
  aimScene,
  createOrbit,
  IDLE_MS,
  orbitActive,
  spinOnly,
  SPIN,
  SPIN_IN_MS,
  SPIN_OUT_MS,
  spinEase,
  stepOrbit,
} from "./orbit.ts";

describe("idle spin", () => {
  it("waits 1s before starting", () => {
    expect(IDLE_MS).toBe(1000);
  });

  it("smoothsteps gain so start and stop have zero slope", () => {
    expect(spinEase(0)).toBe(0);
    expect(spinEase(1)).toBe(1);
    expect(spinEase(0.5)).toBe(0.5);
    const mid = (spinEase(0.51) - spinEase(0.49)) / 0.02;
    const start = (spinEase(0.02) - spinEase(0)) / 0.02;
    const end = (spinEase(1) - spinEase(0.98)) / 0.02;
    expect(start).toBeLessThan(mid / 4);
    expect(end).toBeLessThan(mid / 4);
  });

  it("eases in slower than cruise, then eases out when paused", () => {
    const start = createOrbit();
    start.spinning = true;
    const yaw0 = start.yaw;
    stepOrbit(start, 16, false);
    const first = start.yaw - yaw0;
    expect(start.spinT).toBeGreaterThan(0);
    expect(start.spinT).toBeLessThan(16 / SPIN_IN_MS + 0.001);
    expect(first).toBeLessThan(SPIN * 16 * 0.05);

    for (let i = 0; i < Math.ceil(SPIN_IN_MS / 16) + 2; i++) stepOrbit(start, 16, false);
    expect(start.spinT).toBe(1);

    const beforeCruise = start.yaw;
    stepOrbit(start, 16, false);
    const cruise = start.yaw - beforeCruise;
    expect(cruise).toBeCloseTo(SPIN * 16, 8);
    expect(cruise).toBeGreaterThan(first * 10);

    start.spinning = false;
    const t = start.spinT;
    stepOrbit(start, 16, false);
    expect(start.spinT).toBeLessThan(t);
    for (let i = 0; i < Math.ceil(SPIN_OUT_MS / 16) + 2; i++) stepOrbit(start, 16, false);
    expect(start.spinT).toBe(0);
    const rest = start.yaw;
    stepOrbit(start, 16, false);
    expect(start.yaw).toBe(rest);
  });

  it("keeps decaying leftover spin while dragging", () => {
    const orbit = createOrbit();
    orbit.spinT = 1;
    orbit.spinning = false;
    orbit.dragging = true;
    const yaw0 = orbit.yaw;
    stepOrbit(orbit, 16, false);
    expect(orbit.yaw).toBeGreaterThan(yaw0);
    expect(orbit.spinT).toBeLessThan(1);
  });

  it("snaps off under reduced motion", () => {
    const orbit = createOrbit();
    orbit.spinning = true;
    orbit.spinT = 0.8;
    orbit.vYaw = 0.01;
    const yaw0 = orbit.yaw;
    expect(stepOrbit(orbit, 16, true)).toBe(false);
    expect(orbit.spinning).toBe(false);
    expect(orbit.spinT).toBe(0);
    expect(orbit.vYaw).toBe(0);
    expect(orbit.yaw).toBe(yaw0);
  });

  it("has nothing to animate at rest, so the frame loop can stop", () => {
    const orbit = createOrbit();
    expect(orbitActive(orbit)).toBe(false);

    orbit.spinning = true;
    expect(orbitActive(orbit)).toBe(true);
    for (let i = 0; i < Math.ceil(SPIN_IN_MS / 16) + 2; i++) stepOrbit(orbit, 16, false);

    // Paused: still active until the spin has eased all the way out.
    orbit.spinning = false;
    expect(orbitActive(orbit)).toBe(true);
    let steps = 0;
    while (orbitActive(orbit) && steps++ < 200) stepOrbit(orbit, 16, false);
    expect(steps).toBeLessThan(200);
    expect(orbit.spinT).toBe(0);
    expect(stepOrbit(orbit, 16, false)).toBe(false);
  });

  it("stays active through a drag and the glide after it, then stops", () => {
    const orbit = createOrbit();
    orbit.dragging = true;
    expect(orbitActive(orbit)).toBe(true);
    expect(stepOrbit(orbit, 16, false)).toBe(false);

    orbit.dragging = false;
    orbit.vYaw = 0.02;
    let steps = 0;
    while (orbitActive(orbit) && steps++ < 500) expect(stepOrbit(orbit, 16, false)).toBe(true);
    expect(steps).toBeGreaterThan(5);
    expect(orbit.vYaw).toBe(0);
    expect(stepOrbit(orbit, 16, false)).toBe(false);

    // A flick too slow to glide leaves nothing to animate either.
    orbit.vYaw = 0.0002;
    expect(orbitActive(orbit)).toBe(false);
  });

  it("has nothing to animate under reduced motion", () => {
    const orbit = createOrbit();
    orbit.spinning = true;
    orbit.spinT = 1;
    orbit.vPitch = 0.05;
    expect(stepOrbit(orbit, 16, true)).toBe(false);
    expect(orbitActive(orbit)).toBe(false);
  });

  it("draws idle spin at the cruise rate and a drag or glide every frame", () => {
    const orbit = createOrbit();
    orbit.spinning = true;
    orbit.spinT = 1;
    expect(spinOnly(orbit)).toBe(true);
    orbit.vYaw = 0.01;
    expect(spinOnly(orbit)).toBe(false);
    orbit.vYaw = 0;
    orbit.dragging = true;
    expect(spinOnly(orbit)).toBe(false);
  });
});

describe("first aim", () => {
  const nodes = [
    { lat: 40, lng: -100 },
    { lat: 50, lng: 10 },
  ];
  const you = { lat: -33.9, lng: 151.2 };
  const at = (lat: number, lng: number) => {
    const o = createOrbit();
    aimOrbit(o, lat, lng);
    return { yaw: o.yaw, pitch: o.pitch };
  };
  const pose = (o: { yaw: number; pitch: number }) => ({ yaw: o.yaw, pitch: o.pitch });

  it("looks at the visitor when they are known from the start, and only once", () => {
    const orbit = createOrbit();
    aimScene(orbit, you, nodes);
    expect(pose(orbit)).toEqual(at(you.lat, you.lng));
    orbit.yaw += 1;
    const turned = pose(orbit);
    aimScene(orbit, you, nodes);
    aimScene(orbit, null, nodes);
    expect(pose(orbit)).toEqual(turned);
  });

  it("looks at the middle of the regions first, then at the visitor when they arrive late", () => {
    const orbit = createOrbit();
    aimScene(orbit, null, nodes);
    expect(pose(orbit)).toEqual(at(45, -45));
    aimScene(orbit, null, nodes);
    expect(pose(orbit)).toEqual(at(45, -45));

    aimScene(orbit, you, nodes);
    expect(pose(orbit)).toEqual(at(you.lat, you.lng));
    aimScene(orbit, { lat: 0, lng: 0 }, nodes);
    expect(pose(orbit)).toEqual(at(you.lat, you.lng));
  });

  it("leaves a globe the visitor has turned where they put it", () => {
    const orbit = createOrbit();
    aimScene(orbit, null, nodes);
    orbit.yaw = 2;
    orbit.pitch = -0.3;
    orbit.touched = true;
    aimScene(orbit, you, nodes);
    expect(pose(orbit)).toEqual({ yaw: 2, pitch: -0.3 });
    // And does not fall back to the regions afterwards.
    aimScene(orbit, null, nodes);
    expect(pose(orbit)).toEqual({ yaw: 2, pitch: -0.3 });
  });

  it("waits for something to look at", () => {
    const orbit = createOrbit();
    aimScene(orbit, null, []);
    expect(orbit.aimed).toBe(false);
    expect(pose(orbit)).toEqual(pose(createOrbit()));
  });
});
