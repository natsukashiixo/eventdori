// Refresh the bundled fallback snapshot (src/data/db.json) from HolodoriDB.
// The app fetches live data itself; this snapshot is only used offline or if GitHub is unreachable.
// Usage: npm run data
import { writeFileSync } from "node:fs";
import { fetchDb } from "../src/db.ts";

const db = await fetchDb();
writeFileSync(new URL("../src/data/db.json", import.meta.url), JSON.stringify(db));
console.log(`wrote ${db.songs.length} songs, ${db.members.length} members`);
