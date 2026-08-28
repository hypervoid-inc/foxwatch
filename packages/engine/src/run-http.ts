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

  let last: Response | null = null;
  const requestController = new AbortController();
  const requestTimeout = setTimeout(() => requestController.abort(), check.timeoutMs);
  try {
    for (let hop = 0; hop < 6; hop++) {
      last = await opts.fetchImpl(current.toString(), {
        method: check.method ?? "GET",
        headers: headersForHop.headers,
        body: check.method === "POST" ? check.body : undefined,
        redirect: "manual",
        signal: requestController.signal,
      });

      const loc = last.headers.get("Location");
      if (check.followRedirects && loc && last.status >= 300 && last.status < 400) {
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
        current = next;
        headersForHop = resolveHeaders(
          check.headers as Record<string, string | SecretRef>,
          opts.secrets,
          current.hostname,
          check.allowedHosts,
        );
        continue;
      }
      break;
    }

    if (!last) {
      return { outcome: "fail", latencyMs: Date.now() - started, statusCode: null, colo, errorClass: "connect" };
    }

    const body = await readBody(last);
    const latencyMs = Date.now() - started;
    const evald = evaluateHttp({
      status: last.status,
      headers: headerMap(last.headers),
      body,
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
      errorSnippet: evald.outcome === "pass" ? undefined : redactText(body, secretValues),
      responseSnippet: redactText(body, secretValues).slice(0, 2000),
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
