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
  start: number; // release time, epoch ms
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
      start: Number(m.startTime ?? 0),
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

// ---------------------------------------------------------------- song selection during an event
//
// How the game picks a song during an event (per community findings):
//   50%: an event song, equal weight between them.
//   50%: a random event member (equal weight), then a random non-event song of that member,
//        which is the same list the in-game member filter shows.
// Every song picked during an event gets the highlight length bonus.

export type EventType = "marathon" | "spotlight";

/** Songs the member sings. With `includeEveryone`, also the hololive IDOL PROJECT songs. */
export function memberSongs(db: Db, member: string, includeEveryone: boolean): DbSong[] {
  return db.songs.filter((s) => s.chars.includes(member) || (includeEveryone && s.everyone));
}

/**
 * Guess the event songs.
 * Marathon: the newest song sung by all members, plus every song released at the same time with
 * at least one member (the group song + one solo each).
 * Spotlight: the member's newest song.
 */
export function suggestEventSongs(db: Db, type: EventType, members: string[]): string[] {
  if (members.length === 0) return [];
  const newest = (list: DbSong[]) =>
    list.reduce<DbSong | null>((a, b) => (!a || b.start > a.start || (b.start === a.start && b.chars.length < a.chars.length) ? b : a), null);
  if (type === "spotlight") {
    const s = newest(db.songs.filter((x) => x.chars.includes(members[0])));
    return s ? [s.id] : [];
  }
  const group = newest(db.songs.filter((x) => !x.everyone && members.every((m) => x.chars.includes(m))));
  if (!group) return [];
  return db.songs.filter((x) => x.start === group.start && x.chars.some((c) => members.includes(c))).map((x) => x.id);
}

export interface WeightedSong {
  song: DbSong;
  weight: number; // chance this song is picked on a play
  event: boolean;
}

/**
 * Per-song pick chance. Members with no non-event songs are skipped (their share goes to the others);
 * if nobody has any, event songs get 100%, and vice versa.
 */
export function songWeights(
  db: Db,
  members: string[],
  eventIds: ReadonlySet<string>,
  includeEveryone: boolean,
  eventShare = 0.5,
): WeightedSong[] {
  const w = new Map<string, WeightedSong>();
  const add = (song: DbSong, weight: number, event: boolean) => {
    const cur = w.get(song.id);
    if (cur) cur.weight += weight;
    else w.set(song.id, { song, weight, event });
  };
  const events = db.songs.filter((s) => eventIds.has(s.id));
  const perMember = members
    .map((m) => memberSongs(db, m, includeEveryone).filter((s) => !eventIds.has(s.id)))
    .filter((list) => list.length > 0);
  const evShare = events.length === 0 ? 0 : perMember.length === 0 ? 1 : eventShare;
  for (const s of events) add(s, evShare / events.length, true);
  for (const list of perMember) for (const s of list) add(s, (1 - evShare) / perMember.length / list.length, false);
  return [...w.values()].sort((a, b) => Number(b.event) - Number(a.event) || b.weight - a.weight || a.song.title.localeCompare(b.song.title));
}
