// Song + member data from the HolodoriDB master-data mirror on GitHub.
// raw.githubusercontent.com sends `Access-Control-Allow-Origin: *`, so the browser fetches it directly.
// `refs/heads/main` always resolves to the newest commit; the CDN caches each file for up to 5 minutes.
// Kept free of TS-only runtime syntax so `node scripts/fetch-data.ts` can import it (type stripping).

export const DB_BASE = "https://raw.githubusercontent.com/HolodoriDB/holodori-db-eng-diff/refs/heads/main/";
export const DB_FILES = ["Character.json", "Music.json", "LangMusic_Eng.json"] as const;

/**
 * Characters that never appear as playable event members. Hand-picked list; at the time of writing
 * it is exactly the set of characters without `isPlayable: true`, which is also checked.
 */
export const EXCLUDED_MEMBERS = new Set([
  "chr-04004", "chr-04005", "chr-00009", "chr-04009", "chr-04011", "chr-06001", "chr-00038", "chr-00024",
]);

export interface Member {
  id: string;
  name: string;
  group: string;
  order: number;
}

export interface DbSong {
  id: string;
  title: string;
  length: number; // seconds
  chars: string[]; // singers; empty for "everyone" songs
  everyone: boolean; // MUSIC_SINGER_TYPE_ALL: hololive IDOL PROJECT songs
}

export interface Db {
  fetchedAt: number; // epoch ms
  members: Member[];
  songs: DbSong[];
}

type Row = { id: string; data: Record<string, unknown> };

/** Trim the three raw master-data files down to what the calculator needs. */
export function buildDb(character: Row[], music: Row[], langMusic: Row[], fetchedAt: number): Db {
  const text = new Map(langMusic.map((r) => [r.id, r.data.text as string | undefined]));

  const members: Member[] = character
    .map((r) => r.data)
    .filter((c) => c.isPlayable === true && !EXCLUDED_MEMBERS.has(c.id as string))
    .map((c) => ({
      id: c.id as string,
      name: (c.nameEng as string) ?? (c.id as string),
      group: (c.regularCharacterGroupingNameEng as string) ?? "",
      order: Number(c.order ?? 0),
    }))
    .sort((a, b) => a.order - b.order);

  const songs: DbSong[] = music
    .map((r) => r.data)
    .filter((m) => !m.isTutorial && Number(m.playingSeconds) > 0)
    .map((m) => ({
      id: m.id as string,
      title: text.get(m.titleLangId as string) ?? (m.id as string),
      length: Number(m.playingSeconds),
      chars: (m.characterIds as string[] | undefined) ?? [],
      everyone: String(m.musicSingerType).endsWith("_ALL"),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));

  return { fetchedAt, members, songs };
}

export async function fetchDb(fetchFn: typeof fetch = fetch): Promise<Db> {
  const [character, music, lang] = await Promise.all(
    DB_FILES.map(async (f) => {
      const res = await fetchFn(DB_BASE + f, { cache: "no-cache" });
      if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
      return (await res.json()) as Row[];
    }),
  );
  const db = buildDb(character, music, lang, Date.now());
  if (db.songs.length === 0 || db.members.length === 0) throw new Error("fetched data looks empty");
  return db;
}

// ---------------------------------------------------------------- pool selection

/** Main-song candidates: songs whose singers include every chosen member (all songs if none chosen). */
export function mainSongCandidates(db: Db, chosen: string[]): { withAll: DbSong[]; everyone: DbSong[] } {
  const withAll = db.songs.filter((s) => !s.everyone && chosen.every((c) => s.chars.includes(c)));
  return { withAll, everyone: db.songs.filter((s) => s.everyone) };
}

/** Highlight pool: songs sung by at least one chosen member, minus the main song. */
export function highlightPool(db: Db, chosen: string[], mainId: string, includeEveryone: boolean): DbSong[] {
  if (chosen.length === 0) return [];
  return db.songs.filter(
    (s) => s.id !== mainId && ((includeEveryone && s.everyone) || s.chars.some((c) => chosen.includes(c))),
  );
}
