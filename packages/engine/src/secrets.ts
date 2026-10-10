import { isBlockedHeader, isSecretRef, secretName, SNIPPET_LIMIT, type SecretRef } from "@foxwatch/config";
import { assertSafeUrl } from "./url-policy.ts";

const SENSITIVE = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token)$/i;

export function stripForbiddenHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    // Validation rejects these up front; rows saved before that still get them dropped.
    if (isBlockedHeader(key)) continue;
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
      // Match browser redirect safety: never forward credential-like literal
      // headers to a host outside the explicit allowlist.
      if (!attach && SENSITIVE.test(key)) continue;
      resolved[key] = value;
    }
  }
  return { headers: stripForbiddenHeaders(resolved) };
}

// Credential-looking keys in JSON, form, query and header shapes. The key stays
// so the snippet is still readable; only its value is replaced. The match starts
// at the keyword and the rest of the key is capped: an open-ended run on either
// side backtracks badly on bodies that repeat a keyword with no value after it.
const REDACT_KEY = "(?:token|secret|passw(?:or)?d|api[_-]?key|authorization|cookie|credential|private[_-]?key|session[_-]?id|signature)";
const REDACT_PAIR = new RegExp(
  `(${REDACT_KEY}[\\w.-]{0,64}\\\\?["']?\\s*[:=]\\s*)` +
    `(\\\\"[^"\\\\]*(?:\\\\"|$)|"(?:[^"\\\\]|\\\\.)*(?:"|$)|'[^']*(?:'|$)|(?:(?:Bearer|Basic)\\s+)?[^\\s,;&{}\\[\\]"']+)`,
  "gi",
);
const REDACT_COOKIE_LINE = /\b((?:set-)?cookie2?\s*:\s*)[^\r\n"]+/gi;
// Header shapes carry values with spaces (`Authorization: Token abc`, a pass
// phrase), which the pair pass would cut at the first one. Authorization is
// redacted to end of line wherever it sits; other keys only when they open the line.
const REDACT_AUTH_LINE = /\b((?:proxy-)?authorization[ \t]*:[ \t]*)[^\r\n"]+/gi;
const REDACT_HEADER_LINE = new RegExp(`^([ \\t]*[\\w.-]{0,64}?${REDACT_KEY}[\\w.-]{0,64}[ \\t]*:[ \\t]+)[^\\r\\n"]+`, "gim");
const REDACT_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const REDACT_JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g;
const REDACT_HEX = /\b[A-Fa-f0-9]{32,}\b/g;

export function redactText(input: string, extra: string[] = []): string {
  let out = input;
  for (const secret of extra) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join("[redacted]");
    }
  }
  // Known values are gone from the whole body; pattern passes only need the
  // part that can be stored, which also bounds their cost on large bodies.
  out = out.slice(0, SNIPPET_LIMIT);
  out = out.replace(REDACT_COOKIE_LINE, "$1[redacted]");
  out = out.replace(REDACT_AUTH_LINE, "$1[redacted]");
  out = out.replace(REDACT_HEADER_LINE, "$1[redacted]");
  out = out.replace(REDACT_PAIR, "$1[redacted]");
  out = out.replace(REDACT_SCHEME, "$1 [redacted]");
  out = out.replace(REDACT_JWT, "[redacted]");
  out = out.replace(REDACT_HEX, "[redacted]");
  return out.slice(0, SNIPPET_LIMIT);
}

export function assertAlertUrl(url: string): URL {
  return assertSafeUrl(url, { allowHttpLocal: false });
}
