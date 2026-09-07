/** Incident ids are 22-char base64url (`newId`), with slack for older rows. */
export const PUBLIC_INCIDENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Paths the Worker must handle. Everything else (Vite/client assets) goes to ASSETS. */
export function isWorkerPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/history" ||
    pathname === "/incidents" ||
    pathname.startsWith("/incidents/") ||
    pathname === "/badge.svg" ||
    pathname === "/feed.xml" ||
    pathname === "/icon" ||
    pathname === "/live" ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname === "/ops" ||
    pathname.startsWith("/ops/") ||
    pathname.startsWith("/api/")
  );
}
