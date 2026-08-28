import { describe, expect, it } from "vitest";
import {
  createOrbit,
  IDLE_MS,
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
});
