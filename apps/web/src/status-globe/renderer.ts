import {
  clock,
  draw,
  effect,
  frameLoop,
  geometry,
  init,
  sampler,
  surface,
  target,
  type FrameLoopHandle,
  type Gpu,
  type Surface,
  type Target,
  type Texture,
} from "vgpu";
import { orthographicCamera, sphere } from "vgpu/scene";
import { rotateYawPitch } from "@foxwatch/engine";
import planetWgsl from "./planet.wgsl";
import probesWgsl from "./probes.wgsl";
import arcsWgsl from "./arcs.wgsl";
import blitWgsl from "./blit.wgsl";
import { aimOrbit, bindOrbit, createOrbit, stepOrbit, type Orbit } from "./orbit.ts";
import {
  globeRotation,
  layoutGlobe,
  mat4Multiply,
  project,
} from "./math.ts";
import {
  arcTint,
  bakeLand,
  hopSamples,
  kindColor,
  readLand,
  readScene,
  readTheme,
  isDarkTheme,
  type GlobeNode,
  type GlobeScene,
} from "./scene.ts";

const MAX_HOPS = 512;
const MAX_PROBES = 24;
const HOP_STRIDE = 16;
const PROBE_STRIDE = 8;
const TRANSPARENT = [0, 0, 0, 0] as const;

const QUAD = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);

export type GlobeHandle = {
  refresh: () => void;
  paint: () => void;
  dispose: () => void;
  ready: Promise<void>;
};

function hex(c: [number, number, number]): string {
  const to = (n: number) => Math.round(n * 255).toString(16).padStart(2, "0");
  return `#${to(c[0])}${to(c[1])}${to(c[2])}`;
}

export function mountGlobe(stage: HTMLElement): GlobeHandle {
  let disposed = false;
  let gpu: Gpu | undefined;
  let view: Surface | undefined;
  let sceneTarget: Target | undefined;
  let landTex: Texture | undefined;
  let loop: FrameLoopHandle | undefined;
  let unbindPointer: (() => void) | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let overlay: HTMLCanvasElement | undefined;
  let labels: HTMLCanvasElement | undefined;
  let octx: CanvasRenderingContext2D | null = null;
  let hopGeo: ReturnType<typeof geometry> | undefined;
  let probeGeo: ReturnType<typeof geometry> | undefined;
  let planetDraw: ReturnType<typeof draw> | undefined;
  let hopDraw: ReturnType<typeof draw> | undefined;
  let probeDraw: ReturnType<typeof draw> | undefined;
  let blitDraw: ReturnType<typeof effect> | undefined;
  let cam: ReturnType<typeof orthographicCamera> | undefined;
  let hopCount = 0;
  let probeCount = 0;
  let mesh: GlobeScene | null = null;
  let theme = readTheme();
  let themeKey = isDarkTheme() ? "dark" : "light";
  let hot: string | null = null;
  let looking = false;
  const orbit: Orbit = createOrbit();
  const hops = new Float32Array(MAX_HOPS * HOP_STRIDE);
  const probes = new Float32Array(MAX_PROBES * PROBE_STRIDE);
  const mq = window.matchMedia("(min-width: 1100px) and (hover: hover) and (pointer: fine)");
  const reduceMq = window.matchMedia("(prefers-reduced-motion: reduce)");
  let cssW = 1;
  let cssH = 1;
  let layout = layoutGlobe(1, 1, 16);
  const mvp = new Float32Array(16);
  const model = new Float32Array(16);

  const desktop = () => mq.matches;
  const reduce = () => reduceMq.matches;

  const fail = (error: unknown) => {
    dispose();
    throw error;
  };

  const sizeOverlay = () => {
    if (!labels || !octx) return;
    cssW = Math.max(1, Math.round(document.documentElement.clientWidth || window.innerWidth));
    cssH = Math.max(1, Math.round(document.documentElement.clientHeight || window.innerHeight));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    labels.width = Math.round(cssW * dpr);
    labels.height = Math.round(cssH * dpr);
    labels.style.width = `${cssW}px`;
    labels.style.height = `${cssH}px`;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (canvas) {
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    layout = layoutGlobe(cssW, cssH, rem);
    syncGutter(desktop() && !stage.hidden);
  };

  let gutterKey = "";
  const syncGutter = (on: boolean) => {
    const root = document.documentElement;
    if (!on) {
      if (gutterKey) {
        root.style.removeProperty("--globe-left");
        root.style.removeProperty("--globe-cx");
        root.style.removeProperty("--globe-cy");
        gutterKey = "";
      }
      return;
    }
    const left = Math.round(layout.cx - layout.radius);
    const gx = Math.round(layout.cx);
    const gy = Math.round(layout.cy);
    const key = `${cssW}:${left}:${gx}:${gy}`;
    if (key === gutterKey) return;
    gutterKey = key;
    root.style.setProperty("--globe-left", `${left}px`);
    root.style.setProperty("--globe-cx", `${gx}px`);
    root.style.setProperty("--globe-cy", `${gy}px`);
  };

  const writeInstances = () => {
    if (!hopGeo || !probeGeo || !mesh) {
      hopCount = 0;
      probeCount = 0;
      return;
    }
    const { radius } = layout;
    let hi = 0;
    const packHop = (
      pts: { x: number; y: number; z: number }[],
      color: [number, number, number],
      widthPx: number,
      dash: number,
    ) => {
      const width = (widthPx * 0.5) / Math.max(1, radius);
      for (let i = 0; i < pts.length - 1 && hi < MAX_HOPS; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        const o = hi * HOP_STRIDE;
        hops[o] = a.x; hops[o + 1] = a.y; hops[o + 2] = a.z; hops[o + 3] = 0;
        hops[o + 4] = b.x; hops[o + 5] = b.y; hops[o + 6] = b.z; hops[o + 7] = width;
        hops[o + 8] = color[0]; hops[o + 9] = color[1]; hops[o + 10] = color[2]; hops[o + 11] = dash;
        hops[o + 12] = i / (pts.length - 1);
        hops[o + 13] = (i + 1) / (pts.length - 1);
        hops[o + 14] = 0;
        hops[o + 15] = 0;
        hi++;
      }
    };
    for (const arc of mesh.arcs) {
      const on = hot && (arc.a.id === hot || arc.b.id === hot);
      packHop(hopSamples(arc.a.v, arc.b.v), on ? theme.ink : arcTint(arc.a, arc.b, theme), on ? 2.2 : 1.35, 0);
    }
    if (mesh.you && mesh.youTo) {
      packHop(hopSamples(mesh.you.v, mesh.youTo.v), theme.ink, 1.2, 1);
    }
    hopCount = hi;
    hopGeo.buffers[1]!.write(hops);

    let pi = 0;
    const packProbe = (v: { x: number; y: number; z: number }, color: [number, number, number], sizePx: number, kind: number) => {
      if (pi >= MAX_PROBES) return;
      const o = pi * PROBE_STRIDE;
      const s = sizePx / Math.max(1, radius);
      probes[o] = v.x * 1.02; probes[o + 1] = v.y * 1.02; probes[o + 2] = v.z * 1.02; probes[o + 3] = s;
      probes[o + 4] = color[0]; probes[o + 5] = color[1]; probes[o + 6] = color[2]; probes[o + 7] = kind;
      pi++;
    };
    for (const n of mesh.nodes) {
      packProbe(n.v, kindColor(n.kind, theme), n.id === hot ? 6 : 4.2, 0);
    }
    if (mesh.you) packProbe(mesh.you.v, theme.ink, hot === "you" ? 6.4 : 5.2, 1);
    probeCount = pi;
    probeGeo.buffers[1]!.write(probes);
  };

  const applyTheme = () => {
    theme = readTheme();
    themeKey = isDarkTheme() ? "dark" : "light";
    if (planetDraw) writeInstances();
  };

  const splitRead = (n: GlobeNode) => {
    const read = n.read || "";
    const label = n.label || "";
    if (!read || read === label) return "";
    if (label && read.startsWith(label)) {
      const rest = read.slice(label.length);
      return rest.startsWith(" · ") ? rest.slice(3) : rest;
    }
    return read;
  };

  const drawTag = (px: number, py: number, title: string, sub: string, _accent: string) => {
    if (!octx) return;
    const { cx, cy } = layout;
    let ox = px - cx;
    let oy = py - cy;
    const len = Math.hypot(ox, oy) || 1;
    ox /= len;
    oy /= len;
    octx.font = "650 11px ui-sans-serif, system-ui, sans-serif";
    const w1 = octx.measureText(title).width;
    octx.font = "500 10px ui-sans-serif, system-ui, sans-serif";
    const w2 = sub ? octx.measureText(sub).width : 0;
    const tw = Math.min(220, Math.max(w1, w2) + 16);
    const th = sub ? 34 : 22;
    const left = ox < 0.12;
    let bx = px + ox * 16 - (left ? tw : 0);
    let by = py + oy * 16 - th / 2;
    bx = Math.min(cssW - tw - 8, Math.max(8, bx));
    by = Math.min(cssH - th - 8, Math.max(8, by));
    octx.beginPath();
    octx.moveTo(px, py);
    octx.lineTo(left ? bx + tw : bx, by + th / 2);
    octx.strokeStyle = tokenLine();
    octx.lineWidth = 1;
    octx.globalAlpha = 0.55;
    octx.stroke();
    octx.globalAlpha = 1;
    roundRect(octx, bx, by, tw, th, 8);
    octx.fillStyle = tokenCard();
    octx.fill();
    octx.strokeStyle = tokenLine();
    octx.stroke();
    octx.fillStyle = tokenInk();
    octx.font = "650 11px ui-sans-serif, system-ui, sans-serif";
    octx.fillText(title, bx + 8, by + 14);
    if (sub) {
      octx.fillStyle = tokenMuted();
      octx.font = "500 10px ui-sans-serif, system-ui, sans-serif";
      octx.fillText(sub, bx + 8, by + 27);
    }
  };

  const revealGlobe = () => {
    if (typeof window.__fwRevealGlobe === "function") {
      window.__fwRevealGlobe();
      return;
    }
    if (!stage.hidden && !stage.classList.contains("is-in") && !stage.classList.contains("is-ready")) {
      stage.classList.add("is-ready");
    }
  };
  const tokenLine = () => hex(theme.line);
  const tokenCard = () => hex(theme.card);
  const tokenInk = () => hex(theme.ink);
  const tokenMuted = () => hex(theme.muted);

  const front = (v: { x: number; y: number; z: number }, minZ: number) =>
    rotateYawPitch(v, orbit.yaw, orbit.pitch).z >= minZ;

  const drawLabels = () => {
    if (!octx || !mesh || !labels?.isConnected) return;
    octx.clearRect(0, 0, cssW, cssH);
    for (const n of mesh.nodes) {
      if (hot && n.id === hot) continue;
      if (n.kind !== "bad" && n.kind !== "warn") continue;
      if (!front(n.v, 0.28)) continue;
      const p = project(n.v, mvp, cssW, cssH);
      if (!p.visible) continue;
      drawTag(p.x, p.y, n.label || n.id, "", hex(kindColor(n.kind, theme)));
    }
    if (mesh.you && (!hot || hot !== "you") && front(mesh.you.v, 0.28)) {
      const p = project(mesh.you.v, mvp, cssW, cssH);
      if (p.visible) {
        let youSub = mesh.you.city || "";
        if (mesh.youTo) youSub = youSub ? `${youSub} · ${mesh.youTo.label}` : mesh.youTo.label;
        drawTag(p.x, p.y, "You", youSub, tokenInk());
      }
    }
    if (hot === "you" && mesh.you && front(mesh.you.v, 0.08)) {
      const p = project(mesh.you.v, mvp, cssW, cssH);
      if (p.visible) {
        drawTag(p.x, p.y, "You", mesh.you.city ? `${mesh.you.city}${mesh.youTo ? ` · nearest ${mesh.youTo.label}` : ""}` : "", tokenInk());
      }
    } else if (hot && mesh) {
      const n = mesh.nodes.find((node) => node.id === hot);
      if (n && front(n.v, 0.08)) {
        const p = project(n.v, mvp, cssW, cssH);
        if (p.visible) drawTag(p.x, p.y, n.label || n.id, splitRead(n), hex(kindColor(n.kind, theme)));
      }
    }
  };

  const pickAt = (clientX: number, clientY: number) => {
    if (!overlay || !mesh) return null;
    const rect = overlay.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: string | null = null;
    let bestD = 40 * 40;
    for (const n of mesh.nodes) {
      if (!front(n.v, 0.1)) continue;
      const p = project(n.v, mvp, cssW, cssH);
      const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
      if (d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    if (mesh.you && front(mesh.you.v, 0.1)) {
      const p = project(mesh.you.v, mvp, cssW, cssH);
      const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
      if (d < bestD) best = "you";
    }
    return best;
  };

  const setHot = (id: string | null) => {
    if (hot === id) return;
    hot = id;
    if (typeof window.__fwPickRegion === "function") window.__fwPickRegion(id && id !== "you" ? id : null);
    writeInstances();
    drawLabels();
  };

  const nearGlobe = (e: PointerEvent) => {
    if (!overlay) return false;
    const rect = overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const dx = x - layout.cx;
    const dy = y - layout.cy;
    const lim = layout.radius * 1.28;
    return dx * dx + dy * dy <= lim * lim;
  };

  const setFrame = () => {
    if (!planetDraw || !hopDraw || !probeDraw || !view || !cam) return;
    sizeOverlay();
    const { cx, cy, radius } = layout;
    const r = Math.max(1, radius);
    cam.set({
      left: -cx / r,
      right: (cssW - cx) / r,
      bottom: (cy - cssH) / r,
      top: cy / r,
    });
    globeRotation(orbit.yaw, orbit.pitch, model);
    mat4Multiply(cam.viewProjection, model, mvp);
    const viewProjection = cam.viewProjection;
    const cameraPosition = [0, 0, 4] as const;
    const right = [1, 0, 0] as const;
    const up = [0, 1, 0] as const;
    planetDraw.set({
      planet: {
        viewProjection,
        model,
        cameraPosition,
        ocean: theme.hover,
        land: theme.empty,
        hover: theme.card,
        line: theme.line,
      },
      landMap: landTex,
    });
    hopDraw.set({ frame: { viewProjection, model, cameraPosition } });
    probeDraw.set({ frame: { viewProjection, model, cameraPosition, right, up } });
  };

  const paint = () => {
    if (disposed || stage.hidden) return;
    const key = isDarkTheme() ? "dark" : "light";
    if (key !== themeKey) applyTheme();
    setFrame();
    drawLabels();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unbindPointer?.();
    loop?.stop();
    gpu?.dispose();
    canvas?.remove();
    overlay?.remove();
    labels?.remove();
    stage.classList.remove("is-drag");
    syncGutter(false);
  };

  const refresh = () => {
    if (disposed) return;
    mesh = readScene();
    if (!desktop() || !mesh) {
      stage.hidden = true;
      stage.setAttribute("aria-hidden", "true");
      if (!desktop()) syncGutter(false);
      return;
    }
    stage.hidden = false;
    stage.removeAttribute("aria-hidden");
    if (!looking && mesh.you) {
      aimOrbit(orbit, mesh.you.lat, mesh.you.lng);
      looking = true;
    } else if (!looking && mesh.nodes[0]) {
      const lat0 = mesh.nodes.reduce((s, n) => s + n.lat, 0) / mesh.nodes.length;
      const lng0 = mesh.nodes.reduce((s, n) => s + n.lng, 0) / mesh.nodes.length;
      aimOrbit(orbit, lat0, lng0);
      looking = true;
    }
    applyTheme();
    writeInstances();
    paint();
  };

  const ready = (async () => {
    canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.pointerEvents = "none";
    overlay = document.createElement("canvas");
    overlay.setAttribute("aria-hidden", "true");
    for (const extra of document.querySelectorAll("canvas.globe-labels")) extra.remove();
    labels = document.createElement("canvas");
    labels.className = "globe-labels";
    labels.setAttribute("aria-hidden", "true");
    stage.replaceChildren(canvas, overlay);
    document.body.appendChild(labels);
    octx = labels.getContext("2d");
    if (!octx) throw new Error("2d overlay unavailable");

    gpu = await init();
    if (disposed) {
      gpu.dispose();
      return;
    }
    gpu.onError((err) => {
      console.error(err);
    });
    cam = orthographicCamera({
      left: -1,
      right: 1,
      bottom: -1,
      top: 1,
      near: 0.1,
      far: 20,
      position: [0, 0, 4],
      target: [0, 0, 0],
    });
    view = surface(gpu, canvas, {
      dpr: [1, 2],
      alphaMode: "premultiplied",
      clearColor: TRANSPARENT,
    });
    sceneTarget = target(gpu, {
      size: view.size,
      format: "rgba8unorm",
      msaa: true,
      depth: true,
      clearColor: TRANSPARENT,
    });
    view.onResize((event) => {
      sceneTarget?.resize([event.width, event.height]);
    });

    const planetGeo = geometry(gpu, sphere({ radius: 1, widthSegments: 128, heightSegments: 64 }));
    hopGeo = geometry(gpu, {
      buffers: [
        { attributes: { corner: "float32x2" }, data: QUAD },
        {
          attributes: {
            a: { format: "float32x3", offset: 0 },
            b: { format: "float32x3", offset: 16 },
            width: { format: "float32", offset: 28 },
            color: { format: "float32x3", offset: 32 },
            dash: { format: "float32", offset: 44 },
            along0: { format: "float32", offset: 48 },
            along1: { format: "float32", offset: 52 },
          },
          data: hops,
          stride: HOP_STRIDE * 4,
          stepMode: "instance",
        },
      ],
      vertexCount: 6,
      instanceCount: MAX_HOPS,
    });
    probeGeo = geometry(gpu, {
      buffers: [
        { attributes: { corner: "float32x2" }, data: QUAD },
        {
          attributes: {
            position: { format: "float32x3", offset: 0 },
            size: { format: "float32", offset: 12 },
            color: { format: "float32x3", offset: 16 },
            kind: { format: "float32", offset: 28 },
          },
          data: probes,
          stride: PROBE_STRIDE * 4,
          stepMode: "instance",
        },
      ],
      vertexCount: 6,
      instanceCount: MAX_PROBES,
    });

    const mapSampler = sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "clamp-to-edge",
    });
    landTex = bakeLand(gpu, readLand());

    planetDraw = draw(gpu, { shader: planetWgsl, geometry: planetGeo, cull: "back" });
    planetDraw.set({ landMap: landTex, mapSampler });
    hopDraw = draw(gpu, {
      shader: arcsWgsl,
      geometry: hopGeo,
      blend: "alpha",
      depth: { write: false },
    });
    probeDraw = draw(gpu, {
      shader: probesWgsl,
      geometry: probeGeo,
      blend: "alpha",
      depth: { write: false },
    });
    blitDraw = effect(gpu, blitWgsl, { blend: "premultiplied" });
    blitDraw.set({ src: sceneTarget });

    await Promise.all([
      planetDraw.compile(sceneTarget),
      hopDraw.compile(sceneTarget),
      probeDraw.compile(sceneTarget),
      blitDraw.compile({ colors: [view.format] }),
    ]);
    if (disposed) return;

    unbindPointer = bindOrbit(overlay, orbit, {
      getRadius: () => layout.radius,
      nearGlobe,
      onDrag: () => paint(),
      onHover: (e) => setHot(pickAt(e.clientX, e.clientY)),
      onLeave: () => setHot(null),
      onClick: (e) => setHot(pickAt(e.clientX, e.clientY)),
      onIdle: () => paint(),
      stage,
      reduce,
    });

    const time = clock(gpu);
    loop = frameLoop(gpu, (currentFrame) => {
      if (disposed || !view || !sceneTarget || !planetDraw || !hopDraw || !probeDraw || !blitDraw) return;
      if (stage.hidden) return;
      const dt = Math.min(48, time.deltaTime * 1000);
      stepOrbit(orbit, dt, reduce());
      setFrame();
      currentFrame.pass({ target: sceneTarget, clear: TRANSPARENT }, (pass) => {
        pass.draw(planetDraw!);
        pass.draw(hopDraw!, { instances: hopCount });
        pass.draw(probeDraw!, { instances: probeCount });
      });
      currentFrame.pass({ target: view, clear: TRANSPARENT }, (pass) => {
        pass.draw(blitDraw!);
      });
      drawLabels();
      revealGlobe();
    });

    mq.addEventListener("change", refresh);
    reduceMq.addEventListener("change", refresh);
    window.addEventListener("resize", paint);
    new MutationObserver(() => {
      applyTheme();
      paint();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    refresh();
  })().catch((error: unknown) => {
    if (disposed) return;
    fail(error);
  });

  return { refresh, paint, dispose, ready };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, rw: number, rh: number, rad: number) {
  const rr = Math.min(rad, rw / 2, rh / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + rw, y, x + rw, y + rh, rr);
  ctx.arcTo(x + rw, y + rh, x, y + rh, rr);
  ctx.arcTo(x, y + rh, x, y, rr);
  ctx.arcTo(x, y, x + rw, y, rr);
  ctx.closePath();
}
