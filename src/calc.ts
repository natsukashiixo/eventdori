// Pure event-point math. No DOM here so it can be unit tested.
// Every multiplier stays a separate factor so "what if my bonus % changes"
// is just a re-run, never a reverse-normalisation.

/**
 * Event-point multiplier per boost count (index = boosts used).
 * 0 boosts (×1) only happens when stamina is empty: you can't pick 0 while holding stamina.
 */
export const BOOST_MULT = [1, 8, 16, 24, 30, 37, 42, 46, 50, 53, 56] as const;
export const MAX_BOOST = 10;
export const GEMS_PER_BOOST = 10;
export const REGEN_MINUTES = 45;
export const EVENT_END_HOUR_UTC = 11;

export type Rounding = "floor-each" | "exact";

/** Guarded ceil: float noise like 34.000000000004 must not round up to 35. */
const ceil = (x: number) => Math.max(0, Math.ceil(x - 1e-9));

/**
 * Length-bonus multiplier by boost count: 1.3 on 1 boost, 1.2 on 2–3 boosts, 1.0 otherwise (0 included).
 * Verified in game 2026-11-02 (highlight 42/54/50/50/42% at 0/1/2/3/4+ boosts; IDOL 126 s 27% at 0, 35% at 1).
 */
export function boostFactor(k: number): number {
  if (k === 1) return 1.3;
  if (k === 2 || k === 3) return 1.2;
  return 1;
}

/**
 * Highlight songs use a fixed base bonus instead of their own length, unless the song's own base is higher.
 * In-game readings pin it to (41, 41.54]; every value in that range gives the same results.
 * The old "highlights are always 50%" rule was just the 2–3 boost reading (ceil(41.4 × 1.2) = 50).
 */
export const HIGHLIGHT_BASE_PCT = 41.4;

/** Song length bonus in percent at k boosts: CEIL(base × boostFactor), single ceil (double ceil gives IDOL 36% at 1 boost, seen 35%). */
export function lengthBonusPct(lengthSec: number, k: number, highlight: boolean): number {
  const own = Math.max(0, lengthSec - 50) * 0.3446;
  const base = highlight ? Math.max(own, HIGHLIGHT_BASE_PCT) : own;
  return ceil(base * boostFactor(k));
}

export interface PointOpts {
  baseEp: number;
  memberBonusPct: number;
  holopass: boolean;
  rounding: Rounding;
}

/** (((ep * member bonus) * length bonus) * boosts) * holopass */
export function pointsPerPlay(k: number, lengthPct: number, o: PointOpts): number {
  const r = o.rounding === "floor-each" ? Math.floor : (x: number) => x;
  let v = r(o.baseEp * (1 + o.memberBonusPct / 100));
  v = r(v * (1 + lengthPct / 100));
  v = r(v * BOOST_MULT[k]);
  v = v * (o.holopass ? 2 : 1);
  return v;
}

/**
 * Base EP per play in multi-lives, from your own score and the lobby's multi score.
 * Least-squares fit over 10 real plays (2026-11-02), max error 0.16 base points (~0.03%).
 * Not an official formula; it may not carry over to solo lives.
 */
export const SCORE_FIT = { intercept: 120.659, perMillionPersonal: 66.366, perMillionMulti: 16.686 } as const;

export function baseEpFromScores(personal: number, multi: number): number {
  return SCORE_FIT.intercept + (SCORE_FIT.perMillionPersonal * personal) / 1e6 + (SCORE_FIT.perMillionMulti * multi) / 1e6;
}

/** Back-solve base EP from one observed play. Approximate if the game floors between steps. */
export function solveBaseEp(observed: number, k: number, lengthPct: number, memberBonusPct: number, holopass: boolean): number {
  const mult = (1 + memberBonusPct / 100) * (1 + lengthPct / 100) * BOOST_MULT[k] * (holopass ? 2 : 1);
  return observed / mult;
}

/** One logged play for calibration. lengthPct is the bonus shown in game, if the user noted it. */
export interface Sample {
  points: number;
  lengthPct?: number;
}

/**
 * Average base EP over several plays at the same boost count. Score varies play to play,
 * so a handful of plays gives a far better estimate than one. Plays without a noted
 * length bonus use `fallbackLengthPct` (the expected bonus for the current song pool).
 */
export function calibrateBaseEp(
  samples: Sample[],
  k: number,
  fallbackLengthPct: number,
  memberBonusPct: number,
  holopass: boolean,
): { baseEp: number; meanPoints: number; n: number } | null {
  const ok = samples.filter((x) => Number.isFinite(x.points) && x.points > 0);
  if (ok.length === 0) return null;
  const bases = ok.map((x) => solveBaseEp(x.points, k, x.lengthPct ?? fallbackLengthPct, memberBonusPct, holopass));
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  return { baseEp: mean(bases), meanPoints: mean(ok.map((x) => x.points)), n: ok.length };
}

/** Parse "points" or "points length%" per line. Separators: whitespace, ";" or ", ". "12,345" stays one number. */
export function parseSamples(text: string): Sample[] {
  return text
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [p, l] = line.split(/[\s;]+|,\s+/).map((v) => parseFloat(v.replace(/,/g, "").replace(/%$/, "")));
      return Number.isFinite(l) ? { points: p, lengthPct: l } : { points: p };
    });
}

/** One entry in the weighted pool of songs the game may pick. */
export interface PoolEntry {
  length: number;
  highlight: boolean;
  weight: number;
}

export type SongSource =
  | { kind: "pool"; pool: PoolEntry[] }
  | { kind: "manual"; lengthPct: number; avgLength: number };

export interface ExpectedPlay {
  points: number;
  songSec: number;
  lengthPct: number; // expected length bonus at this boost level
}

/**
 * Expected points per play, song seconds and length bonus at k boosts.
 * Averaged per song (not via average length): ceil, the 50 s threshold and the highlight floor are nonlinear.
 */
export function expectedPlay(k: number, src: SongSource, o: PointOpts): ExpectedPlay {
  if (src.kind === "manual") {
    // manual % is the base bonus; boostFactor still applies per boost level
    const lengthPct = ceil(src.lengthPct * boostFactor(k));
    return { points: pointsPerPlay(k, lengthPct, o), songSec: src.avgLength, lengthPct };
  }
  let points = 0;
  let songSec = 0;
  let lengthPct = 0;
  for (const e of src.pool) {
    const pct = lengthBonusPct(e.length, k, e.highlight);
    points += e.weight * pointsPerPlay(k, pct, o);
    songSec += e.weight * e.length;
    lengthPct += e.weight * pct;
  }
  return { points, songSec, lengthPct };
}

/** Minutes until the event ends: the given date at 11:00 UTC. */
export function minutesLeft(endDate: string, now: Date = new Date()): number {
  const [y, m, d] = endDate.split("-").map(Number);
  if (!y || !m || !d) return 0;
  const end = Date.UTC(y, m - 1, d, EVENT_END_HOUR_UTC);
  return Math.max(0, Math.floor((end - now.getTime()) / 60000));
}

export interface RegenOpts {
  currentStamina: number;
  /** 0–1: share of natural regen actually caught (sleep, being away, sitting at cap). */
  efficiency: number;
}

/** Boosts available without spending drinks or gems: current stamina plus regen over the time left. */
export function naturalBoosts(mins: number, r: RegenOpts): { regen: number; total: number } {
  const regen = Math.floor((mins / REGEN_MINUTES) * Math.min(1, Math.max(0, r.efficiency)));
  return { regen, total: Math.max(0, r.currentStamina) + regen };
}

export function staminaCap(holopass: boolean): number {
  return holopass ? 20 : 10;
}

// ---------------------------------------------------------------- planning

export interface Level {
  k: number;
  points: number; // expected per play
}

export interface PlanInput {
  needed: number; // points still to earn
  levels: Level[]; // k = 1..10
  secPerPlay: number; // song + overhead
  maxPlaySec: number; // play-time budget
  natural: number; // free boosts available
  drinks: number;
  gems: number;
}

export interface Plan {
  mix: { k: number; plays: number }[];
  plays: number;
  boosts: number;
  points: number;
  playSec: number;
  feasible: boolean; // fits in the time budget
  extraBoosts: number;
  leftoverBoosts: number;
  drinksSpent: number;
  gemsSpent: number;
  gemsShort: number;
}

function finish(mix: { k: number; plays: number }[], levels: Level[], p: PlanInput, feasible: boolean): Plan {
  const pts = new Map(levels.map((l) => [l.k, l.points]));
  const used = mix.filter((m) => m.plays > 0);
  const plays = used.reduce((s, m) => s + m.plays, 0);
  const boosts = used.reduce((s, m) => s + m.k * m.plays, 0);
  const points = used.reduce((s, m) => s + (pts.get(m.k) ?? 0) * m.plays, 0);
  const extraBoosts = Math.max(0, boosts - p.natural);
  const drinksSpent = Math.min(Math.max(0, p.drinks), extraBoosts);
  const gemsSpent = (extraBoosts - drinksSpent) * GEMS_PER_BOOST;
  return {
    mix: used.sort((a, b) => b.k - a.k),
    plays,
    boosts,
    points,
    playSec: plays * p.secPerPlay,
    feasible,
    extraBoosts,
    leftoverBoosts: Math.max(0, p.natural - boosts),
    drinksSpent,
    gemsSpent,
    gemsShort: Math.max(0, gemsSpent - Math.max(0, p.gems)),
  };
}

/** Every play at a single boost level. */
export function singleLevel(k: number, p: PlanInput): Plan {
  const lvl = p.levels.find((l) => l.k === k)!;
  const plays = p.needed <= 0 ? 0 : Math.ceil(p.needed / lvl.points);
  return finish([{ k, plays }], p.levels, p, plays * p.secPerPlay <= p.maxPlaySec);
}

/**
 * Fewest boosts that reach `needed` within `maxPlaySec`.
 * Two constraints means an optimal LP vertex uses at most two levels, so we search all
 * pairs (i, j) exhaustively over integer play counts. If nothing fits, fall back to all-10s.
 */
export function cheapestWithin(p: PlanInput): Plan {
  if (p.needed <= 0) return finish([], p.levels, p, true);
  const maxPlays = Math.floor(p.maxPlaySec / p.secPerPlay);
  let best: { cost: number; plays: number; mix: { k: number; plays: number }[] } | null = null;
  const consider = (cost: number, plays: number, mix: { k: number; plays: number }[]) => {
    if (!best || cost < best.cost || (cost === best.cost && plays < best.plays)) best = { cost, plays, mix };
  };
  const ls = p.levels;
  for (let a = 0; a < ls.length; a++) {
    for (let b = a; b < ls.length; b++) {
      const lo = ls[a];
      const hi = ls[b];
      const maxHi = Math.min(maxPlays, Math.ceil(p.needed / hi.points));
      for (let nHi = 0; nHi <= maxHi; nHi++) {
        const rest = p.needed - nHi * hi.points;
        const nLo = rest <= 0 ? 0 : Math.ceil(rest / lo.points);
        if (nLo + nHi > maxPlays) continue;
        consider(lo.k * nLo + hi.k * nHi, nLo + nHi, [
          { k: lo.k, plays: nLo },
          { k: hi.k, plays: nHi },
        ]);
      }
    }
  }
  if (!best) {
    const fallback = singleLevel(MAX_BOOST, p);
    return { ...fallback, feasible: false };
  }
  const b = best as { mix: { k: number; plays: number }[] };
  // merge duplicate k (when a === b)
  const merged = new Map<number, number>();
  for (const m of b.mix) merged.set(m.k, (merged.get(m.k) ?? 0) + m.plays);
  return finish([...merged].map(([k, plays]) => ({ k, plays })), p.levels, p, true);
}

export type Strategy = "fastest" | "cheapest" | "balanced";

export function planFor(strategy: Strategy, p: PlanInput, balancedPlaySec: number): Plan {
  if (strategy === "fastest") return singleLevel(MAX_BOOST, p);
  if (strategy === "cheapest") return cheapestWithin(p);
  return cheapestWithin({ ...p, maxPlaySec: Math.min(p.maxPlaySec, balancedPlaySec) });
}

export function fmtDuration(sec: number): string {
  const m = Math.round(sec / 60);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
