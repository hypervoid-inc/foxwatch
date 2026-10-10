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

function isPrivateIpv4(parts: number[]): boolean {
  const ip = ipv4ToInt(parts);
  if (inCidr(ip, ipv4ToInt([127, 0, 0, 0]), 8)) return true;
  if (inCidr(ip, ipv4ToInt([10, 0, 0, 0]), 8)) return true;
  if (inCidr(ip, ipv4ToInt([172, 16, 0, 0]), 12)) return true;
  if (inCidr(ip, ipv4ToInt([192, 168, 0, 0]), 16)) return true;
  if (inCidr(ip, ipv4ToInt([169, 254, 0, 0]), 16)) return true;
  if (inCidr(ip, ipv4ToInt([0, 0, 0, 0]), 8)) return true;
  if (inCidr(ip, ipv4ToInt([100, 64, 0, 0]), 10)) return true;
  return false;
}

/** Expand an IPv6 literal (no brackets) into its eight 16-bit groups. */
function parseIpv6(host: string): number[] | null {
  let text = host;
  const tail: number[] = [];
  if (text.includes(".")) {
    // Dotted IPv4 tail, as in ::ffff:127.0.0.1.
    const cut = text.lastIndexOf(":");
    const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(text.slice(cut + 1)) ? parseIpv4(text.slice(cut + 1)) : null;
    if (!v4) return null;
    tail.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
    text = text.slice(0, cut + 1);
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !rest) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 2 ? known > 7 : known !== 8) return null;
  return [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail];
}

function isPrivateIpv6(host: string): boolean {
  const g = parseIpv6(host);
  // A literal we cannot read is never fetched.
  if (!g) return true;
  const embedded = (hi: number, lo: number) => isPrivateIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  const zeroTo = (n: number) => g.slice(0, n).every((part) => part === 0);
  // ::/96 covers the unspecified address, ::1 and IPv4-compatible forms.
  if (zeroTo(6)) return embedded(g[6]!, g[7]!);
  // ::ffff:0:0/96, IPv4-mapped.
  if (zeroTo(5) && g[5] === 0xffff) return embedded(g[6]!, g[7]!);
  // 64:ff9b::/96 NAT64, and its local-use block 64:ff9b:1::/48.
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 1) return true;
    if (g.slice(2, 6).every((part) => part === 0)) return embedded(g[6]!, g[7]!);
  }
  // 2002::/16, 6to4.
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!);
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  // Kept from the old prefix rule so nothing it blocked gets through.
  if (host.startsWith("fc") || host.startsWith("fd")) return true;
  return false;
}

export function isPrivateHostname(hostname: string): boolean {
  // A trailing dot is the same name: "localhost." resolves like "localhost".
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.+$/, "");
  if (host.includes(":")) return isPrivateIpv6(host);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return true;

  const v4 = parseIpv4(host);
  return v4 ? isPrivateIpv4(v4) : false;
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

/** Link target for the public header, not fetched by the worker. */
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

/** Address the status page is served from, kept as an origin. It is linked from alerts, not fetched by the worker. */
export function parsePublicUrl(raw: unknown): string | null {
  const parsed = parseHomepageUrl(raw);
  return parsed ? new URL(parsed).origin : null;
}
