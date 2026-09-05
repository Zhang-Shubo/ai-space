import { describe, expect, test } from "bun:test";
import { type Candidate, isoWeek, month, selectRetained } from "./retention.ts";

const day = 86400_000;
const t0 = Date.UTC(2026, 8, 5, 3, 0, 0); // Saturday 2026-09-05

/** One snapshot per day for `n` days ending at t0, newest last. */
function daily(n: number): Candidate[] {
  return Array.from({ length: n }, (_, i) => ({ key: `app/d${i}`, at: t0 - (n - 1 - i) * day }));
}

describe("selectRetained", () => {
  test("keeps the newest daily snapshots", () => {
    const { keep, drop } = selectRetained(daily(10), { daily: 3, weekly: 0, monthly: 0 });
    expect(keep).toEqual(["app/d9", "app/d8", "app/d7"]);
    expect(drop).toHaveLength(7);
  });

  test("keeps the first snapshot of each of the newest weeks", () => {
    const { keep } = selectRetained(daily(21), { daily: 0, weekly: 2, monthly: 0 });
    // d20 = Sat 2026-09-05. ISO weeks are Monday-based: W36 starts Mon 08-31 (= d15), W35 starts Mon 08-24 (= d8).
    expect(keep).toEqual(["app/d15", "app/d8"]);
  });

  test("keeps the first snapshot of each of the newest months", () => {
    const { keep } = selectRetained(daily(40), { daily: 0, weekly: 0, monthly: 2 });
    // d39 = 2026-09-05, so d35 = 09-01 and d4 = 08-01; July (d0..d3) is the third month and falls out.
    expect(keep).toEqual(["app/d35", "app/d4"]);
  });

  test("one snapshot can fill several slots and nothing is counted twice", () => {
    const { keep, drop } = selectRetained(daily(2), { daily: 7, weekly: 4, monthly: 6 });
    expect(keep).toEqual(["app/d1", "app/d0"]);
    expect(drop).toEqual([]);
  });

  test("a machine that was off for a month keeps history on its first run back", () => {
    const old = daily(7).map((c) => ({ ...c, at: c.at - 40 * day }));
    const fresh = { key: "app/new", at: t0 };
    const { drop } = selectRetained([...old, fresh], { daily: 7, weekly: 4, monthly: 6 });
    expect(drop).toEqual([]);
  });

  test("failed snapshots never fill a slot and are dropped, unless nothing else is left", () => {
    const cands = daily(3).map((c, i) => ({ ...c, failed: i === 2 }));
    const { keep, drop } = selectRetained(cands, { daily: 2, weekly: 0, monthly: 0 });
    expect(keep).toEqual(["app/d1", "app/d0"]);
    expect(drop).toEqual(["app/d2"]);
    expect(selectRetained([{ key: "only", at: t0, failed: true }], { daily: 1, weekly: 0, monthly: 0 }).keep).toEqual(["only"]);
  });
});

describe("periods", () => {
  test("iso weeks and months in UTC", () => {
    expect(isoWeek(Date.UTC(2026, 0, 1))).toBe("2026-W01");
    expect(isoWeek(Date.UTC(2027, 0, 1))).toBe("2026-W53");
    expect(isoWeek(t0)).toBe("2026-W36");
    expect(month(t0)).toBe("2026-09");
  });
});
