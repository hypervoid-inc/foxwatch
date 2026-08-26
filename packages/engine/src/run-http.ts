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
      if (size > BODY_READ_LIMIT) break;
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
  try {
    const res = await fetchImpl(TRACE_URL, { method: "GET" });
    const text = await res.text();
    return /colo=([A-Z0-9]+)/i.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function runHttpProbe(
  check: HttpCheck,
  opts: {
    secrets: Record<string, string | undefined>;
    allowHttpLocal: boolean;
    fetchImpl: typeof fetch;
  },
): Promise<ProbeResult> {
  const started = Date.now();
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

  const colo = await parseColo(opts.fetchImpl);
  const secretValues = Object.values(opts.secrets).filter((v): v is string => Boolean(v));
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
  try {
    for (let hop = 0; hop < 6; hop++) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), check.timeoutMs);
      try {
        last = await opts.fetchImpl(current.toString(), {
          method: check.method ?? "GET",
          headers: headersForHop.headers,
          body: check.method === "POST" ? check.body : undefined,
          redirect: "manual",
          signal: ac.signal,
        });
      } finally {
        clearTimeout(t);
      }

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
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      outcome: "fail",
      latencyMs: Date.now() - started,
      statusCode: null,
      colo,
      errorClass: aborted ? "timeout" : "connect",
    };
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
    degradedIf: check.degradedIf,
  });
  return {
    outcome: evald.outcome,
    latencyMs,
    statusCode: last.status,
    colo,
    errorClass: evald.errorClass,
    errorSnippet: evald.outcome === "pass" ? undefined : redactText(body, secretValues),
  };
}
