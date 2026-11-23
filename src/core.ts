// The app's rules, with no page or storage code: saved-progress upgrades, the FSRS scheduler, which flags
// are new today, building and running a session, checking and grading answers, and settings.
// page.ts imports it (build.ts bundles both into index.html), and test/core.test.ts tests it in Node.

/* ---------- Types ---------- */
// A country's code, lowercase ("fr"). It names the flag's SVG in src/flags/ too.
export type Code = string;
export type Region = "Africa" | "Americas" | "Asia" | "Europe" | "Oceania";
// A country, as src/countries.ts lists it. c: code, n: display name, a: other accepted answers, r: region,
// h: hook (the visual "tell"), optional: a flag only asked about when its setting is on (Kosovo).
export interface Country {
  c: Code;
  n: string;
  a?: readonly string[];
  r: Region;
  h: string;
  optional?: boolean;
}
// Look-alike flags, introduced together and used as each other's wrong answers.
export type Family = readonly Code[];
// For each flag, the most similar-looking flags (src/neighbors.json), used as extra wrong answers.
export type Neighbors = Readonly<Record<Code, readonly Code[]>>;
// What createCore works on.
export interface CoreData {
  countries: readonly Country[];
  families: readonly Family[];
  neighbors: Neighbors;
}

// How a flag is asked: multiple choice ("mc") or typing its name ("typed").
export type Stage = "mc" | "typed";
// 1 again, 2 hard, 3 good.
export type Grade = 1 | 2 | 3;
// A flag's progress, once it has been introduced. Days are day numbers (see dayNum). S and D: FSRS stability
// (in days) and difficulty (1 to 10). streak: right answers in a row at this stage. reps: times graded.
// lapses: misses while at typing. last: the day last graded. due: the day it's due. missedOn: the last day it
// was missed.
export interface Card {
  stage: Stage;
  streak: number;
  reps: number;
  lapses: number;
  S: number;
  D: number;
  last: number;
  due: number;
  missedOn?: number;
}
// One day's counters. n: the day number. newDone: new flags introduced. bonus: new flags added by "Learn 5 more".
export interface DayCounters {
  n: number;
  newDone: number;
  bonus: number;
}
export type Theme = "system" | "light" | "dark";
export interface Settings {
  perDay: number;
  kosovo: boolean;
  theme: Theme;
}
// Saved progress. cards: one per flag introduced. confusions: how often a flag was taken for another, keyed
// "flag>taken for".
export interface State {
  v: number;
  cards: Record<Code, Card>;
  day: DayCounters;
  settings: Settings;
  confusions: Record<string, number>;
}
// What createCore gets from its caller (see createCore).
export interface Env {
  state: () => State;
  now?: () => number;
  random?: () => number;
  changed?: () => void;
}

// A flag's FSRS memory state: S, stability in days, and D, difficulty.
export interface Memory {
  S: number;
  D: number;
}
export type Status = "new" | "learning" | "mastered";
// Today's reviews, and new flags in groups that are introduced together. nNew: how many new flags in all.
export interface Plan {
  due: Code[];
  groups: Code[][];
  nNew: number;
}
// What a typed answer means for flag c (see judge).
export type Judgment =
  | { empty: true }
  | { ambiguous: true }
  | { ok: true; typo?: true; guess?: undefined }
  | { ok: false; guess?: Code; typo?: undefined };

// A session is "normal", "more" ("Learn 5 more", which becomes a normal session) or "extra" (extra practice).
export type Mode = "normal" | "more" | "extra";
// A run of extra practice (see afterRound).
export interface Run {
  n: number;
  skip: Set<Code>;
  last: Set<Code>;
}
// A session's items: an intro shows a new flag, an ask asks for it (n: the attempt, from 1).
export interface IntroItem {
  k: "intro";
  c: Code;
}
export interface AskItem {
  k: "ask";
  c: Code;
  n: number;
}
export type SessionItem = IntroItem | AskItem;
// How a question is asked: as multiple choice, with its options in order, or by typing.
export type Question = { view: "mc"; options: Code[] } | { view: "typed" };
// An answer: a choice picked, a name typed, or "I don't know".
export type Answer = { pick: Code } | { typed: string } | { dunno: true };
// ms: time taken to answer. firstKeyMs: time to the first key typed, or null.
export interface AnswerTiming {
  ms?: number;
  firstKeyMs?: number | null;
}
export type Verdict = "right" | "typo" | "hinted" | "miss" | "empty" | "ambiguous";
// What an answer meant (see answer in session).
export interface AnswerResult {
  verdict: Verdict;
  guess: Code | null;
  quick: boolean;
}
// A session's summary (see end in session).
export interface Summary {
  mode: Mode;
  right: number;
  total: number;
  mixups: Code[][];
}
export interface SessionEnd {
  summary: Summary;
  run: Run | undefined;
}
// One session (see session in createCore).
export interface Session {
  mode: Mode;
  current(): SessionItem | null;
  progress(): { done: number; total: number };
  next(): boolean;
  question(opts?: { hint?: boolean }): Question | null;
  answer(a: Answer, timing?: AnswerTiming): AnswerResult | null;
  end(): SessionEnd;
}
export type Core = ReturnType<typeof createCore>;

/* ---------- Saved progress ---------- */
export const VERSION = 2;
export function blankState(): State {
  return {
    v: VERSION,
    cards: {},
    day: { n: 0, newDone: 0, bonus: 0 },
    settings: { perDay: 10, kosovo: false, theme: "system" },
    confusions: {},
  };
}
// Whatever was in storage, once it's known to be an object.
type Saved = Record<string, unknown>;
const isObj = (x: unknown): x is Saved => x !== null && typeof x === "object" && !Array.isArray(x);
// UPGRADES[k] turns a version-k save into a version k + 1 save. Add a step whenever the saved shape changes.
const UPGRADES: Record<number, (s: Saved) => void> = {
  // settings.dark (true/false) became settings.theme ("system", "light" or "dark"). A theme already there is kept,
  // so the step does no harm to a save that already has the newer shape.
  1: (s) => {
    const st: Saved = isObj(s.settings) ? s.settings : {};
    if (!("theme" in st)) st.theme = st.dark ? "dark" : "system";
    delete st.dark;
    s.settings = st;
  },
};
// The version that wrote a save (an object). No version, or one below 1 or not a number, means version 1, the one
// that had no v. Anything past VERSION is newer, fraction or not. Otherwise a fraction counts as the version below it.
function savedVersion(saved: Saved): number {
  const v = Number(saved.v);
  return !(v >= 1) ? 1 : v > VERSION ? v : Math.floor(v);
}
// True when the save was written by a newer version of Hoist (open in another tab). Such a save can be
// shown, but this version must not write over it: it doesn't know the newer fields.
export function isNewer(saved: unknown): boolean {
  return isObj(saved) && savedVersion(saved) > VERSION;
}
// Turns whatever was in storage into a current-version state, filling in anything missing. A save gets the
// upgrade steps from its version (see savedVersion) up, so a newer save gets none.
// Only the type of each part is checked: what's inside cards, confusions, day and settings is taken as saved.
export function migrate(saved: unknown): State {
  if (!isObj(saved)) return blankState();
  for (let v = savedVersion(saved); v < VERSION; v++) UPGRADES[v](saved);
  const b = blankState();
  return {
    v: VERSION,
    cards: isObj(saved.cards) ? (saved.cards as State["cards"]) : b.cards,
    day: Object.assign(b.day, isObj(saved.day) ? saved.day : {}),
    settings: Object.assign(b.settings, isObj(saved.settings) ? saved.settings : {}),
    confusions: isObj(saved.confusions) ? (saved.confusions as State["confusions"]) : b.confusions,
  };
}

/* ---------- FSRS-4.5 scheduler ---------- */
export const W = [
  0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072,
  0.0793, 0.3246, 1.587, 0.2272, 2.8755,
];
const DECAY = -0.5,
  FACTOR = 19 / 81,
  RETAIN = 0.9;
const clampD = (d: number) => Math.min(10, Math.max(1, d));
export const retr = (t: number, s: number) => Math.pow(1 + (FACTOR * t) / s, DECAY);
export const ivlFor = (s: number) => (s / FACTOR) * (Math.pow(RETAIN, 1 / DECAY) - 1);
// g here can also be 4 (easy), which FSRS uses as a reference point.
const D0 = (g: number) => clampD(W[4] - (g - 3) * W[5]);
// The memory state after grading g, from st (null for a first answer) after `elapsed` days.
export function fsrs(st: Memory | null, g: Grade, elapsed: number): Memory {
  if (!st) return { S: W[g - 1], D: D0(g) };
  const r = retr(elapsed, st.S);
  let D = st.D - W[6] * (g - 3);
  D = clampD(W[7] * D0(4) + (1 - W[7]) * D);
  let s: number;
  if (g === 1)
    s = Math.min(
      st.S,
      W[11] * Math.pow(st.D, -W[12]) * (Math.pow(st.S + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r)),
    );
  else
    s =
      st.S *
      (1 +
        Math.exp(W[8]) *
          (11 - st.D) *
          Math.pow(st.S, -W[9]) *
          (Math.exp(W[10] * (1 - r)) - 1) *
          (g === 2 ? W[15] : 1));
  return { S: Math.max(0.1, s), D };
}

/* ---------- Randomness ---------- */
function shuffle<T>(list: readonly T[], rand: () => number): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/*
 * data: {countries, families, neighbors}
 * env:  {state: () => the current state, now?: () => ms (default Date.now), random?: () => [0, 1) (default Math.random),
 *        changed?: () => saved progress changed (default: does nothing)}
 * Every function reads env.state() when called, so the page can swap in a freshly loaded state.
 * Functions here change the state but never save it. Instead, any call that changes it calls env.changed(), meaning
 * "saved progress changed during this call: save once the call is over". Not right away: the change may not be done
 * yet (a caller can change what touchDay() returns, say).
 */
export function createCore(data: CoreData, env: Env) {
  const COUNTRIES = data.countries,
    FAMILIES = data.families,
    NEIGHBORS = data.neighbors;
  const state = env.state,
    now = env.now || Date.now,
    random = env.random || Math.random,
    changed = env.changed || (() => {});
  const BY: Record<Code, Country> = {};
  COUNTRIES.forEach((c) => (BY[c.c] = c));
  const SIB: Record<Code, Code[]> = {};
  FAMILIES.forEach((f) => f.forEach((c) => (SIB[c] = f.filter((x) => x !== c))));

  /* ---------- Days: a day rolls over at 4am local time ---------- */
  function dayNum(): number {
    const d = new Date(now() - 4 * 3600e3);
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
  }
  // Today's counters, as a copy, so changing it can't change the state (touchDay gives the stored ones).
  // Counters from an earlier day read as zeros.
  function today(): DayCounters {
    const t = dayNum(),
      d = state().day;
    return d.n === t ? Object.assign({}, d) : { n: t, newDone: 0, bonus: 0 };
  }
  // Today's counters, stored in the state so they can be changed. Calling it counts as a change (see env.changed).
  function touchDay(): DayCounters {
    const s = state();
    s.day = today();
    changed();
    return s.day;
  }

  /* ---------- Flags and their status ---------- */
  function active(): Code[] {
    return COUNTRIES.filter((c) => !c.optional || state().settings.kosovo).map((c) => c.c);
  }
  function isActive(c: Code): boolean {
    return !!BY[c] && (!BY[c].optional || state().settings.kosovo);
  }
  // A flag's card, or undefined for a flag not introduced yet.
  function card(c: Code): Card | undefined {
    return state().cards[c];
  }
  // The card of a flag known to have one: introduced, due, or practiced.
  function stored(c: Code): Card {
    const k = card(c);
    if (!k) throw new Error(`"${c}" has no card: it hasn't been introduced`);
    return k;
  }
  function seen(c: Code): boolean {
    return !!card(c);
  }
  function mastered(c: Code): boolean {
    const k = card(c);
    return !!k && k.stage === "typed" && k.S >= 21;
  }
  function status(c: Code): Status {
    return !seen(c) ? "new" : mastered(c) ? "mastered" : "learning";
  }
  function dueList(): Code[] {
    const t = dayNum();
    return active().filter((c) => {
      const k = card(c);
      return !!k && k.due <= t;
    });
  }
  // Flags answered at least once: the ones extra practice draws from.
  function practiced(): Code[] {
    return active().filter((c) => (card(c)?.reps ?? 0) > 0);
  }
  function newAllowance(): number {
    const d = today();
    return Math.max(0, state().settings.perDay + d.bonus - d.newDone);
  }

  /* ---------- Look-alikes and wrong answers ---------- */
  function confusedWith(c: Code): Code[] {
    const conf = state().confusions,
      m: Record<Code, number> = {};
    for (const k in conf) {
      const [a, b] = k.split(">");
      if (a === c) m[b] = (m[b] || 0) + conf[k];
      else if (b === c) m[a] = (m[a] || 0) + conf[k];
    }
    return Object.keys(m)
      .filter(isActive)
      .sort((x, y) => m[y] - m[x]);
  }
  // Collects distinct active codes other than `c`, in the order they are added.
  function collector(c: Code) {
    const out: Code[] = [];
    return {
      out,
      add: (x: Code) => {
        if (x !== c && isActive(x) && !out.includes(x)) out.push(x);
      },
    };
  }
  function lookalikes(c: Code, n?: number): Code[] {
    const { out, add } = collector(c);
    (SIB[c] || []).forEach(add);
    confusedWith(c).forEach(add);
    if (out.length < 2) (NEIGHBORS[c] || []).slice(0, 3).forEach(add);
    return out.slice(0, n || 5);
  }
  function distractors(c: Code): Code[] {
    const { out, add } = collector(c);
    const conf = confusedWith(c);
    if (conf[0]) add(conf[0]);
    shuffle(SIB[c] || [], random).forEach(add);
    conf.slice(1).forEach(add);
    (NEIGHBORS[c] || []).forEach(add);
    for (const x of shuffle(active(), random)) {
      if (out.length >= 3) break;
      add(x);
    }
    return out.slice(0, 3);
  }

  /* ---------- New flags: look-alike families come in together, mixed with stand-alone flags ---------- */
  const UNITS = (() => {
    const r = rng(196);
    const inFam = new Set(FAMILIES.flat());
    const fams = shuffle(FAMILIES, r),
      singles = shuffle(
        COUNTRIES.map((c) => c.c)
          .filter((c) => !inFam.has(c))
          .map((c) => [c]),
        r,
      );
    const units: Family[] = [];
    let s = 0;
    for (const f of fams) {
      units.push(f);
      for (let k = 0; k < 2 && s < singles.length; k++) units.push(singles[s++]);
    }
    while (s < singles.length) units.push(singles[s++]);
    return units;
  })();
  // Groups of new flags for a day with room for `n`. A family can run up to 2 over so it isn't split.
  function pickNew(n: number): Code[][] {
    const groups = [];
    let left = n;
    for (const u of UNITS) {
      if (left <= 0) break;
      const m = u.filter((c) => isActive(c) && !seen(c));
      if (!m.length) continue;
      if (m.length <= left + 2) {
        groups.push(m);
        left -= m.length;
      }
    }
    return groups;
  }
  // Today's reviews and new flags. The home screen and the session both use this, so their counts agree.
  function planToday(): Plan {
    const due = dueList(),
      groups = pickNew(newAllowance());
    return { due, groups, nNew: groups.reduce((n, g) => n + g.length, 0) };
  }

  /* ---------- Answer checking ---------- */
  function norm(s: string): string {
    return s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/['’`.]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/^the /, "")
      .replace(/\bsaint\b/g, "st");
  }
  // Each accepted name, normalized, with its country.
  const NAMES: [string, Code][] = [];
  COUNTRIES.forEach((c) => [c.n].concat(c.a || []).forEach((n) => NAMES.push([norm(n), c.c])));
  const EXACT = new Map(NAMES);
  // Edit distance where swapping two neighboring letters counts as one edit, like a dropped or extra letter.
  function lev(a: string, b: string): number {
    if (Math.abs(a.length - b.length) > 3) return 9;
    // prev2 is read only from the third row on, once it holds the row two back.
    let prev2: number[] = [],
      prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
          cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      }
      prev2 = prev;
      prev = cur;
    }
    return prev[b.length];
  }
  // {empty} for a blank answer, {ok} for the right name, {ok, typo} for a near miss of the right name only,
  // {ambiguous} for a typo as close to another country as to the right one (there's no telling which was
  // meant: "Austrlia" could be Australia or Austria), and {ok: false, guess?} otherwise.
  function judge(input: string, c: Code): Judgment {
    const q = norm(input);
    if (!q) return { empty: true };
    const ex = EXACT.get(q);
    if (ex && isActive(ex)) return ex === c ? { ok: true } : { ok: false, guess: ex };
    let best = 9,
      hits = new Set<Code>();
    for (const [n, code] of NAMES) {
      if (!isActive(code)) continue;
      const tol = n.length <= 4 ? 0 : n.length <= 7 ? 1 : 2;
      const d = lev(q, n);
      if (d > tol) continue;
      if (d < best) {
        best = d;
        hits = new Set([code]);
      } else if (d === best) hits.add(code);
    }
    const others = [...hits].filter((x) => x !== c);
    if (hits.has(c)) return others.length ? { ambiguous: true } : { ok: true, typo: true };
    return others.length ? { ok: false, guess: others[0] } : { ok: false };
  }

  /* ---------- Grading ---------- */
  // Returns true if the flag was new.
  function introduce(c: Code): boolean {
    if (seen(c)) return false;
    const t = dayNum();
    state().cards[c] = {
      stage: "mc",
      streak: 0,
      reps: 0,
      lapses: 0,
      S: 0,
      D: 0,
      last: t,
      due: t,
    };
    touchDay().newDone++;
    changed();
    return true;
  }
  // g: 1 again, 2 hard, 3 good. A flag starts as multiple choice ("mc") and moves to typing ("typed") after
  // two right answers in a row; a typing miss sends it back. keepStage makes a miss leave the flag at typing:
  // used for a right pick after "Show choices" (recognized, but the name wasn't recalled).
  function grade(c: Code, g: Grade, { keepStage = false }: { keepStage?: boolean } = {}): void {
    introduce(c);
    const t = dayNum(),
      k = stored(c);
    const first = !k.reps,
      elapsed = Math.max(0, t - k.last);
    const st = fsrs(first ? null : { S: k.S, D: k.D }, g, elapsed);
    k.S = st.S;
    k.D = st.D;
    k.reps++;
    k.last = t;
    const ok = g > 1;
    let graduated = false;
    if (!ok) k.missedOn = t; // each new run of extra practice starts with flags missed today
    if (k.stage === "mc") {
      if (ok) {
        k.streak++;
        if (k.streak >= 2) {
          k.stage = "typed";
          k.streak = 0;
          graduated = true;
        }
      } else k.streak = 0;
    } else if (ok) k.streak++;
    else {
      k.lapses++;
      if (keepStage) k.streak = 0;
      else {
        k.stage = "mc";
        k.streak = 1;
      }
    }
    let ivl =
      first || !ok
        ? 1
        : Math.max(1, Math.round(ivlFor(k.S) * (k.S > 3 ? 0.95 + random() * 0.1 : 1)));
    if (k.stage === "mc") ivl = Math.min(ivl, 2); // recognition alone doesn't earn long gaps
    if (graduated) ivl = Math.min(ivl, 3); // first typed recall comes soon after graduating
    k.due = t + ivl;
    changed();
  }

  /* ---------- Sessions ---------- */
  // Picks up to n items from `list` at random, without repeats. An item with twice the weight is about twice
  // as likely to be picked (Efraimidis-Spirakis sampling). Weights must be above 0.
  function draw<T>(list: readonly T[], weight: (x: T) => number, n: number): T[] {
    return list
      .map((x): [T, number] => [x, Math.log(random()) / weight(x)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map((p) => p[0]);
  }
  // How likely a flag is to be forgotten by tomorrow. Tomorrow rather than today, because every flag reviewed
  // today would read as certain: this way a shaky flag answered today still outweighs a solid one.
  // The floor gives even well-known flags a small chance.
  function weakness(c: Code): number {
    const k = stored(c);
    return Math.max(0.01, 1 - retr(dayNum() + 1 - k.last, Math.max(k.S, 0.1)));
  }
  // Up to n of `list` for extra practice: flags missed today first, then a random draw that favors weak flags.
  function pickExtra(list: Code[], n: number): Code[] {
    if (n <= 0) return [];
    const t = dayNum();
    const missed = draw(
      list.filter((c) => stored(c).missedOn === t),
      () => 1,
      n,
    );
    return missed.concat(
      draw(
        list.filter((c) => stored(c).missedOn !== t),
        weakness,
        n - missed.length,
      ),
    );
  }
  // Extra practice comes in runs: a round from the home screen, then any number of "Another" rounds.
  // run: {n: flags per round (Infinity for all of them), skip: flags practiced so far in the run,
  //       last: the round just done}.
  // Returns the run after a round in which the flags in `done` were answered. Once the run has covered every
  // practiced flag it starts over, still holding back the round just done.
  function afterRound(run: Run, done: Set<Code>): Run {
    const all = new Set([...run.skip, ...done]);
    return {
      n: run.n,
      skip: practiced().every((c) => all.has(c)) ? new Set(done) : all,
      last: new Set(done),
    };
  }

  // The session's items in order: {k: "intro", c} shows a new flag, {k: "ask", c, n} asks for it (n = attempt).
  // For "extra", the second argument is the run (see afterRound). A round takes flags new to the run first,
  // then flags from its earlier rounds, and flags from the round just done only if there still aren't enough.
  // Within each group, flags missed today come first, so they lead every new run.
  function buildQueue(
    mode: "normal" | "extra",
    { n = 20, skip = new Set(), last = new Set() }: Partial<Run> = {},
  ): SessionItem[] {
    if (mode === "extra") {
      const pool = practiced(),
        picks: Code[] = [];
      const groups = [
        pool.filter((c) => !skip.has(c) && !last.has(c)),
        pool.filter((c) => skip.has(c) && !last.has(c)),
        pool.filter((c) => last.has(c)),
      ];
      for (const g of groups) picks.push(...pickExtra(g, n - picks.length));
      return shuffle(picks, random).map((c) => ({ k: "ask", c, n: 1 }));
    }
    const plan = planToday();
    const reviews = shuffle(plan.due, random)
      .sort((a, b) => stored(a).due - stored(b).due)
      .slice(0, 120);
    const rv = shuffle(reviews, random).map((c): AskItem => ({ k: "ask", c, n: 1 }));
    const items: SessionItem[] = [];
    let pending: AskItem[] = [];
    for (const g of plan.groups) {
      g.forEach((c) => items.push({ k: "intro", c }));
      items.push(...shuffle(pending, random));
      pending = g.map((c) => ({ k: "ask", c, n: 1 }));
    }
    items.push(...shuffle(pending, random));
    const out: SessionItem[] = [];
    const total = items.length + rv.length;
    let ri = 0,
      ii = 0;
    for (let p = 0; p < total; p++) {
      const want = Math.round(((p + 1) * rv.length) / total);
      if (ri < want || ii >= items.length) out.push(rv[ri++]);
      else out.push(items[ii++]);
    }
    return out;
  }

  // One session: its queue, what each answer means, when a missed flag comes back, and the summary.
  // mode: "normal", "more" ("Learn 5 more": 5 more new flags today, then a normal session) or "extra" (run: the
  // extra practice run, see afterRound). Returns null when there's nothing to practice.
  function session(mode: Mode, run?: Run): Session | null {
    if (mode === "more") {
      touchDay().bonus += 5;
      mode = "normal";
    }
    const q = mode === "extra" ? buildQueue("extra", run) : buildQueue(mode);
    if (!q.length) return null;
    // i: the item on screen (-1 before the first). view: the question's form once shown. hint: choices were
    // asked for on the question on screen. answered: the question on screen has its answer.
    let i = -1,
      view: Question["view"] | null = null,
      hint = false,
      answered = false;
    const graded = new Set<Code>(),
      tried = new Set<Code>(),
      first = { right: 0, total: 0 },
      mixups: Code[][] = [];
    const item = () => (i >= 0 && i < q.length ? q[i] : null);

    // The item on screen: {k: "intro", c} or {k: "ask", c, n} (n = attempt), or null once the session is over.
    function current(): SessionItem | null {
      const it = item();
      return it && Object.assign({}, it);
    }
    // done: items finished, out of total (which grows when a missed flag is queued again).
    function progress() {
      return { done: Math.max(0, i), total: q.length };
    }
    // Moves to the next item, the first one the first time. An intro for a flag another tab has introduced
    // meanwhile is skipped. Returns true if it introduced a new flag.
    function next(): boolean {
      if (i >= q.length) return false;
      i++;
      while (i < q.length && q[i].k === "intro" && seen(q[i].c)) i++;
      view = null;
      hint = false;
      answered = false;
      const it = item();
      return !!it && it.k === "intro" && introduce(it.c);
    }
    // How to ask the flag on screen: typing once it has reached that stage, unless choices were asked for
    // (hint: "Show choices", which holds until next(): asking again without it can't go back to typing). A flag
    // still at multiple choice has no "Show choices", so hint does nothing there.
    // Returns {view: "mc", options} or {view: "typed"}, or null if there's nothing to ask.
    function question({ hint: h = false }: { hint?: boolean } = {}): Question | null {
      const it = item();
      if (!it || it.k !== "ask" || answered) return null;
      const c = it.c,
        k = card(c),
        stage = k ? k.stage : "mc";
      hint = hint || (!!h && stage === "typed");
      view = hint || stage === "mc" ? "mc" : "typed";
      return view === "mc"
        ? { view, options: shuffle([c].concat(distractors(c)), random) }
        : { view };
    }
    // a: {pick: code} for multiple choice, {typed: text} for typing, or {dunno: true} for "I don't know".
    // ms: time taken to answer. firstKeyMs: time to the first key typed, or null. Without ms, an answer is neither
    // slow nor quick: NaN fails every comparison.
    // Returns {verdict, guess, quick}, or null if there's no question to answer or it has its answer already.
    // verdict: "right", "typo", "hinted" (right, but after "Show choices", so it counts as a miss) or "miss". For
    // typing it can also be "empty" (show choices instead) or "ambiguous" (ask for a retype): those aren't answers.
    // guess: the country answered instead, if any. quick: a fast miss, which comes back sooner.
    function answer(a: Answer, { ms = NaN, firstKeyMs }: AnswerTiming = {}): AnswerResult | null {
      const it = item();
      if (!it || it.k !== "ask" || answered || !view) return null;
      const c = it.c;
      let r: Settled;
      if ("dunno" in a) r = { ok: false, guess: null, g: 1 };
      else if ("pick" in a) {
        if (view !== "mc") return null;
        const ok = a.pick === c;
        r = {
          ok,
          guess: ok ? null : a.pick,
          g: !ok || hint ? 1 : ms > 6000 ? 2 : 3,
          hinted: ok && hint,
          quick: !ok && ms < 2200 && !hint,
        };
      } else {
        if (view !== "typed") return null;
        const j = judge(a.typed, c);
        if ("empty" in j) return { verdict: "empty", guess: null, quick: false };
        if ("ambiguous" in j) return { verdict: "ambiguous", guess: null, quick: false };
        r = {
          ok: j.ok,
          guess: j.guess || null,
          typo: j.typo,
          g: !j.ok ? 1 : j.typo || ms > 12000 ? 2 : 3,
          quick: !j.ok && !!j.guess && firstKeyMs != null && firstKeyMs < 2500,
        };
      }
      answered = true;
      settle(it, r);
      return {
        verdict: r.hinted ? "hinted" : !r.ok ? "miss" : r.typo ? "typo" : "right",
        guess: r.guess,
        quick: !!r.quick,
      };
    }
    // What an answer settled: ok, right; guess, the country answered instead; g, the grade; hinted, typo and
    // quick as in answer().
    interface Settled {
      ok: boolean;
      guess: Code | null;
      g: Grade;
      hinted?: boolean;
      typo?: boolean;
      quick?: boolean;
    }
    // r.g: the grade. r.hinted: a right pick after "Show choices", which counts as a miss everywhere but leaves the
    // flag at typing. A flag counts toward the first-try score, and is graded, only at its first answer.
    function settle(it: AskItem, r: Settled): void {
      const c = it.c,
        missed = !r.ok || r.hinted;
      if (!tried.has(c)) {
        tried.add(c);
        first.total++;
        if (!missed) first.right++;
      }
      if (mode !== "extra" && !graded.has(c)) {
        grade(c, r.g, { keepStage: r.hinted });
        graded.add(c);
      }
      if (r.guess && r.guess !== c) {
        const conf = state().confusions,
          key = c + ">" + r.guess;
        conf[key] = (conf[key] || 0) + 1;
        changed();
        mixups.push([c, r.guess]);
      }
      // A missed flag comes back a few cards later (sooner after a quick miss), up to 3 asks in all.
      if (missed && it.n < 3)
        q.splice(Math.min(q.length, i + 1 + (r.quick ? 3 : 5)), 0, { k: "ask", c, n: it.n + 1 });
    }
    // summary: {mode, right: flags right at their first answer, total: flags answered, mixups: [[flag, taken for],
    // ...], each pair once, in the order they happened}. run: for extra practice, the run after this round.
    function end(): SessionEnd {
      const mix = [...new Set(mixups.map(([a, b]) => a + ">" + b))].map((k) => k.split(">"));
      let after = run;
      if (mode === "extra") {
        if (!run) throw new Error('Extra practice needs its run: session("extra", run)');
        after = afterRound(run, tried);
      }
      return {
        summary: { mode, right: first.right, total: first.total, mixups: mix },
        run: after,
      };
    }
    return { mode, current, progress, next, question, answer, end };
  }

  /* ---------- Settings ---------- */
  // Changes a setting, which must be one a fresh save has: a new setting goes in blankState(), where the
  // saved-shape test sees it.
  function setSetting<K extends keyof Settings>(name: K, value: Settings[K]): void {
    if (!Object.keys(blankState().settings).includes(name))
      throw new Error(`Unknown setting "${name}"`);
    state().settings[name] = value;
    changed();
  }

  return {
    BY,
    dayNum,
    today,
    touchDay,
    active,
    isActive,
    card,
    seen,
    mastered,
    status,
    dueList,
    practiced,
    newAllowance,
    lookalikes,
    distractors,
    pickNew,
    planToday,
    judge,
    introduce,
    grade,
    buildQueue,
    afterRound,
    session,
    setSetting,
    shuffle: <T>(a: readonly T[]) => shuffle(a, random),
  };
}
