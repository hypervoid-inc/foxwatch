import type { HttpExpect, RunOutcome } from "@foxwatch/config";

const MAX_PATTERN = 80;
const MAX_JSONPATH = 64;

function statusOk(got: number, expected?: number | number[]): boolean {
  if (expected == null) return got >= 200 && got < 400;
  const list = Array.isArray(expected) ? expected : [expected];
  return list.includes(got);
}

function walkJsonPath(data: unknown, path: string): unknown {
  if (!path.startsWith("$") || path.length > MAX_JSONPATH) {
    throw new Error("jsonpath_invalid");
  }
  if (/[*{}()]|\.\./.test(path)) throw new Error("jsonpath_invalid");
  const parts = path
    .slice(1)
    .split(".")
    .flatMap((p) => {
      const m = /^([A-Za-z0-9_]+)?(?:\[(\d+)\])?$/.exec(p);
      if (!m || (p && !m[0])) return [];
      const out: Array<string | number> = [];
      if (m[1]) out.push(m[1]);
      if (m[2]) out.push(Number(m[2]));
      return out;
    });
  let cur: unknown = data;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part as string];
  }
  return cur;
}

function safeIncludes(haystack: string, needle: string): boolean {
  if (needle.length > MAX_PATTERN) return false;
  return haystack.includes(needle);
}

export type HttpEvalInput = {
  status: number;
  headers: Record<string, string>;
  body: string;
  latencyMs: number;
  expect: HttpExpect;
  degradedIf?: { latencyMs: number };
};

export type HttpEvalResult = {
  outcome: RunOutcome;
  errorClass?: string;
  reason?: string;
};

export function evaluateHttp(input: HttpEvalInput): HttpEvalResult {
  if (!statusOk(input.status, input.expect.status)) {
    return { outcome: "fail", errorClass: "status", reason: `status ${input.status}` };
  }
  if (input.expect.header) {
    const lower = Object.fromEntries(
      Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    for (const [k, v] of Object.entries(input.expect.header)) {
      if (lower[k.toLowerCase()] !== v) {
        return { outcome: "fail", errorClass: "header", reason: `header ${k}` };
      }
    }
  }
  if (input.expect.bodyIncludes && !safeIncludes(input.body, input.expect.bodyIncludes)) {
    return { outcome: "fail", errorClass: "body", reason: "body mismatch" };
  }
  if (input.expect.jsonPath) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.body);
    } catch {
      return { outcome: "fail", errorClass: "json", reason: "invalid json" };
    }
    let value: unknown;
    try {
      value = walkJsonPath(parsed, input.expect.jsonPath.path);
    } catch {
      return { outcome: "fail", errorClass: "jsonpath", reason: "invalid jsonpath" };
    }
    if (input.expect.jsonPath.exists && value === undefined) {
      return { outcome: "fail", errorClass: "jsonpath", reason: "missing path" };
    }
    if (input.expect.jsonPath.equals !== undefined && value !== input.expect.jsonPath.equals) {
      return { outcome: "fail", errorClass: "jsonpath", reason: "value mismatch" };
    }
  }
  if (input.degradedIf && input.latencyMs > input.degradedIf.latencyMs) {
    return { outcome: "degraded", errorClass: "latency", reason: `latency ${input.latencyMs}ms` };
  }
  return { outcome: "pass" };
}
