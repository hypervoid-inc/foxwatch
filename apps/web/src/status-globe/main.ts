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
  claimGpu();
  let handle: GlobeHandle | undefined;
  try {
    handle = mountGlobe(stage);
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
    window.__fwGlobe = { refresh: handle.refresh, paint: handle.paint };
    handle.refresh();
  } catch {
    window.__fwGpuDispose?.();
    handle?.dispose();
    window.__fwGpuGlobe = false;
    fallback();
  }
}

void boot();
