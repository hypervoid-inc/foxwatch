import { isReservedSecretName, secretName, SECRET_NAME_RE, type Check } from "@foxwatch/config";
import type { OpsRole } from "../auth/ops.ts";

export function secretNamesFromCheck(check: Check): string[] {
  if (check.type !== "http") return [];
  return [
    ...new Set(
      Object.values(check.headers ?? {})
        .map((v) => secretName(v))
        .filter((n): n is string => Boolean(n)),
    ),
  ];
}

/**
 * A secret value is only ever read for a well-formed name that is not one of
 * Foxwatch's own bindings and that sits in the registry kept in settings.
 */
export function isResolvableSecret(name: string, registered: readonly string[]): boolean {
  return SECRET_NAME_RE.test(name) && !isReservedSecretName(name) && registered.includes(name);
}

export type SecretRefError = "secret_unknown" | "secret_request";

/**
 * Everything that decides where a secret goes and what it is spent on. The
 * host alone is not enough: on a shared API host another path, method or body
 * reads or writes whatever the credential can reach.
 */
function secretRequestKey(check: Check): string | null {
  if (check.type !== "http") return null;
  let url = check.url;
  try {
    url = new URL(check.url).href;
  } catch { /* compared as written */ }
  const headers = Object.entries(check.headers ?? {})
    .map(([name, value]): [string, string] => [name.toLowerCase(), secretName(value) ? `secret:${secretName(value)}` : `text:${String(value)}`])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hosts = [...new Set((check.allowedHosts ?? []).map((host) => host.toLowerCase()))].sort();
  return JSON.stringify([url, check.method ?? "GET", check.body ?? "", headers, hosts]);
}

/**
 * Secrets are superadmin territory. Other operators may keep, copy or try a
 * request that carries one, but only exactly as an existing check already
 * sends it: same URL, method, body, headers and allowed hosts. Otherwise any
 * admin could aim the secret at their own host, or at another resource on a
 * trusted host, and read the answer.
 */
export function secretRefError(
  check: Check,
  use: { role: OpsRole; registered: readonly string[]; existing: readonly Check[] },
): SecretRefError | null {
  const names = secretNamesFromCheck(check);
  if (check.type !== "http" || names.length === 0 || use.role === "superadmin") return null;
  if (names.some((name) => !isResolvableSecret(name, use.registered))) return "secret_unknown";
  const request = secretRequestKey(check);
  return use.existing.some((other) => secretRequestKey(other) === request) ? null : "secret_request";
}
