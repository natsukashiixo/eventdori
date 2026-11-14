# eventdori

Vibecoded cost calculator for holodori events.

Browser-only event point calculator (see `writeup.md`). All math runs client-side; inputs persist in localStorage.

```sh
npm install
npm run dev      # local dev server
npm test         # vitest on src/calc.ts
npm run build    # static site in dist/
npm run data     # refresh the bundled fallback snapshot src/data/db.json
```

Song and member data comes from the [HolodoriDB/holodori-db-eng-diff](https://github.com/HolodoriDB/holodori-db-eng-diff)
master-data mirror (`Character.json`, `Music.json`, `LangMusic_Eng.json` on `main`). The browser fetches it directly
from raw.githubusercontent.com (CORS `*`) when its copy is over a day old, caches the trimmed result (~26 KB) in
localStorage, and falls back to the bundled snapshot. Non-playable characters and the tutorial song are filtered out.
(The holodori.best API is Cloudflare-challenged and CORS-locked, so it isn't used.)

The length-bonus formula is verified against in-game readings (see `lengthBonusPct` tests). Whether the
game floors between multipliers is still unverified and is a toggle under "Formula assumptions".
