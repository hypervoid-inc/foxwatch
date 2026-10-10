import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PublicSnapshot } from "@foxwatch/engine";
import { layoutGlobe } from "../../../web/src/status-globe/math.ts";
import { CRUISE_MS, SPIN } from "../../../web/src/status-globe/orbit.ts";
import { HOP_LIFT } from "../../../web/src/status-globe/scene.ts";
import { GLOBE_CLIENT_SCRIPT } from "./public-globe.ts";
import { GUTTER_BOOT, renderPublicHtml } from "./public-html.ts";

// The globe's place on the page and its colours are written out by hand in
// several files: the WebGPU module, the canvas renderer, the snippet that
// reserves the gutter before first paint, and the stylesheet. Nothing ties the
// copies together at build time, so these tests do.

type Layout = { left: number; cx: number; cy: number };

const rounded = (cx: number, cy: number, radius: number): Layout => ({ left: Math.round(cx - radius), cx: Math.round(cx), cy: Math.round(cy) });

/** layoutGlobe: what the WebGPU globe draws at. */
function gpuLayout(w: number, h: number, rem: number): Layout {
  const { cx, cy, radius } = layoutGlobe(w, h, rem);
  return rounded(cx, cy, radius);
}

/** GUTTER_BOOT as the page runs it, against a viewport of the given size. */
function bootLayout(w: number, h: number, rem: number, desktop = true): { vars: Record<string, string>; classes: string[] } {
  const vars: Record<string, string> = {};
  const classes: string[] = [];
  const document = {
    documentElement: {
      clientWidth: w,
      clientHeight: h,
      classList: { add: (name: string) => void classes.push(name) },
      style: { setProperty: (name: string, value: string) => void (vars[name] = value) },
    },
  };
  new Function("document", "matchMedia", "getComputedStyle", "innerWidth", "innerHeight", GUTTER_BOOT)(
    document,
    () => ({ matches: desktop }),
    () => ({ fontSize: `${rem}px` }),
    w,
    h,
  );
  return { vars, classes };
}

/** The layout lines of the canvas renderer's size(), lifted out of the script it ships in. */
function canvasLayout(w: number, h: number, rem: number): Layout {
  const from = GLOBE_CLIENT_SCRIPT.indexOf("var rem=parseFloat(");
  const to = GLOBE_CLIENT_SCRIPT.indexOf("syncGutter(true);", from);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  const lift = Number(/var HOP_LIFT=([0-9.]+);/.exec(GLOBE_CLIENT_SCRIPT)?.[1]);
  const run = new Function("w", "h", "HOP_LIFT", "getComputedStyle", "document", `var radius, cx, cy; ${GLOBE_CLIENT_SCRIPT.slice(from, to)} return { cx: cx, cy: cy, radius: radius };`);
  const out = run(w, h, lift, () => ({ fontSize: `${rem}px` }), { documentElement: {} }) as { cx: number; cy: number; radius: number };
  return rounded(out.cx, out.cy, out.radius);
}

describe("globe layout copies", () => {
  const viewports: Array<[number, number, number]> = [
    [1100, 700, 16],
    [1180, 820, 16],
    [1280, 720, 16],
    [1366, 768, 16],
    [1440, 900, 16],
    [1920, 1080, 16],
    [2560, 1440, 16],
    [3440, 1440, 20],
    [1100, 420, 16],
    [1600, 600, 18],
  ];

  it("reserve the same gutter before paint as either renderer then draws in", () => {
    for (const [w, h, rem] of viewports) {
      const want = gpuLayout(w, h, rem);
      const { vars } = bootLayout(w, h, rem);
      expect({ left: vars["--globe-left"], cx: vars["--globe-cx"], cy: vars["--globe-cy"] }, `boot ${w}x${h}`).toEqual({
        left: `${want.left}px`,
        cx: `${want.cx}px`,
        cy: `${want.cy}px`,
      });
      expect(canvasLayout(w, h, rem), `canvas ${w}x${h}`).toEqual(want);
    }
  });

  it("agree on how far a hop rises above the surface", () => {
    expect(GLOBE_CLIENT_SCRIPT).toContain(`var HOP_LIFT=${HOP_LIFT};`);
    expect(GUTTER_BOOT).toContain(`envelope=${1 + HOP_LIFT}`);
  });

  it("agree on how often idle spin is drawn", () => {
    expect(GLOBE_CLIENT_SCRIPT).toContain(`var CRUISE_MS=${CRUISE_MS};`);
    expect(GLOBE_CLIENT_SCRIPT).toContain(`var SPIN=${SPIN};`);
  });

  it("mark the page for a globe on any screen, and reserve room only on a wide one with a mouse", () => {
    const phone = bootLayout(390, 800, 16, false);
    expect(phone.classes).toEqual(["globe-on"]);
    expect(phone.vars).toEqual({});
    expect(bootLayout(1440, 900, 16).classes).toEqual(["globe-on"]);
  });
});

describe("globe palette copies", () => {
  const snap: PublicSnapshot = { siteName: "Acme", banner: "fully_operational", stale: false, lastTick: 1, generatedAt: 1, groups: [], incidents: [], maintenance: [], observers: [] };
  const html = renderPublicHtml(snap);
  const tokens = (block: string) => Object.fromEntries([...block.matchAll(/(--[a-z-]+): (#[0-9a-f]{6});/g)].map((m) => [m[1]!, m[2]!]));
  const rule = (selector: string) => {
    const at = html.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThan(0);
    return tokens(html.slice(at, html.indexOf("}", at)));
  };
  const light = rule(':root, html[data-theme="light"]');
  const dark = rule('html[data-theme="dark"]');

  it("the stylesheet says dark the same way for a chosen theme and for the system's", () => {
    expect(Object.keys(light).length).toBeGreaterThan(15);
    expect(rule(':root:not([data-theme="light"])')).toEqual(dark);
    const registered = Object.fromEntries([...html.matchAll(/@property (--[a-z-]+) \{[^}]*initial-value: (#[0-9a-f]{6});/g)].map((m) => [m[1]!, m[2]!]));
    for (const [name, value] of Object.entries(registered)) expect(light[name], name).toBe(value);
  });

  it("the canvas globe draws with the stylesheet's colours", () => {
    const theme = new Function(`return ${/var THEME=(\{[\s\S]*?\n  \});/.exec(GLOBE_CLIENT_SCRIPT)?.[1] ?? "null"};`)() as Record<"light" | "dark", Record<string, string>>;
    expect(Object.keys(theme.light).length).toBeGreaterThan(5);
    for (const [name, value] of Object.entries(theme.light)) expect(light[name], `light ${name}`).toBe(value);
    for (const [name, value] of Object.entries(theme.dark)) expect(dark[name], `dark ${name}`).toBe(value);
  });

  it("the WebGPU globe draws with the stylesheet's colours", () => {
    const src = readFileSync(new URL("../../../web/src/status-globe/scene.ts", import.meta.url), "utf8");
    const palette = (name: string) => {
      const block = new RegExp(`const ${name}: ThemeColors = \\{([^}]*)\\}`).exec(src)?.[1] ?? "";
      return Object.fromEntries([...block.matchAll(/(\w+): parseColor\("(#[0-9a-f]{6})"\)/g)].map((m) => [`--${m[1]}`, m[2]!]));
    };
    const gpuLight = palette("LIGHT");
    const gpuDark = palette("DARK");
    expect(Object.keys(gpuLight).length).toBeGreaterThan(5);
    expect(Object.keys(gpuDark)).toEqual(Object.keys(gpuLight));
    for (const [name, value] of Object.entries(gpuLight)) expect(light[name], `light ${name}`).toBe(value);
    for (const [name, value] of Object.entries(gpuDark)) expect(dark[name], `dark ${name}`).toBe(value);
  });

  it("the browser's toolbar colour is the page background in both themes", () => {
    expect(html).toContain(`<meta name="theme-color" content="${light["--bg"]}"/>`);
    const pair = `t==="dark"?"${dark["--bg"]}":"${light["--bg"]}"`;
    // Once before first paint, once when the appearance button is pressed.
    expect(html.split(pair).length - 1).toBe(2);
  });
});
