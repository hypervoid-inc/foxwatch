import { DurableObject } from "cloudflare:workers";
import type { HttpCheck, Region } from "@foxwatch/config";
import { runHttpProbe, type ProbeResult } from "@foxwatch/engine";
import type { Env } from "../env.ts";
import { allowHttpLocal } from "../env.ts";

export class Probe extends DurableObject<Env> {
  async run(check: HttpCheck, secrets: Record<string, string | undefined>): Promise<ProbeResult> {
    return runHttpProbe(check, {
      secrets,
      allowHttpLocal: allowHttpLocal(this.env),
      fetchImpl: fetch.bind(globalThis),
    });
  }
}

export function probeStub(env: Env, region: Region, monitorId: string) {
  const id = env.PROBE.idFromName(`v1:${region}:${monitorId}`);
  return env.PROBE.get(id, { locationHint: region }) as DurableObjectStub<Probe>;
}
