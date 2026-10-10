import { describe, expect, it } from "vitest";
import { isAlreadyExists, parseJsonBlob, queueNames, wranglerError } from "./run.mjs";

describe("wrangler output", () => {
  it("finds the JSON after a banner line", () => {
    expect(parseJsonBlob(' wrangler 4.34.0\n[{"name":"foxwatch-data"}]')).toEqual([{ name: "foxwatch-data" }]);
    expect(() => parseJsonBlob("no json here")).toThrow(/Expected JSON/);
  });

  it("keeps stderr on a failure, where the reason is printed", () => {
    const err = wranglerError(["queues", "create", "foxwatch-alerts"], {
      stdout: "Creating queue 'foxwatch-alerts'.\n",
      stderr: "X [ERROR] Queue name 'foxwatch-alerts' is already taken. [code: 11009]\n",
      status: 1,
    });
    expect(err.status).toBe(1);
    expect(isAlreadyExists(err.output)).toBe(true);
    expect(err.message).toContain("already taken");
    expect(isAlreadyExists(wranglerError(["queues", "create", "q"], { stdout: "", stderr: "Authentication error [code: 10000]", status: 1 }).output)).toBe(false);
  });

  it("names the command when Wrangler says nothing", () => {
    expect(wranglerError(["queues", "list"], { stdout: "", stderr: "", status: 1 }).message).toBe("wrangler queues list failed");
  });
});

describe("queue names", () => {
  it("reads whole names from the printed table", () => {
    const table = [
      "┌──────────────────────────────────┬─────────────────────┬───────────┐",
      "│ id                               │ name                │ producers │",
      "│ 0123456789abcdef0123456789abcdef │ foxwatch-alerts-dlq │ 1         │",
      "└──────────────────────────────────┴─────────────────────┴───────────┘",
    ].join("\n");
    expect(queueNames(table)).toContain("foxwatch-alerts-dlq");
    expect(queueNames(table)).not.toContain("foxwatch-alerts");
    expect(queueNames(table.replace("foxwatch-alerts-dlq", "foxwatch-alerts    "))).toContain("foxwatch-alerts");
  });

  it("reads JSON in the shapes Wrangler has used", () => {
    expect(queueNames('[{"queue_name":"foxwatch-alerts"},{"queue_name":"other"}]')).toEqual(["foxwatch-alerts", "other"]);
    expect(queueNames('{"queues":[{"name":"foxwatch-alerts-dlq"}]}')).toEqual(["foxwatch-alerts-dlq"]);
    expect(queueNames("")).toEqual([]);
  });
});
