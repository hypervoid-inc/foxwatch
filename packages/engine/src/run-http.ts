import type { HttpCheck, RunOutcome, SecretRef } from "@foxwatch/config";
import { BODY_READ_LIMIT } from "@foxwatch/config";
import { evaluateHttp } from "./http-assert.ts";
import { redactText, resolveHeaders } from "./secrets.ts";
import { assertSafeUrl, UrlPolicyError } from "./url-policy.ts";

export type ProbeResult = {
  outcome: RunOutcome;
  latencyMs: number;
  statusCode: number | null;
  colo: string | null;
  errorClass?: string;
  errorSnippet?: string;
  /** Redacted response preview for an explicit, non-persisted admin test request. */
  responseSnippet?: string;
};

const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
/** Workers omit User-Agent; hosts like httpbingo.org reject the empty header with 402. */
export const DEFAULT_PROBE_USER_AGENT = "Foxwatch/0.1";

function ensureUserAgent(headers: Record<string, string>): Record<string, string> {
  if (Object.keys(headers).some((key) => key.toLowerCase() === "user-agent")) return headers;
  return { ...headers, "User-Agent": DEFAULT_PROBE_USER_AGENT };
}

/** Requests per run: the first one plus up to five redirects. */
const MAX_HOPS = 6;
/** Headers that describe a request body; they go when a redirect drops the body. */
const BODY_HEADERS = new Set(["content-type", "content-length", "content-encoding", "content-language", "content-location"]);

function withoutBodyHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !BODY_HEADERS.has(name.toLowerCase())));
}

async function readBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      size += value.byteLength;
      if (size > BODY_READ_LIMIT) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
    }
  }
  const buf = new Uint8Array(size > BODY_READ_LIMIT ? BODY_READ_LIMIT : size);
  let offset = 0;
  for (const c of chunks) {
    const n = Math.min(c.byteLength, buf.byteLength - offset);
    buf.set(c.subarray(0, n), offset);
    offset += n;
    if (offset >= buf.byteLength) break;
  }
  return new TextDecoder().decode(buf);
}

function headerMap(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

export async function parseColo(fetchImpl: typeof fetch): Promise<string | null> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 1_500);
  try {
    const res = await fetchImpl(TRACE_URL, { method: "GET", signal: ac.signal });
    const text = await res.text();
    return /colo=([A-Z0-9]+)/i.exec(text)?.[1] ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runHttpProbe(
  check: HttpCheck,
  opts: {
    secrets: Record<string, string | undefined>;
    allowHttpLocal: boolean;
    fetchImpl: typeof fetch;
    colo?: string | null;
  },
): Promise<ProbeResult> {
  let url: URL;
  try {
    url = assertSafeUrl(check.url, { allowHttpLocal: opts.allowHttpLocal });
  } catch (err) {
    return {
      outcome: "fail",
      latencyMs: 0,
      statusCode: null,
      colo: null,
      errorClass: err instanceof UrlPolicyError ? err.code : "invalid_url",
    };
  }

  const colo = "colo" in opts ? opts.colo ?? null : await parseColo(opts.fetchImpl);
  // Location discovery is observer metadata, not target latency.
  const started = Date.now();
  const sensitiveHeader = /authorization|proxy-authorization|api[-_]?key|token|secret|cookie/i;
  const literalHeaderSecrets = Object.entries(check.headers)
    .filter(([name, value]) => sensitiveHeader.test(name) && typeof value === "string")
    .map(([, value]) => value as string);
  const querySecrets = [...url.searchParams.values()].filter((value) => value.length >= 4);
  const secretValues = [
    ...Object.values(opts.secrets).filter((v): v is string => Boolean(v)),
    ...literalHeaderSecrets,
    ...querySecrets,
  ];
  let current = url;
  let headersForHop = resolveHeaders(check.headers as Record<string, string | SecretRef>, opts.secrets, current.hostname, check.allowedHosts);
  if (headersForHop.missingSecret) {
    return {
      outcome: "fail",
      latencyMs: Date.now() - started,
      statusCode: null,
      colo,
      errorClass: "missing_secret",
    };
  }
  headersForHop = { headers: ensureUserAgent(headersForHop.headers) };

  let method = check.method ?? "GET";
  let body = check.method === "POST" ? check.body : undefined;
  let bodyDropped = false;
  let last: Response | null = null;
  const requestController = new AbortController();
  const requestTimeout = setTimeout(() => requestController.abort(), check.timeoutMs);
  try {
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      last = await opts.fetchImpl(current.toString(), {
        method,
        headers: headersForHop.headers,
        body,
        redirect: "manual",
        signal: requestController.signal,
      });

      const loc = last.headers.get("Location");
      if (check.followRedirects && loc && last.status >= 300 && last.status < 400) {
        // Nothing reads a redirect's body; let the connection go.
        await last.body?.cancel().catch(() => undefined);
        const next = new URL(loc, current);
        try {
          assertSafeUrl(next.toString(), { allowHttpLocal: opts.allowHttpLocal });
        } catch (err) {
          return {
            outcome: "fail",
            latencyMs: Date.now() - started,
            statusCode: last.status,
            colo,
            errorClass: err instanceof UrlPolicyError ? err.code : "redirect",
          };
        }
        if (!check.allowedHosts.map((host) => host.toLowerCase()).includes(next.hostname.toLowerCase())) {
          return {
            outcome: "fail",
            latencyMs: Date.now() - started,
            statusCode: last.status,
            colo,
            errorClass: "redirect_host",
          };
        }
        if (hop === MAX_HOPS - 1) {
          // Still redirecting at the cap: a loop, not a response to assert on.
          return {
            outcome: "fail",
            latencyMs: Date.now() - started,
            statusCode: last.status,
            colo,
            errorClass: "redirect",
          };
        }
        // As fetch does: 303 always, and 301/302 after a POST, continue as a GET with no body.
        if ((last.status === 303 && method !== "HEAD") || ((last.status === 301 || last.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
          bodyDropped = true;
        }
        current = next;
        headersForHop = resolveHeaders(
          check.headers as Record<string, string | SecretRef>,
          opts.secrets,
          current.hostname,
          check.allowedHosts,
        );
        headersForHop = {
          headers: ensureUserAgent(bodyDropped ? withoutBodyHeaders(headersForHop.headers) : headersForHop.headers),
        };
        continue;
      }
      break;
    }

    if (!last) {
      return { outcome: "fail", latencyMs: Date.now() - started, statusCode: null, colo, errorClass: "connect" };
    }

    const responseBody = await readBody(last);
    const latencyMs = Date.now() - started;
    const evald = evaluateHttp({
      status: last.status,
      headers: headerMap(last.headers),
      body: responseBody,
      latencyMs,
      expect: check.expect,
      timeoutMs: check.timeoutMs,
      degradedIf: check.degradedIf,
    });
    return {
      outcome: evald.outcome,
      latencyMs,
      statusCode: last.status,
      colo,
      errorClass: evald.errorClass,
      errorSnippet: evald.outcome === "pass" ? undefined : redactText(responseBody, secretValues),
      responseSnippet: redactText(responseBody, secretValues).slice(0, 2000),
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      outcome: "fail",
      latencyMs: Date.now() - started,
      statusCode: null,
      colo,
      errorClass: aborted ? "timeout" : "connect",
    };
  } finally {
    clearTimeout(requestTimeout);
  }
}
