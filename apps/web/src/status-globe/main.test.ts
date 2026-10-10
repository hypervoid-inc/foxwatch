import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mount = vi.hoisted(() => ({
  ready: Promise.resolve() as Promise<void>,
  onLost: undefined as (() => void) | undefined,
  dispose: vi.fn(),
  refresh: vi.fn(),
  paint: vi.fn(),
}));

vi.mock("./renderer.ts", () => ({
  mountGlobe: (_stage: unknown, onLost?: () => void) => {
    mount.onLost = onLost;
    return { ready: mount.ready, dispose: mount.dispose, refresh: mount.refresh, paint: mount.paint };
  },
}));

type FakeWindow = Record<string, unknown> & { events: string[] };

function page(): { win: FakeWindow; stage: { hidden: boolean; attrs: Record<string, string> } } {
  const stage = {
    hidden: false,
    attrs: {} as Record<string, string>,
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    },
  };
  const win: FakeWindow = {
    events: [],
    dispatchEvent(event: { type: string }) {
      win.events.push(event.type);
      return true;
    },
    matchMedia: () => ({ matches: true }),
    setTimeout: () => 0,
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", { getElementById: (id: string) => (id === "globe-stage" ? stage : null) });
  vi.stubGlobal("navigator", { gpu: {} });
  return { win, stage };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("WebGPU globe boot", () => {
  beforeEach(() => {
    vi.resetModules();
    mount.ready = Promise.resolve();
    mount.onLost = undefined;
    mount.dispose.mockClear();
    mount.refresh.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("hands the globe back to the canvas renderer when the device is lost after it started", async () => {
    const { win, stage } = page();
    const flat = { refresh: vi.fn(), paint: vi.fn() };
    win.__fwGlobe = flat;
    await import("./main.ts");
    await settle();
    expect(win.__fwGpuGlobe).toBe(true);
    expect(win.__fwGlobe).not.toBe(flat);
    expect(win.events).toEqual(["fw-globe-gpu"]);

    mount.onLost?.();
    expect(mount.dispose).toHaveBeenCalled();
    expect(win.__fwGpuGlobe).toBe(false);
    expect(win.__fwGlobe).toBe(flat);
    expect(win.__fwGpuDispose).toBeUndefined();
    expect(stage.hidden).toBe(true);
    expect(win.events).toEqual(["fw-globe-gpu", "fw-globe-fallback"]);

    // Told twice, it falls back once.
    mount.onLost?.();
    expect(win.events).toEqual(["fw-globe-gpu", "fw-globe-fallback"]);
  });

  it("does not claim the page for a globe that was lost while it was starting", async () => {
    const { win } = page();
    const flat = { refresh: vi.fn(), paint: vi.fn() };
    win.__fwGlobe = flat;
    let started: () => void = () => {};
    mount.ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    await import("./main.ts");
    mount.onLost?.();
    started();
    await settle();
    expect(win.__fwGlobe).toBe(flat);
    expect(win.__fwGpuGlobe).toBe(false);
    expect(mount.refresh).not.toHaveBeenCalled();
    expect(win.events).toEqual(["fw-globe-gpu", "fw-globe-fallback"]);
  });

  it("falls back when the globe cannot start", async () => {
    const { win } = page();
    mount.ready = Promise.reject(new Error("no adapter"));
    mount.ready.catch(() => {});
    await import("./main.ts");
    await settle();
    expect(win.__fwGpuGlobe).toBe(false);
    expect(mount.dispose).toHaveBeenCalled();
    expect(win.events).toEqual(["fw-globe-gpu", "fw-globe-fallback"]);
  });
});
