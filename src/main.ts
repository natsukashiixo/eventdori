import bundledDb from "./data/db.json";
import {
  BOOST_MULT,
  EVENT_END_HOUR_UTC,
  MAX_BOOST,
  baseEpFromScores,
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
import { fetchDb, songWeights, suggestEventSongs, type Db, type EventType, type WeightedSong } from "./db";

const STORE_KEY = "eventdori:v1";
const DB_KEY = "eventdori:db:v2"; // v2: songs carry release time
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
    for (const id of [...eventIds]) if (!songById.has(id)) eventIds.delete(id);
    rebuildSongUi();
    dbStatus();
    render();
  } catch (e) {
    dbStatus(` · update failed (${(e as Error).message})`);
  }
}

// ------------------------------------------------------------ member + song pickers

const eventIds = new Set<string>(); // songs ticked as event songs

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

/** Gray out members already picked in another slot. */
function syncMemberOptions() {
  const sels = MEMBER_IDS.map((id) => $<HTMLSelectElement>(id));
  for (const sel of sels) {
    const takenElsewhere = new Set(sels.filter((o) => o !== sel && !o.hidden).map((o) => o.value).filter(Boolean));
    for (const opt of sel.options) opt.disabled = takenElsewhere.has(opt.value);
  }
}

const eventType = () => (radio("eventType") || "marathon") as EventType;
/** Chosen members; a Spotlight event only uses the first slot. */
function chosenMembers(): string[] {
  const ids = eventType() === "spotlight" ? MEMBER_IDS.slice(0, 1) : MEMBER_IDS;
  return [...new Set(ids.map((id) => $<HTMLSelectElement>(id).value).filter(Boolean))];
}

function redetectEventSongs() {
  eventIds.clear();
  for (const id of suggestEventSongs(db, eventType(), chosenMembers())) eventIds.add(id);
}

const weights = (): WeightedSong[] =>
  songWeights(db, chosenMembers(), eventIds, $("includeEveryone").checked, num("eventChance", 0.5));

/** Redraw the song list: tick = event song, plus each song's pick chance. */
function rebuildSongUi() {
  const spotlight = eventType() === "spotlight";
  for (const id of MEMBER_IDS.slice(1)) $(id).hidden = spotlight;
  syncMemberOptions();

  const list = $("poolList");
  const scroll = list.scrollTop;
  const ws = weights();
  list.replaceChildren(
    ...ws.map(({ song, weight, event }) => {
      const row = document.createElement("label");
      row.className = "check" + (event ? " on" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = song.id;
      cb.checked = event;
      const name = document.createElement("span");
      name.textContent = song.title;
      const meta = document.createElement("span");
      meta.className = "len";
      meta.textContent = `${(weight * 100).toFixed(1)}% · ${song.length}s`;
      row.append(cb, name, meta);
      return row;
    }),
  );
  list.scrollTop = scroll;
  list.hidden = ws.length === 0;

  const nEvent = ws.filter((w) => w.event).length;
  const avg = ws.reduce((t, w) => t + w.weight * w.song.length, 0);
  $("poolCount").textContent = chosenMembers().length
    ? `${nEvent} event song${nEvent === 1 ? "" : "s"}, ${ws.length - nEvent} member songs · expected length ${avg.toFixed(0)}s`
    : "Pick at least one member.";
}

// ------------------------------------------------------------ persistence

function save() {
  const state: Record<string, unknown> = { eventSongs: [...eventIds] };
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
    if (k === "eventSongs") continue; // restored below, once members are set
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
  if (Array.isArray(state.eventSongs)) {
    for (const id of state.eventSongs as string[]) if (songById.has(id)) eventIds.add(id);
  } else {
    redetectEventSongs();
  }
  rebuildSongUi();
}

// ------------------------------------------------------------ compute + render

const fromScores = () => radio("baseMode") !== "manual";

function baseEp(): number {
  return fromScores() ? baseEpFromScores(num("typicalPersonal"), num("typicalMulti")) : num("baseEp");
}

function pointOpts(): PointOpts {
  return {
    baseEp: baseEp(),
    memberBonusPct: num("memberBonus"),
    holopass: $("holopass").checked,
    rounding: $<HTMLSelectElement>("rounding").value as Rounding,
  };
}

function songSource(): SongSource {
  if (radio("songMode") === "manual") {
    return { kind: "manual", lengthPct: num("manualLengthPct"), avgLength: num("manualAvgLen", 127) };
  }
  return {
    kind: "pool",
    // every song picked during an event gets the highlight bonus
    pool: weights().map((w) => ({ length: w.song.length, highlight: true, weight: w.weight })),
  };
}

function render() {
  const manual = radio("songMode") === "manual";
  $("poolBox").hidden = manual;
  $("manualBox").hidden = !manual;
  $("scoresBox").hidden = !fromScores();
  $("baseEpBox").hidden = fromScores();
  $("scoresOut").textContent = `→ base EP ≈ ${baseEp().toFixed(1)} per play (multi-live fit, ±0.1%)`;

  const endDate = $("endDate").value;
  const [y, m, d] = endDate.split("-").map(Number);
  $("endLocal").textContent = y
    ? `Ends ${new Date(Date.UTC(y, m - 1, d, EVENT_END_HOUR_UTC)).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} your time`
    : "";

  const warnings: string[] = [];
  const src = songSource();
  if (src.kind === "pool" && src.pool.length === 0) warnings.push("Pick the event members, or switch songs to manual.");

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
    if (opts.baseEp <= 0) warnings.push("Set your typical scores or a base EP per play.");
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
  const head =
    "<tr><th>boosts</th><th>× table</th><th>length %</th><th>pts / play</th><th>pts / boost</th><th>plays</th><th>time</th>" +
    '<th title="Hours per day you\'d have to play, spread over the time left">per day</th>' +
    '<th title="Drinks spent after natural stamina (drinks are used before gems)">drinks</th><th title="Gems spent once drinks run out">gems</th></tr>';
  const daysLeft = mins / 1440;
  const body = levels
    .map((l) => {
      const p = singleLevel(l.k, input);
      const perDay = daysLeft > 0 ? p.playSec / 3600 / daysLeft : Infinity;
      // ok: fits your daily hours · over: needs more than your daily hours · no: can't finish before the event ends
      const cls = p.playSec <= balancedSec ? "ok" : p.feasible ? "over" : "no";
      const perDayText = cls === "no" ? "too slow" : `${perDay.toFixed(1)}h`;
      return `<tr class="${used.has(l.k) ? "inplan" : ""}">
        <td>${l.k}</td><td>${BOOST_MULT[l.k]}</td><td>${(lengthPctAt.get(l.k) ?? 0).toFixed(1)}</td>
        <td>${fmt(l.points)}</td><td>${l.k === 0 ? "free" : (l.points / l.k).toFixed(1)}</td>
        <td>${fmt(p.plays)}</td><td>${fmtDuration(p.playSec)}</td><td class="${cls}">${perDayText}</td>
        <td>${fmt(p.drinksSpent)}</td><td>${fmt(p.gemsSpent)}</td></tr>`;
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
  (document.querySelector('input[name="baseMode"][value="manual"]') as HTMLInputElement).checked = true;
  $("calibOut").textContent =
    `${r.n} play${r.n === 1 ? "" : "s"}, avg ${fmt(r.meanPoints)} pts at ${k} boosts → base EP ≈ ${r.baseEp.toFixed(2)}` +
    (samples.some((x) => x.lengthPct === undefined) ? ` (assumed ${fallbackPct.toFixed(1)}% length bonus where not given)` : "");
  save();
  render();
});

$("dbRefresh").addEventListener("click", () => void refreshDb(true));
$("redetect").addEventListener("click", () => {
  redetectEventSongs();
  rebuildSongUi();
  save();
  render();
});

fillMembers();
load();
dbStatus();
render();
const onEdit = (e: Event) => {
  const t = e.target as HTMLInputElement;
  if (e.type === "change" && t.closest("#poolList")) {
    if (t.checked) eventIds.add(t.value);
    else eventIds.delete(t.value);
    rebuildSongUi();
  } else if (MEMBER_IDS.includes(t.id) || t.name === "eventType") {
    if (e.type === "change") { redetectEventSongs(); rebuildSongUi(); }
  } else if (t.id === "includeEveryone" || t.id === "eventChance") {
    rebuildSongUi();
  }
  save();
  render();
};
form.addEventListener("input", onEdit);
form.addEventListener("change", onEdit);
form.addEventListener("submit", (e) => e.preventDefault());
setInterval(render, 60_000); // time left ticks down
void refreshDb(); // fetch fresh song data if ours is over a day old
