import { describe, expect, it } from "vitest";
import snapshot from "./data/db.json";
import { EXCLUDED_MEMBERS, buildDb, songWeights, suggestEventSongs, type Db } from "./db";

const row = (id: string, data: Record<string, unknown>) => ({ id, data: { id, ...data } });

describe("buildDb", () => {
  const db = buildDb(
    [
      row("chr-a", { nameEng: "A", isPlayable: true, order: 2 }),
      row("chr-b", { nameEng: "B", isPlayable: true, order: 1 }),
      row("chr-npc", { nameEng: "NPC" }),
      row("chr-04004", { nameEng: "excluded by id", isPlayable: true }),
    ],
    [
      row("m1", { titleLangId: "t1", playingSeconds: 120, characterIds: ["chr-a"], musicSingerType: "X_SOLO" }),
      row("m2", { titleLangId: "t2", playingSeconds: 150, characterIds: ["chr-a", "chr-b"], musicSingerType: "X_GROUP" }),
      row("m3", { titleLangId: "t3", playingSeconds: 140, musicSingerType: "X_ALL" }),
      row("m9", { titleLangId: "t9", playingSeconds: 40, isTutorial: true, musicSingerType: "X_ALL" }),
    ],
    [row("t1", { text: "One" }), row("t2", { text: "Two" }), row("t3", { text: "Three" })],
    0,
  );

  it("keeps playable, non-excluded members in game order", () => {
    expect(db.members.map((m) => m.id)).toEqual(["chr-b", "chr-a"]);
  });

  it("drops tutorial songs and flags everyone songs", () => {
    expect(db.songs.map((s) => [s.title, s.everyone])).toEqual([["One", false], ["Three", true], ["Two", false]]);
  });

  it("weights: half event songs, half member → member's other songs", () => {
    const w = new Map(songWeights(db, ["chr-a", "chr-b"], new Set(["m2"]), false).map((x) => [x.song.id, x.weight]));
    // m2 is the only event song; A's other song is m1; B has no other songs, so A takes the whole member half
    expect(w.get("m2")).toBeCloseTo(0.5);
    expect(w.get("m1")).toBeCloseTo(0.5);
    expect(w.has("m3")).toBe(false);
  });

  it("everyone songs join each member's list when enabled", () => {
    const w = new Map(songWeights(db, ["chr-a", "chr-b"], new Set(["m2"]), true).map((x) => [x.song.id, x.weight]));
    // A: m1, m3 (0.25 each of A's 0.25); B: m3 (all of B's 0.25)
    expect(w.get("m1")).toBeCloseTo(0.125);
    expect(w.get("m3")).toBeCloseTo(0.375);
  });
});

describe("bundled snapshot", () => {
  const snap = snapshot as Db;
  const byName = (n: string) => snap.members.find((m) => m.name === n)!.id;

  it("finds the KaienSpectacle marathon songs by release date", () => {
    const members = ["Natsuiro Matsuri", "Nerissa Ravencroft", "Vestia Zeta", "Juufuutei Raden", "Todoroki Hajime"].map(byName);
    const ids = suggestEventSongs(snap, "marathon", members);
    expect(ids.sort()).toEqual(["m0369", "m0371", "m0372", "m0373", "m0388", "m0551"]);
    const w = songWeights(snap, members, new Set(ids), false);
    expect(w.reduce((t, x) => t + x.weight, 0)).toBeCloseTo(1);
    expect(w.filter((x) => x.event).every((x) => Math.abs(x.weight - 0.5 / 6) < 1e-9)).toBe(true);
  });

  it("spotlight picks the member's newest song", () => {
    expect(suggestEventSongs(snap, "spotlight", [byName("Todoroki Hajime")])).toEqual(["m0371"]);
  });

  it("has no excluded or NPC members", () => {
    expect(snap.members.length).toBeGreaterThan(40);
    expect(snap.members.some((m) => EXCLUDED_MEMBERS.has(m.id))).toBe(false);
  });
  it("every member has at least one song", () => {
    for (const m of snap.members) expect(snap.songs.some((s) => s.chars.includes(m.id))).toBe(true);
  });
});
