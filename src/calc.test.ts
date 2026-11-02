import { describe, expect, it } from "vitest";
import {
  BOOST_MULT,
  buildPool,
  calibrateBaseEp,
  cheapestWithin,
  expectedPlay,
  lengthBonusPct,
  minutesLeft,
  naturalBoosts,
  parseSamples,
  planFor,
  pointsPerPlay,
  singleLevel,
  solveBaseEp,
  type Level,
  type PlanInput,
  type PointOpts,
} from "./calc";

const exact: PointOpts = { baseEp: 100, memberBonusPct: 0, holopass: false, rounding: "exact" };

describe("boost table", () => {
  it("matches the writeup", () => {
    expect(BOOST_MULT).toEqual([1, 8, 16, 24, 30, 37, 42, 46, 50, 53, 56]);
  });
});

describe("lengthBonusPct (in-game readings, 2026-11-02)", () => {
  it("highlight: 42/54/50/50/42/42% at 0/1/2/3/4/10 boosts, regardless of song", () => {
    for (const len of [60, 104, 126, 166]) {
      expect([0, 1, 2, 3, 4, 10].map((k) => lengthBonusPct(len, k, true))).toEqual([42, 54, 50, 50, 42, 42]);
    }
  });

  it("IDOL / アイドル (126 s): 27% at 0 boosts, 35% at 1 boost", () => {
    expect(lengthBonusPct(126, 0, false)).toBe(27);
    expect(lengthBonusPct(126, 1, false)).toBe(35); // double ceil would give 36
  });

  it("2–3 boosts use ×1.2, 4+ use ×1.0", () => {
    // 104 s: 54 * 0.3446 = 18.6084
    expect(lengthBonusPct(104, 2, false)).toBe(23);
    expect(lengthBonusPct(104, 3, false)).toBe(23);
    expect(lengthBonusPct(104, 4, false)).toBe(19);
    expect(lengthBonusPct(104, 10, false)).toBe(19);
  });

  it("a highlight song longer than the highlight base uses its own length", () => {
    // 200 s: 150 * 0.3446 = 51.69 > 41.4 (no such song exists yet)
    expect(lengthBonusPct(200, 10, true)).toBe(52);
  });

  it("clamps songs under 50 s to 0", () => {
    expect(lengthBonusPct(40, 1, false)).toBe(0);
  });
});

describe("pointsPerPlay", () => {
  it("chains multipliers", () => {
    // 100 * 1.5 * 1.2 * 56 * 2
    expect(pointsPerPlay(10, 20, { ...exact, memberBonusPct: 50, holopass: true })).toBeCloseTo(20160);
  });

  it("floors between steps when asked", () => {
    const o: PointOpts = { baseEp: 33, memberBonusPct: 7, holopass: false, rounding: "floor-each" };
    // floor(35.31)=35, floor(35*1.19=41.65)=41, 41*8=328
    expect(pointsPerPlay(1, 19, o)).toBe(328);
    expect(pointsPerPlay(1, 19, { ...o, rounding: "exact" })).toBeCloseTo(33 * 1.07 * 1.19 * 8);
  });

  it("solveBaseEp inverts the exact chain", () => {
    const pts = pointsPerPlay(4, 25, { ...exact, baseEp: 123, memberBonusPct: 80, holopass: true });
    expect(solveBaseEp(pts, 4, 25, 80, true)).toBeCloseTo(123);
  });
});

describe("calibration", () => {
  it("averages base EP over several plays", () => {
    // base 100 vs 120 at 10 boosts, 20% length, no bonus -> mean 110
    const pts = (b: number) => b * 1.2 * 56;
    const r = calibrateBaseEp([{ points: pts(100) }, { points: pts(120) }], 10, 20, 0, false)!;
    expect(r.baseEp).toBeCloseTo(110);
    expect(r.n).toBe(2);
  });

  it("uses a per-play length bonus when given", () => {
    const r = calibrateBaseEp([{ points: 100 * 1.5 * 56, lengthPct: 50 }], 10, 0, 0, false)!;
    expect(r.baseEp).toBeCloseTo(100);
  });

  it("returns null with no usable plays", () => {
    expect(calibrateBaseEp([{ points: NaN }], 10, 0, 0, false)).toBeNull();
  });

  it("parses lines", () => {
    expect(parseSamples("6720\n12,345, 30%\n\n 7000 25 ")).toEqual([
      { points: 6720 },
      { points: 12345, lengthPct: 30 },
      { points: 7000, lengthPct: 25 },
    ]);
  });
});

describe("pool", () => {
  const s = (length: number) => ({ length });

  it("weights the main song at 50% and averages per song", () => {
    const pool = buildPool(s(104), [s(104), s(166)]);
    expect(pool.map((e) => e.weight)).toEqual([0.5, 0.25, 0.25]);
    const { points, songSec, lengthPct } = expectedPlay(10, { kind: "pool", pool }, exact);
    // every event song is a highlight: 42% at 10 boosts (highlight base beats both lengths)
    const want = 100 * 1.42 * 56;
    expect(lengthPct).toBeCloseTo(42);
    expect(points).toBeCloseTo(want);
    expect(songSec).toBeCloseTo(119.5);
  });
});

describe("time and stamina", () => {
  it("event ends at 11:00 UTC", () => {
    expect(minutesLeft("2026-11-03", new Date(Date.UTC(2026, 10, 2, 17)))).toBe(18 * 60);
    expect(minutesLeft("2026-11-01", new Date(Date.UTC(2026, 10, 2)))).toBe(0);
  });

  it("natural boosts scale with efficiency", () => {
    expect(naturalBoosts(1080, { currentStamina: 5, efficiency: 1 })).toEqual({ regen: 24, total: 29 });
    expect(naturalBoosts(1080, { currentStamina: 0, efficiency: 0.5 }).regen).toBe(12);
  });
});

describe("planning", () => {
  // points per play straight off the boost table (base 1)
  const levels: Level[] = BOOST_MULT.slice(1).map((m, i) => ({ k: i + 1, points: m }));
  const base: PlanInput = { needed: 5600, levels, secPerPlay: 150, maxPlaySec: 1e9, natural: 0, drinks: 0, gems: 0 };

  it("fastest uses 10 boosts", () => {
    const p = planFor("fastest", base, 0);
    expect(p.mix).toEqual([{ k: 10, plays: 100 }]);
    expect(p.boosts).toBe(1000);
  });

  it("cheapest uses the most efficient levels when time is free", () => {
    const p = cheapestWithin(base);
    expect(p.boosts).toBe(700); // 8 pts per boost
    expect(p.mix.every((m) => m.k <= 3)).toBe(true);
  });

  it("balanced respects the play-time budget", () => {
    const budget = 200 * 150; // 200 plays
    const p = planFor("balanced", base, budget);
    expect(p.plays).toBeLessThanOrEqual(200);
    expect(p.points).toBeGreaterThanOrEqual(5600);
    expect(p.feasible).toBe(true);
    // must cost more than unconstrained cheapest, less than all-10s
    expect(p.boosts).toBeGreaterThan(700);
    expect(p.boosts).toBeLessThan(1000);
  });

  it("flags impossible budgets", () => {
    const p = planFor("balanced", base, 50 * 150);
    expect(p.feasible).toBe(false);
  });

  it("0-boost plays are free but cost time", () => {
    const withZero: Level[] = [{ k: 0, points: 1 }, ...levels];
    // plenty of time: everything at 0 boosts
    expect(cheapestWithin({ ...base, levels: withZero }).boosts).toBe(0);
    // 1000 plays of budget: fill with 0-boost plays, top up with boosted ones
    const p = cheapestWithin({ ...base, levels: withZero, maxPlaySec: 1000 * 150 });
    expect(p.plays).toBeLessThanOrEqual(1000);
    expect(p.points).toBeGreaterThanOrEqual(5600);
    expect(p.boosts).toBeLessThan(700);
    expect(p.mix.some((m) => m.k === 0)).toBe(true);
  });

  it("min boosts excludes lower levels", () => {
    const p = cheapestWithin({ ...base, levels: levels.filter((l) => l.k >= 5) });
    expect(p.mix.every((m) => m.k >= 5)).toBe(true);
  });

  it("spends natural boosts, then drinks, then gems", () => {
    const p = singleLevel(10, { ...base, natural: 100, drinks: 400, gems: 3000 });
    expect(p.extraBoosts).toBe(900);
    expect(p.drinksSpent).toBe(400);
    expect(p.gemsSpent).toBe(5000);
    expect(p.gemsShort).toBe(2000);
  });
});
