/** Paths the Worker must handle. Everything else (Vite/client assets) goes to ASSETS. */
export function isWorkerPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/history" ||
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
