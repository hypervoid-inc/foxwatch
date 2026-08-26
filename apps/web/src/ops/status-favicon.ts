import { statusDotColor } from "@foxwatch/engine";

const SIZE = 64;
const ICON = 50;
const ICON_ORIGIN = (SIZE - ICON) / 2;
const DOT_R = 8;
const DOT_STROKE = 3;
const DOT_OVERLAP = 3;
const DOT_RING = "#f7f4ee";
const SQUIRCLE_N = 5;

let gen = 0;
let lastKey = "";

function clipSquircle(ctx: CanvasRenderingContext2D, ox: number, oy: number, size: number) {
  const steps = 64;
  const r = size / 2;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const x = ox + r + Math.sign(c) * r * Math.pow(Math.abs(c), 2 / SQUIRCLE_N);
    const y = oy + r + Math.sign(s) * r * Math.pow(Math.abs(s), 2 / SQUIRCLE_N);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.clip();
}

export function applyStatusFavicon(src: string, banner: string) {
  const key = `${src}|${banner}`;
  if (key === lastKey) return;
  const my = ++gen;
  const img = new Image();
  img.onload = () => {
    if (my !== gen) return;
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const iw = img.naturalWidth || ICON;
    const ih = img.naturalHeight || ICON;
    const scale = Math.max(ICON / iw, ICON / ih);
    const w = iw * scale;
    const h = ih * scale;
    ctx.save();
    clipSquircle(ctx, ICON_ORIGIN, ICON_ORIGIN, ICON);
    ctx.drawImage(img, ICON_ORIGIN + (ICON - w) / 2, ICON_ORIGIN + (ICON - h) / 2, w, h);
    ctx.restore();
    const x = Math.min(SIZE - DOT_R - DOT_STROKE / 2, ICON_ORIGIN + ICON - DOT_OVERLAP);
    const y = x;
    ctx.beginPath();
    ctx.arc(x, y, DOT_R, 0, Math.PI * 2);
    ctx.fillStyle = statusDotColor(banner);
    ctx.fill();
    ctx.lineWidth = DOT_STROKE;
    ctx.strokeStyle = DOT_RING;
    ctx.stroke();
    for (const el of document.querySelectorAll('link[rel="icon"]')) el.remove();
    const link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/png";
    link.href = canvas.toDataURL("image/png");
    document.head.appendChild(link);
    lastKey = key;
  };
  img.onerror = () => {
    if (my === gen) lastKey = "";
  };
  img.src = src;
}
