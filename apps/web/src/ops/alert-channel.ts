const MAX_ID = 63;

/** `id` when no channel has it, otherwise the same name with the first free number on the end. */
export function uniqueChannelId(id: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(id)) return id;
  const base = id.replace(/-\d+$/, "") || id;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX_ID - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
