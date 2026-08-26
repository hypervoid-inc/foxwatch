export class UrlPolicyError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "UrlPolicyError";
  }
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function ipv4ToInt(parts: number[]): number {
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inCidr(ip: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) === (base & mask);
}

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;

  const v4 = parseIpv4(host);
  if (v4) {
    const ip = ipv4ToInt(v4);
    if (inCidr(ip, ipv4ToInt([127, 0, 0, 0]), 8)) return true;
    if (inCidr(ip, ipv4ToInt([10, 0, 0, 0]), 8)) return true;
    if (inCidr(ip, ipv4ToInt([172, 16, 0, 0]), 12)) return true;
    if (inCidr(ip, ipv4ToInt([192, 168, 0, 0]), 16)) return true;
    if (inCidr(ip, ipv4ToInt([169, 254, 0, 0]), 16)) return true;
    if (inCidr(ip, ipv4ToInt([0, 0, 0, 0]), 8)) return true;
    if (inCidr(ip, ipv4ToInt([100, 64, 0, 0]), 10)) return true;
  }
  return false;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  const v4 = parseIpv4(host);
  if (v4 && inCidr(ipv4ToInt(v4), ipv4ToInt([127, 0, 0, 0]), 8)) return true;
  return false;
}

export function assertSafeUrl(
  urlStr: string,
  opts: { allowHttpLocal?: boolean } = {},
): URL {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new UrlPolicyError("invalid_url");
  }
  if (url.username || url.password) {
    throw new UrlPolicyError("userinfo_forbidden");
  }
  const httpLocal = Boolean(opts.allowHttpLocal) && isLoopbackHost(url.hostname);
  if (url.protocol === "http:") {
    if (!httpLocal) throw new UrlPolicyError("https_required");
  } else if (url.protocol !== "https:") {
    throw new UrlPolicyError("https_required");
  }
  if (isPrivateHostname(url.hostname) && !httpLocal) {
    throw new UrlPolicyError("private_address");
  }
  return url;
}

/** Link target for the public header — not fetched by the worker. */
export function parseHomepageUrl(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") throw new UrlPolicyError("invalid_url");
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > 2048) throw new UrlPolicyError("invalid_url");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new UrlPolicyError("invalid_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UrlPolicyError("invalid_url");
  if (url.username || url.password) throw new UrlPolicyError("userinfo_forbidden");
  return url.toString();
}
