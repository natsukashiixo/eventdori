import { describe, expect, it } from "vitest";
import snapshot from "./data/db.json";
import { EXCLUDED_MEMBERS, buildDb, highlightPool, mainSongCandidates, type Db } from "./db";

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

  it("main candidates must include every chosen member", () => {
    expect(mainSongCandidates(db, ["chr-a", "chr-b"]).withAll.map((s) => s.id)).toEqual(["m2"]);
    expect(mainSongCandidates(db, ["chr-a"]).withAll.map((s) => s.id)).toEqual(["m1", "m2"]);
  });

  it("pool = songs with any chosen member, minus the main song", () => {
    expect(highlightPool(db, ["chr-b"], "", false).map((s) => s.id)).toEqual(["m2"]);
    expect(highlightPool(db, ["chr-a"], "m2", false).map((s) => s.id)).toEqual(["m1"]);
    expect(highlightPool(db, ["chr-a"], "m2", true).map((s) => s.id)).toEqual(["m1", "m3"]);
  });
});

describe("bundled snapshot", () => {
  const snap = snapshot as Db;
  it("has no excluded or NPC members", () => {
    expect(snap.members.length).toBeGreaterThan(40);
    expect(snap.members.some((m) => EXCLUDED_MEMBERS.has(m.id))).toBe(false);
  });
  it("every member has at least one song", () => {
    for (const m of snap.members) expect(snap.songs.some((s) => s.chars.includes(m.id))).toBe(true);
  });
});
