import { DurableObject } from "cloudflare:workers";
import type { HttpCheck, Region } from "@foxwatch/config";
import { parseColo, runHttpProbe, type ProbeResult } from "@foxwatch/engine";
import type { Env } from "../env.ts";
import { allowHttpLocal } from "../env.ts";

export class Probe extends DurableObject<Env> {
  async run(check: HttpCheck, secrets: Record<string, string | undefined>): Promise<ProbeResult> {
    const cached = await this.ctx.storage.get<{ value: string | null; at: number }>("colo");
    const cacheMs = cached?.value ? 60 * 60 * 1000 : 5 * 60 * 1000;
    const colo = cached && Date.now() - cached.at < cacheMs
      ? cached.value
      : await parseColo(fetch.bind(globalThis));
    if (!cached || Date.now() - cached.at >= cacheMs) {
      await this.ctx.storage.put("colo", { value: colo, at: Date.now() });
    }
    return runHttpProbe(check, {
      secrets,
      allowHttpLocal: allowHttpLocal(this.env),
      fetchImpl: fetch.bind(globalThis),
      colo,
    });
  }
}

export function probeStub(env: Env, region: Region, monitorId: string) {
  const id = env.PROBE.idFromName(`v1:${region}:${monitorId}`);
  return env.PROBE.get(id, { locationHint: region }) as DurableObjectStub<Probe>;
}
