/// <reference types="@vgpu/wgsl/wgsl-types" />
/// <reference types="@webgpu/types" />

import { mountGlobe, type GlobeHandle } from "./renderer.ts";

function fallback() {
  window.dispatchEvent(new Event("fw-globe-fallback"));
}

function claimGpu() {
  window.__fwGpuGlobe = true;
  window.dispatchEvent(new Event("fw-globe-gpu"));
}

async function boot() {
  const stage = document.getElementById("globe-stage");
  if (!stage) return;
  if (!navigator.gpu) {
    fallback();
    return;
  }
  if (!window.matchMedia("(min-width: 1100px) and (hover: hover) and (pointer: fine)").matches) {
    fallback();
    return;
  }
  window.__fwGpuDispose?.();
  // The canvas renderer's handle, put back if this one has to give the globe up.
  const flat = window.__fwGlobe;
  claimGpu();
  let handle: GlobeHandle | undefined;
  let gone = false;
  const giveUp = () => {
    if (gone) return;
    gone = true;
    window.__fwGpuDispose?.();
    handle?.dispose();
    window.__fwGpuGlobe = false;
    window.__fwGlobe = flat;
    // Empty until the canvas renderer, if there is one, shows it again.
    stage.hidden = true;
    stage.setAttribute("aria-hidden", "true");
    fallback();
  };
  try {
    handle = mountGlobe(stage, giveUp);
    window.__fwGpuDispose = () => {
      handle?.dispose();
      if (window.__fwGpuDispose) window.__fwGpuDispose = undefined;
    };
    await Promise.race([
      handle.ready,
      new Promise<void>((_, reject) => {
        window.setTimeout(() => reject(new Error("globe init timeout")), 8000);
      }),
    ]);
    if (gone) return;
    window.__fwGlobe = { refresh: handle.refresh, paint: handle.paint };
    handle.refresh();
  } catch {
    giveUp();
  }
}

void boot();
