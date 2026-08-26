import { isSecretRef, secretName, type SecretRef } from "@foxwatch/config";
import { assertSafeUrl } from "./url-policy.ts";

const FORBIDDEN = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cookie",
  "cookie2",
  "set-cookie",
]);

export function stripForbiddenHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN.has(lower) || lower.startsWith("cf-") || lower.startsWith("x-forwarded")) continue;
    out[key] = value;
  }
  return out;
}

export function shouldAttachSecrets(hostname: string, allowedHosts: string[]): boolean {
  return allowedHosts.map((h) => h.toLowerCase()).includes(hostname.toLowerCase());
}

export function resolveHeaders(
  headers: Record<string, string | SecretRef>,
  env: Record<string, string | undefined>,
  hostname: string,
  allowedHosts: string[],
): { headers: Record<string, string>; missingSecret?: string } {
  const attach = shouldAttachSecrets(hostname, allowedHosts);
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (isSecretRef(value) || secretName(value)) {
      if (!attach) continue;
      const name = secretName(value)!;
      const secret = env[name];
      if (!secret) return { headers: {}, missingSecret: name };
      resolved[key] = secret;
    } else if (typeof value === "string") {
      resolved[key] = value;
    }
  }
  return { headers: stripForbiddenHeaders(resolved) };
}

const REDACT_KEYS = /authorization|bearer|cookie|set-cookie|api[_-]?key|token|secret|password/i;

export function redactText(input: string, extra: string[] = []): string {
  let out = input;
  for (const secret of extra) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join("[redacted]");
    }
  }
  out = out.replace(REDACT_KEYS, "[redacted]");
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  return out.slice(0, 2048);
}

export function assertAlertUrl(url: string): URL {
  return assertSafeUrl(url, { allowHttpLocal: false });
}
