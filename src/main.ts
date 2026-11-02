import bundledDb from "./data/db.json";
import {
  BOOST_MULT,
  EVENT_END_HOUR_UTC,
  MAX_BOOST,
  buildPool,
  calibrateBaseEp,
  expectedPlay,
  fmtDuration,
  minutesLeft,
  naturalBoosts,
  parseSamples,
  planFor,
  singleLevel,
  staminaCap,
  type Level,
  type PlanInput,
  type PointOpts,
  type Rounding,
  type SongSource,
  type Strategy,
} from "./calc";
import { fetchDb, highlightPool, mainSongCandidates, type Db, type DbSong } from "./db";

const STORE_KEY = "eventdori:v1";
const DB_KEY = "eventdori:db:v1";
const DB_MAX_AGE = 24 * 3600 * 1000;
const MEMBER_IDS = ["member1", "member2", "member3", "member4", "member5"];

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;
const num = (id: string, fallback = 0) => {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : fallback;
};
const radio = (name: string) =>
  (document.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement | null)?.value ?? "";
const fmt = (n: number) => Math.round(n).toLocaleString();

const form = $<HTMLFormElement>("f");

// ------------------------------------------------------------ data

function readCachedDb(): Db | null {
  try {
    const d = JSON.parse(localStorage.getItem(DB_KEY) ?? "null") as Db | null;
    return d && Array.isArray(d.songs) && Array.isArray(d.members) ? d : null;
  } catch {
    return null;
  }
}

let db: Db = (() => {
  const cached = readCachedDb();
  const bundled = bundledDb as Db;
  return cached && cached.fetchedAt >= bundled.fetchedAt ? cached : bundled;
})();
let songById = new Map(db.songs.map((s) => [s.id, s]));

function dbStatus(extra = "") {
  const when = new Date(db.fetchedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  $("dbStatus").textContent = `Song data from ${when} (${db.songs.length} songs, ${db.members.length} members)${extra}`;
}

async function refreshDb(force = false) {
  if (!force && Date.now() - db.fetchedAt < DB_MAX_AGE) return dbStatus();
  dbStatus(" · updating…");
  try {
    db = await fetchDb();
    songById = new Map(db.songs.map((s) => [s.id, s]));
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch { /* storage unavailable */ }
    fillMembers();
    rebuildSongUi();
    dbStatus();
    render();
  } catch (e) {
    dbStatus(` · update failed (${(e as Error).message})`);
  }
}

// ------------------------------------------------------------ member + song pickers

const poolOff = new Set<string>(); // songs the user unticked from the derived pool

function fillMembers() {
  const groups = new Map<string, Db["members"]>();
  for (const m of db.members) groups.set(m.group, [...(groups.get(m.group) ?? []), m]);
  for (const id of MEMBER_IDS) {
    const sel = $<HTMLSelectElement>(id);
    const keep = sel.value;
    sel.replaceChildren(new Option("(none)", ""));
    for (const [group, ms] of groups) {
      const og = document.createElement("optgroup");
      og.label = group || "other";
      for (const m of ms) og.append(new Option(m.name, m.id));
      sel.append(og);
    }
    sel.value = db.members.some((m) => m.id === keep) ? keep : "";
  }
}

const chosenMembers = () => [...new Set(MEMBER_IDS.map((id) => $<HTMLSelectElement>(id).value).filter(Boolean))];
const songLabel = (s: DbSong) => `${s.title} (${s.length}s)`;

/** Rebuild the main-song options and the derived pool list. Call when members, main song or data change. */
function rebuildSongUi(wantMain?: string) {
  const chosen = chosenMembers();
  const main = $<HTMLSelectElement>("mainSong");
  const keep = wantMain ?? main.value;
  const { withAll, everyone } = mainSongCandidates(db, chosen);
  main.replaceChildren(new Option("(none)", ""));
  const group = (label: string, list: DbSong[]) => {
    if (!list.length) return;
    const og = document.createElement("optgroup");
    og.label = label;
    for (const s of list) og.append(new Option(songLabel(s), s.id));
    main.append(og);
  };
  group(chosen.length ? "Sung by all chosen members" : "All songs", withAll);
  group("Everyone songs", everyone);
  main.value = [...withAll, ...everyone].some((s) => s.id === keep) ? keep : "";

  const pool = highlightPool(db, chosen, main.value, $("includeEveryone").checked);
  const list = $("poolList");
  list.replaceChildren(
    ...pool.map((s) => {
      const row = document.createElement("label");
      row.className = "check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = s.id;
      cb.checked = !poolOff.has(s.id);
      row.classList.toggle("on", cb.checked);
      const name = document.createElement("span");
      name.textContent = s.title;
      const len = document.createElement("span");
      len.className = "len";
      len.textContent = `${s.length}s`;
      row.append(cb, name, len);
      return row;
    }),
  );
  list.hidden = pool.length === 0;
}

/** Songs currently ticked in the pool list. */
function poolSongs(): DbSong[] {
  return [...$("poolList").querySelectorAll<HTMLInputElement>("input:checked")]
    .map((cb) => songById.get(cb.value))
    .filter((s): s is DbSong => Boolean(s));
}

// ------------------------------------------------------------ persistence

function save() {
  const state: Record<string, unknown> = { poolOff: [...poolOff] };
  for (const el of form.elements as HTMLFormControlsCollection) {
    const i = el as HTMLInputElement;
    if (!i.id && i.type !== "radio") continue;
    if (i.closest("#poolList")) continue;
    if (i.type === "radio") { if (i.checked) state[`radio:${i.name}`] = i.value; }
    else if (i.type === "checkbox") state[i.id] = i.checked;
    else state[i.id] = i.value;
  }
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

function load() {
  let state: Record<string, unknown> = {};
  try { state = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}"); } catch { /* ignore */ }
  for (const [k, v] of Object.entries(state)) {
    if (k === "poolOff") { for (const id of v as string[]) poolOff.add(id); continue; }
    if (k === "mainSong") continue; // options depend on members; restored below
    if (k.startsWith("radio:")) {
      const r = document.querySelector(`input[name="${k.slice(6)}"][value="${v}"]`) as HTMLInputElement | null;
      if (r) r.checked = true;
      continue;
    }
    const el = document.getElementById(k) as HTMLInputElement | null;
    if (!el) continue;
    if (el.type === "checkbox") el.checked = Boolean(v);
    else el.value = String(v);
  }
  if (!$("endDate").value) {
    const d = new Date(Date.now() + 7 * 864e5);
    $("endDate").value = d.toISOString().slice(0, 10);
  }
  rebuildSongUi(typeof state.mainSong === "string" ? state.mainSong : "");
}

// ------------------------------------------------------------ compute + render

function pointOpts(): PointOpts {
  return {
    baseEp: num("baseEp"),
    memberBonusPct: num("memberBonus"),
    holopass: $("holopass").checked,
    rounding: $<HTMLSelectElement>("rounding").value as Rounding,
  };
}

function songSource(): SongSource {
  if (radio("songMode") === "manual") {
    return { kind: "manual", lengthPct: num("manualLengthPct"), avgLength: num("manualAvgLen", 127) };
  }
  const main = songById.get($<HTMLSelectElement>("mainSong").value) ?? null;
  return { kind: "pool", pool: buildPool(main, poolSongs(), num("eventChance", 0.5)) };
}

function render() {
  const manual = radio("songMode") === "manual";
  $("poolBox").hidden = manual;
  $("manualBox").hidden = !manual;
  const pool = poolSongs();
  const avg = pool.length ? pool.reduce((t, x) => t + x.length, 0) / pool.length : 0;
  $("poolCount").textContent = chosenMembers().length
    ? `Highlight pool besides the main song: ${pool.length}${pool.length ? `, avg ${avg.toFixed(0)}s` : ""}`
    : "Pick at least one member.";

  const endDate = $("endDate").value;
  const [y, m, d] = endDate.split("-").map(Number);
  $("endLocal").textContent = y
    ? `Ends ${new Date(Date.UTC(y, m - 1, d, EVENT_END_HOUR_UTC)).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} your time`
    : "";

  const warnings: string[] = [];
  const src = songSource();
  if (src.kind === "pool" && src.pool.length === 0) warnings.push("Pick the event members (and main song), or switch songs to manual.");

  const opts = pointOpts();
  const mins = minutesLeft(endDate);
  const holopass = opts.holopass;
  const stamina = num("currentStamina");
  const nat = naturalBoosts(mins, { currentStamina: stamina, efficiency: num("efficiency", 1) });
  const needed = Math.max(0, num("targetPts") - num("currentPts"));

  const minBoost = Math.min(MAX_BOOST, Math.max(0, Math.round(num("minBoost", 1))));
  const levels: Level[] = [];
  const lengthPctAt = new Map<number, number>();
  let songSec = 0;
  for (let k = minBoost; k <= MAX_BOOST; k++) {
    const e = expectedPlay(k, src, opts);
    levels.push({ k, points: e.points });
    lengthPctAt.set(k, e.lengthPct);
    songSec = e.songSec;
  }
  const secPerPlay = songSec + num("overheadSec");
  const valid = levels.every((l) => l.points > 0) && secPerPlay > 0;

  const out = $("summary");
  const table = $<HTMLTableElement>("levels");
  if (!valid) {
    if (opts.baseEp <= 0) warnings.push("Set a base EP per play (or calibrate it).");
    $("warnings").innerHTML = warnings.map((w) => `<div class="warn">${w}</div>`).join("");
    $("results").hidden = true;
    return;
  }
  $("results").hidden = false;

  const input: PlanInput = {
    needed,
    levels,
    secPerPlay,
    maxPlaySec: mins * 60,
    natural: nat.total,
    drinks: num("drinks"),
    gems: num("gems"),
  };
  const strategy = radio("strategy") as Strategy;
  const balancedSec = (num("hoursPerDay") * 3600 * mins) / 1440;
  const plan = planFor(strategy, input, balancedSec);

  if (stamina >= staminaCap(holopass)) {
    warnings.push(`Stamina is at or above the cap (${staminaCap(holopass)}), so natural regen is paused until you spend it.`);
  }
  if (plan.mix.some((m) => m.k >= 7)) {
    warnings.push("At 7+ boosts per play, natural regen is functionally 0. Your regen efficiency setting is optimistic.");
  }
  if (plan.mix.some((m) => m.k === 0)) {
    warnings.push(
      "Plan includes 0-boost plays. These only happen with empty stamina; you can't pick 0 boosts while holding any.",
    );
  }
  if (!plan.feasible) {
    warnings.push(
      strategy === "balanced"
        ? "Can't reach the target in your daily play hours, even at 10 boosts. Showing all-10s."
        : "Can't reach the target before the event ends, even at 10 boosts.",
    );
  }
  if (plan.gemsShort > 0) warnings.push(`You're ${fmt(plan.gemsShort)} gems short.`);
  $("warnings").innerHTML = warnings.map((w) => `<div class="warn">${w}</div>`).join("");

  $("planTitle").textContent = `Plan: ${strategy}`;
  const mix = plan.mix.map((m) => `${fmt(m.plays)} × ${m.k} boost${m.k === 1 ? "" : "s"}`).join(" + ") || "nothing to do";
  const rows: [string, string, boolean?][] = [
    ["Event time left", `${fmtDuration(mins * 60)} (${fmt(mins)} min)`],
    ["Points still needed", fmt(needed)],
    ["Plays", mix, true],
    ["Natural stamina", `${fmt(nat.total)} (${fmt(stamina)} now + ${fmt(nat.regen)} regen)`],
    ["Boosts used", fmt(plan.boosts)],
    ["Extra boosts needed", fmt(plan.extraBoosts)],
    ["Left over stamina", fmt(plan.leftoverBoosts)],
    ["Drinks spent", fmt(plan.drinksSpent)],
    ["Gems spent", fmt(plan.gemsSpent), true],
    ["Time needed", `${fmtDuration(plan.playSec)} (${(secPerPlay).toFixed(0)}s per play)`, true],
    ["Final event points", fmt(num("currentPts") + plan.points)],
  ];
  out.innerHTML = rows.map(([k, v, big]) => `<dt>${k}</dt><dd${big ? ' class="big"' : ""}>${v}</dd>`).join("");

  const used = new Set(plan.mix.map((m) => m.k));
  const head = "<tr><th>boosts</th><th>× table</th><th>length %</th><th>pts / play</th><th>pts / boost</th><th>plays</th><th>time</th><th>gems</th><th>fits?</th></tr>";
  const body = levels
    .map((l) => {
      const p = singleLevel(l.k, input);
      const fits = p.playSec <= balancedSec ? "daily" : p.feasible ? "event" : "no";
      return `<tr class="${used.has(l.k) ? "inplan" : ""}">
        <td>${l.k}</td><td>${BOOST_MULT[l.k]}</td><td>${(lengthPctAt.get(l.k) ?? 0).toFixed(1)}</td>
        <td>${fmt(l.points)}</td><td>${l.k === 0 ? "free" : (l.points / l.k).toFixed(1)}</td>
        <td>${fmt(p.plays)}</td><td>${fmtDuration(p.playSec)}</td><td>${fmt(p.gemsSpent)}</td>
        <td class="${fits === "no" ? "no" : "ok"}">${fits}</td></tr>`;
    })
    .join("");
  table.innerHTML = head + body;
}

// ------------------------------------------------------------ wiring

$("calibrate").addEventListener("click", () => {
  const k = Math.min(MAX_BOOST, Math.max(0, Math.round(num("obsK", 10))));
  const samples = parseSamples($<HTMLTextAreaElement>("obsPlays").value);
  const opts = pointOpts();
  const fallbackPct = expectedPlay(k, songSource(), opts).lengthPct;
  const r = calibrateBaseEp(samples, k, fallbackPct, opts.memberBonusPct, opts.holopass);
  if (!r || !Number.isFinite(r.baseEp) || r.baseEp <= 0) {
    $("calibOut").textContent = "Paste the points from a few real plays first.";
    return;
  }
  $("baseEp").value = r.baseEp.toFixed(2);
  $("calibOut").textContent =
    `${r.n} play${r.n === 1 ? "" : "s"}, avg ${fmt(r.meanPoints)} pts at ${k} boosts → base EP ≈ ${r.baseEp.toFixed(2)}` +
    (samples.some((x) => x.lengthPct === undefined) ? ` (assumed ${fallbackPct.toFixed(1)}% length bonus where not given)` : "");
  save();
  render();
});

$("dbRefresh").addEventListener("click", () => void refreshDb(true));
$("poolList").addEventListener("change", (e) => {
  const cb = e.target as HTMLInputElement;
  if (cb.checked) poolOff.delete(cb.value);
  else poolOff.add(cb.value);
  cb.parentElement!.classList.toggle("on", cb.checked);
});

fillMembers();
load();
dbStatus();
render();
const onEdit = (e: Event) => {
  const id = (e.target as HTMLElement).id;
  if (MEMBER_IDS.includes(id) || id === "mainSong" || id === "includeEveryone") rebuildSongUi();
  save();
  render();
};
form.addEventListener("input", onEdit);
form.addEventListener("change", onEdit);
form.addEventListener("submit", (e) => e.preventDefault());
setInterval(render, 60_000); // time left ticks down
void refreshDb(); // fetch fresh song data if ours is over a day old
