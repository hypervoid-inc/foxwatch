import { describe, expect, it } from "vitest";
import { appendIncidents, incidentRefreshLimit, incidentsPath, incidentUpdatePayload, mergeRefreshedIncidents } from "./incident-list.ts";

describe("admin incident list", () => {
  it("asks for the first page, or the page after a cursor", () => {
    expect(incidentsPath()).toBe("/api/ops/incidents?limit=50");
    expect(incidentsPath({ cursor: "1700000000000:abc" })).toBe("/api/ops/incidents?limit=50&cursor=1700000000000%3Aabc");
    expect(incidentsPath({ limit: 120 })).toBe("/api/ops/incidents?limit=120");
  });

  it("refreshes as many resolved incidents as are on screen, within the endpoint's limit", () => {
    expect(incidentRefreshLimit(0)).toBe(50);
    expect(incidentRefreshLimit(50)).toBe(50);
    expect(incidentRefreshLimit(150)).toBe(150);
    expect(incidentRefreshLimit(900)).toBe(200);
  });

  it("appends an older page without repeating an incident", () => {
    expect(appendIncidents([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }])).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
  });

  it("keeps incidents older than a refreshed page on screen, with their cursor", () => {
    const row = (n: number) => ({ id: `i${n}`, startedAt: n });
    const current = { resolved: [row(5), row(4), row(3), row(2), row(1)], nextCursor: "1:i1" };
    // A newly resolved incident pushes the fresh page down by one; the older rows stay.
    const merged = mergeRefreshedIncidents(current, { resolved: [row(6), row(5), row(4)], nextCursor: "4:i4" });
    expect(merged.resolved.map((i) => i.id)).toEqual(["i6", "i5", "i4", "i3", "i2", "i1"]);
    expect(merged.nextCursor).toBe("1:i1");
  });

  it("takes the fresh page as it is when it covers everything on screen", () => {
    const row = (n: number) => ({ id: `i${n}`, startedAt: n });
    const current = { resolved: [row(3), row(2)], nextCursor: "2:i2" };
    expect(mergeRefreshedIncidents(current, { resolved: [row(4), row(3), row(2)], nextCursor: "2:i2" })).toEqual({
      resolved: [row(4), row(3), row(2)],
      nextCursor: "2:i2",
    });
    // Without a cursor the fresh page is the whole history, so nothing older can be left.
    expect(mergeRefreshedIncidents({ resolved: [row(3), row(2), row(1)], nextCursor: null }, { resolved: [row(3)], nextCursor: null })).toEqual({
      resolved: [row(3)],
      nextCursor: null,
    });
    expect(mergeRefreshedIncidents(current, { resolved: [], nextCursor: null })).toEqual({ resolved: [], nextCursor: null });
  });

  it("drops a kept incident that was removed from the fresh page or reopened", () => {
    const row = (n: number, id = `i${n}`) => ({ id, startedAt: n });
    const current = { resolved: [row(5), row(4), row(3), row(2), row(2, "i1")], nextCursor: "2:i1" };
    // i4 is gone from the fresh page, and i2 is open again.
    const merged = mergeRefreshedIncidents(current, { resolved: [row(5), row(3)], nextCursor: "3:i3" }, ["i2"]);
    expect(merged.resolved.map((i) => i.id)).toEqual(["i5", "i3", "i1"]);
    // Incidents that started in the same millisecond are ordered by id.
    const tied = mergeRefreshedIncidents(current, { resolved: [row(5), row(4), row(3), row(2)], nextCursor: "2:i2" });
    expect(tied.resolved.map((i) => i.id)).toEqual(["i5", "i4", "i3", "i2", "i1"]);
  });

  it("sends an update's status only when the operator picked one", () => {
    expect(incidentUpdatePayload({ status: null, body: "Still looking.", notify: true })).toEqual({ body: "Still looking.", notify: true });
    expect("status" in incidentUpdatePayload({ status: null, body: "Still looking.", notify: false })).toBe(false);
    expect(incidentUpdatePayload({ status: "monitoring", body: "Fix is out.", notify: false })).toEqual({ status: "monitoring", body: "Fix is out.", notify: false });
  });
});
