import { sanitizeText } from "@foxwatch/engine";

export type VisitorHere = {
  colo: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
};

function parseCoord(value: unknown, min: number, max: number): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n * 1000) / 1000;
}

function sanitizeColo(value: string | null | undefined): string | null {
  if (!value) return null;
  const colo = value.trim().toUpperCase();
  return /^[A-Z0-9]{3,4}$/.test(colo) ? colo : null;
}

export function visitorFromRequest(req: Request): VisitorHere {
  const cf = req.cf as
    | { colo?: string; city?: string; latitude?: string | number; longitude?: string | number }
    | undefined;
  let colo = sanitizeColo(cf?.colo);
  if (!colo) {
    const ray = req.headers.get("CF-Ray") ?? "";
    const match = /^[0-9a-f]+-([A-Z0-9]{3,4})$/i.exec(ray);
    colo = sanitizeColo(match?.[1]);
  }
  const cityRaw = (cf?.city || req.headers.get("CF-IPCity") || "").trim();
  const city = cityRaw ? sanitizeText(cityRaw, 80) : null;
  return {
    colo,
    city: city || null,
    lat: parseCoord(cf?.latitude ?? req.headers.get("CF-IPLatitude"), -90, 90),
    lng: parseCoord(cf?.longitude ?? req.headers.get("CF-IPLongitude"), -180, 180),
  };
}
