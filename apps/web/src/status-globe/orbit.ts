import { clampPitch, lookAtYawPitch } from "@foxwatch/engine";

export const IDLE_MS = 1000;
export const SPIN = 0.000062;
export const SPIN_IN_MS = 1200;
export const SPIN_OUT_MS = 420;

export type Orbit = {
  yaw: number;
  pitch: number;
  vYaw: number;
  vPitch: number;
  dragging: boolean;
  spinning: boolean;
  spinT: number;
  moved: boolean;
  aimed: boolean;
};

export function createOrbit(yaw = 0.35, pitch = 0.22): Orbit {
  return {
    yaw,
    pitch,
    vYaw: 0,
    vPitch: 0,
    dragging: false,
    spinning: false,
    spinT: 0,
    moved: false,
    aimed: false,
  };
}

export function aimOrbit(orbit: Orbit, lat: number, lng: number) {
  const look = lookAtYawPitch(lat, lng);
  orbit.yaw = look.yaw;
  orbit.pitch = clampPitch(look.pitch);
  orbit.aimed = true;
}

export function spinEase(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return u * u * (3 - 2 * u);
}

export function stepSpinT(orbit: Orbit, dt: number): void {
  const target = orbit.spinning ? 1 : 0;
  if (orbit.spinT === target) return;
  const dur = target > orbit.spinT ? SPIN_IN_MS : SPIN_OUT_MS;
  const dir = target > orbit.spinT ? 1 : -1;
  orbit.spinT = Math.min(1, Math.max(0, orbit.spinT + dir * (dt / dur)));
  if (Math.abs(orbit.spinT - target) < 0.0005) orbit.spinT = target;
}

export function stepOrbit(orbit: Orbit, dt: number, reduce: boolean): boolean {
  if (reduce) {
    orbit.spinning = false;
    orbit.spinT = 0;
    orbit.vYaw = 0;
    orbit.vPitch = 0;
    return false;
  }

  stepSpinT(orbit, dt);
  const gain = spinEase(orbit.spinT);
  let moved = gain > 0.0005;

  if (!orbit.dragging && Math.abs(orbit.vYaw) + Math.abs(orbit.vPitch) > 0.0004) {
    orbit.yaw += orbit.vYaw;
    orbit.pitch = clampPitch(orbit.pitch + orbit.vPitch);
    orbit.vYaw *= 0.92;
    orbit.vPitch *= 0.92;
    if (Math.abs(orbit.vYaw) + Math.abs(orbit.vPitch) <= 0.0004) {
      orbit.vYaw = 0;
      orbit.vPitch = 0;
    }
    moved = true;
  }

  if (gain > 0) {
    orbit.yaw += SPIN * dt * gain;
    moved = true;
  }
  return moved;
}

export function bindOrbit(
  el: HTMLElement,
  orbit: Orbit,
  opts: {
    getRadius: () => number;
    nearGlobe: (e: PointerEvent) => boolean;
    onDrag: () => void;
    onHover: (e: PointerEvent) => void;
    onLeave: () => void;
    onClick: (e: PointerEvent) => void;
    onIdle: () => void;
    stage: HTMLElement;
    reduce: () => boolean;
  },
): () => void {
  let pointerId: number | null = null;
  let lastX = 0;
  let lastY = 0;
  let lastT = 0;
  let idleTimer = 0;

  const pauseSpin = () => {
    orbit.spinning = false;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = 0;
    }
  };

  const bumpIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = 0;
    }
    if (opts.reduce()) {
      orbit.spinning = false;
      return;
    }
    idleTimer = window.setTimeout(() => {
      idleTimer = 0;
      if (opts.reduce() || orbit.dragging) return;
      orbit.spinning = true;
      opts.onIdle();
    }, IDLE_MS);
  };

  const onDown = (e: PointerEvent) => {
    if (!e.isPrimary && e.pointerType !== "mouse") return;
    if (!opts.nearGlobe(e)) return;
    orbit.dragging = true;
    orbit.moved = false;
    pauseSpin();
    pointerId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = e.timeStamp || Date.now();
    orbit.vYaw = 0;
    orbit.vPitch = 0;
    el.setPointerCapture(e.pointerId);
    opts.stage.classList.add("is-drag");
  };

  const onMove = (e: PointerEvent) => {
    if (!orbit.dragging) {
      el.style.cursor = opts.nearGlobe(e) ? "grab" : "default";
      opts.onHover(e);
      return;
    }
    const dt = Math.max(8, (e.timeStamp || Date.now()) - lastT);
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 3) orbit.moved = true;
    const k = 1.15 / Math.max(80, opts.getRadius());
    const dyaw = dx * k;
    const dpitch = dy * k;
    orbit.yaw += dyaw;
    orbit.pitch = clampPitch(orbit.pitch + dpitch);
    orbit.vYaw = dyaw * (16 / dt);
    orbit.vPitch = dpitch * (16 / dt);
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = e.timeStamp || Date.now();
    opts.onDrag();
  };

  const onUp = (e: PointerEvent) => {
    if (!orbit.dragging) return;
    orbit.dragging = false;
    opts.stage.classList.remove("is-drag");
    try {
      el.releasePointerCapture(pointerId ?? e.pointerId);
    } catch {
      /* already released */
    }
    pointerId = null;
    bumpIdle();
    if (!orbit.moved) opts.onClick(e);
    else opts.onIdle();
  };

  const onLeave = () => {
    if (!orbit.dragging) opts.onLeave();
  };

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("pointerleave", onLeave);
  bumpIdle();

  return () => {
    pauseSpin();
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    el.removeEventListener("pointerleave", onLeave);
    opts.stage.classList.remove("is-drag");
  };
}
