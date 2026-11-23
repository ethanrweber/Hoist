// Tests for src/core.js. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { COUNTRIES, FAMILIES } = require("../src/countries.js");
const NEIGHBORS = require("../src/neighbors.json");
const HoistCore = require("../src/core.js");
const { blankState, isNewer, migrate, VERSION, fsrs, retr, ivlFor, W } = HoistCore;

const DAY = 864e5;
// A core over fresh progress, with a clock the test moves forward and fixed randomness (or `random`).
// `Core` is what src/core.js exports: the one Node loaded, unless a test loads its own (see sandboxedCore).
function setup(settings, random = () => 0.5, Core = HoistCore){
  const t = { S: Core.blankState(), now: Date.UTC(2026, 0, 15, 12) };
  Object.assign(t.S.settings, settings);
  t.core = Core.createCore({ countries: COUNTRIES, families: FAMILIES, neighbors: NEIGHBORS },
    { state: () => t.S, now: () => t.now, random });
  t.nextDay = () => { t.now += DAY; };
  return t;
}

/* ---------- Answer checking ---------- */
test("answer checking: names, other accepted names, accents and punctuation", () => {
  const { judge } = setup().core;
  assert.deepEqual(judge("France", "fr"), { ok: true });
  assert.deepEqual(judge("holland", "nl"), { ok: true });
  assert.deepEqual(judge("Cote d'Ivoire", "ci"), { ok: true });
  assert.deepEqual(judge("St. Kitts & Nevis", "kn"), { ok: true });
  assert.deepEqual(judge("Dominican", "do"), { ok: true });
  assert.deepEqual(judge("   ", "fr"), { empty: true });
});

test("answer checking: accented letters and curly apostrophes count the same as plain ones", () => {
  const { judge } = setup().core;
  assert.deepEqual(judge("Côte d’Ivoire", "ci"), { ok: true });
  assert.deepEqual(judge("São Tomé and Príncipe", "st"), { ok: true });
  // Accents and apostrophes that no stored name has: these match only if they're stripped.
  assert.deepEqual(judge("São Tome", "st"), { ok: true });
  assert.deepEqual(judge("México", "mx"), { ok: true });
  assert.deepEqual(judge("People’s Republic of China", "cn"), { ok: true });
});

test("answer checking: another country's name is wrong, with that country as the guess", () => {
  const { judge } = setup().core;
  assert.deepEqual(judge("Romania", "td"), { ok: false, guess: "ro" });
  assert.deepEqual(judge("Dominica", "do"), { ok: false, guess: "dm" });
});

test("answer checking: a typo of only the right name counts, marked as a typo", () => {
  const { judge } = setup().core;
  assert.deepEqual(judge("Argentna", "ar"), { ok: true, typo: true });
});

test("answer checking: a typo as close to another country as to the right one asks for a retype", () => {
  const { judge } = setup().core;
  assert.deepEqual(judge("Nigeri", "ne"), { ambiguous: true });
  assert.deepEqual(judge("Nigeri", "ng"), { ambiguous: true });
  assert.deepEqual(judge("Austrlia", "au"), { ambiguous: true });
  assert.deepEqual(judge("Austrlia", "at"), { ambiguous: true });
  // A tie between two other countries is simply wrong.
  assert.deepEqual(judge("Nigeri", "fr"), { ok: false, guess: "ne" });
});

test("answer checking: a one-letter slip of the right name is never blamed on another country", () => {
  const { judge } = setup().core;
  const blamed = [];
  for (const c of COUNTRIES){
    if (c.optional) continue;
    const n = c.n.toLowerCase(), slips = new Set();
    for (let i = 0; i < n.length; i++) slips.add(n.slice(0, i) + n.slice(i + 1));                            // dropped letter
    for (let i = 0; i < n.length - 1; i++) slips.add(n.slice(0, i) + n[i + 1] + n[i] + n.slice(i + 2));       // swapped letters
    for (const s of slips) if (s !== n && judge(s, c.c).guess) blamed.push(`${s} (${c.c} -> ${judge(s, c.c).guess})`);
  }
  assert.deepEqual(blamed, []);
});

test("answer checking: Kosovo only counts as an answer when it's switched on", () => {
  assert.deepEqual(setup().core.judge("Kosovo", "cy"), { ok: false });
  assert.deepEqual(setup({ kosovo: true }).core.judge("Kosovo", "cy"), { ok: false, guess: "xk" });
});

/* ---------- Stages and grading ---------- */
test("stages: two right multiple-choice answers move a flag to typing; a typing miss sends it back", () => {
  const t = setup(), { grade, card } = t.core;
  grade("fr", 3);
  assert.equal(card("fr").stage, "mc");
  t.nextDay(); grade("fr", 3);
  assert.equal(card("fr").stage, "typed");
  t.nextDay(); grade("fr", 1);
  assert.equal(card("fr").stage, "mc");
});

test("stages: a right pick after Show choices is a miss that keeps the flag at typing", () => {
  const t = setup(), { grade, card, dayNum } = t.core;
  grade("fr", 3); t.nextDay(); grade("fr", 3);
  for (let i = 0; i < 4; i++){ t.nextDay(); grade("fr", 3); }
  const before = card("fr").S;
  t.nextDay(); grade("fr", 1, { keepStage: true });
  const k = card("fr");
  assert.equal(k.stage, "typed");
  assert.equal(k.streak, 0);
  assert.ok(k.S < before, "stability should drop like any miss");
  assert.equal(k.due, dayNum() + 1);
});

test("stages: answering only through Show choices never reaches Mastered", () => {
  const t = setup(), { grade, mastered } = t.core;
  grade("fr", 3); t.nextDay(); grade("fr", 3);
  for (let i = 0; i < 60; i++){ t.nextDay(); grade("fr", 1, { keepStage: true }); }
  assert.equal(mastered("fr"), false);
});

/* ---------- Today's plan ---------- */
test("today's plan: the home screen's new-flag count matches what the session introduces", () => {
  const t = setup({ perDay: 5 }), { planToday, buildQueue, introduce } = t.core;
  let overLimit = 0;
  for (let day = 0; day < 40; day++){
    const plan = planToday();
    const intros = buildQueue("normal").filter(it => it.k === "intro").map(it => it.c);
    assert.equal(intros.length, plan.nNew, `day ${day}`);
    assert.ok(plan.nNew <= 5 + 2, `day ${day}: ${plan.nNew} new`);
    if (plan.nNew > 5) overLimit++;
    intros.forEach(introduce);
    t.nextDay();
  }
  assert.ok(overLimit > 0, "some days should run over the limit to keep a family together");
});

test("today's numbers: reading them never changes saved progress", () => {
  const t = setup();
  t.S.day = { n: 1, newDone: 7, bonus: 5 };   // left over from an earlier day
  const before = JSON.stringify(t.S);
  t.core.planToday(); t.core.newAllowance(); t.core.today();
  assert.equal(JSON.stringify(t.S), before);
  assert.equal(t.core.newAllowance(), 10);
  // With today's counters too, today() hands out a copy: only touchDay() gives the stored ones.
  Object.assign(t.core.touchDay(), { newDone: 3, bonus: 5 });
  const d = t.core.today(); d.newDone = 0; d.bonus = 0;
  assert.deepEqual(t.S.day, { n: t.core.dayNum(), newDone: 3, bonus: 5 },
    "Changing what today() returns changed saved progress. today() must return a copy: use touchDay() to change the counters.");
  assert.equal(t.core.newAllowance(), 12);
});

/* ---------- Extra practice ---------- */
// Repeatable randomness, for tests where the picks need to vary.
function seeded(s){ return () => (s = (s * 16807) % 2147483647) / 2147483647; }
// Plays `days` of normal sessions, answering everything right.
function practice(t, days){
  for (let d = 0; d < days; d++){
    for (const it of t.core.buildQueue("normal")) if (it.k === "ask") t.core.grade(it.c, 3);
    t.nextDay();
  }
}

test("extra practice: rounds on the same day draw different flags, without changing progress", () => {
  const t = setup({}, seeded(1)); practice(t, 6);
  const before = JSON.stringify(t.S);
  const rounds = Array.from({ length: 10 }, () => t.core.buildQueue("extra").map(it => it.c));
  assert.equal(JSON.stringify(t.S), before);
  for (const r of rounds) assert.equal(new Set(r).size, 20);
  assert.ok(new Set(rounds.map(r => [...r].sort().join())).size > 1, "every round drew the same flags");
  assert.ok(new Set(rounds.flat()).size > 30, "rounds should reach beyond one fixed set of 20");
});

test("extra practice: flags missed today come back in every new run, including Show choices picks", () => {
  const t = setup({}, seeded(2)); practice(t, 6);
  const [hinted, ...missed] = Object.keys(t.S.cards).slice(0, 5);
  missed.forEach(c => t.core.grade(c, 1));
  t.core.grade(hinted, 1, { keepStage: true });
  for (let i = 0; i < 30; i++){
    const r = t.core.buildQueue("extra").map(it => it.c);
    for (const c of [hinted, ...missed]) assert.ok(r.includes(c), `round ${i} is missing ${c}`);
  }
});

test("extra practice: with more than 20 flags missed today, rounds take turns among them", () => {
  const t = setup({}, seeded(3)); practice(t, 6);
  const missed = Object.keys(t.S.cards).slice(0, 25);
  missed.forEach(c => t.core.grade(c, 1));
  const shown = new Set();
  for (let i = 0; i < 10; i++){
    const r = t.core.buildQueue("extra").map(it => it.c);
    assert.equal(r.length, 20);
    assert.ok(r.every(c => missed.includes(c)), "a flag answered right took a missed flag's place");
    r.forEach(c => shown.add(c));
  }
  assert.equal(shown.size, 25);
});

const CODES = COUNTRIES.filter(c => !c.optional).map(c => c.c);
// Marks `codes` as practiced, all last answered two days ago with stability S.
function learn(t, codes, S = 5){
  const d = t.core.dayNum();
  codes.forEach(c => t.S.cards[c] = { stage: "typed", streak: 1, reps: 3, lapses: 0, S, D: 5, last: d - 2, due: d + 2 });
}
// Plays `rounds` rounds of one extra practice run, answering every flag. Returns each round's flags.
const newRun = n => ({ n, skip: new Set(), last: new Set() });
function playRun(t, n, rounds){
  let run = newRun(n); const out = [];
  for (let i = 0; i < rounds; i++){
    const q = t.core.buildQueue("extra", run).map(it => it.c);
    out.push(q); run = t.core.afterRound(run, new Set(q));
  }
  return out;
}

test("extra practice: weak flags come up more often, but strong ones still get a turn", () => {
  const t = setup({}, seeded(4));
  const weak = CODES.slice(0, 30), strong = CODES.slice(30, 60);
  learn(t, weak, 2); learn(t, strong, 60);
  const n = {};
  for (let i = 0; i < 300; i++) t.core.buildQueue("extra").forEach(it => n[it.c] = (n[it.c] || 0) + 1);
  const avg = list => list.reduce((s, c) => s + (n[c] || 0), 0) / list.length;
  assert.ok(avg(weak) > 3 * avg(strong), `weak ${avg(weak)} vs strong ${avg(strong)} times each`);
  assert.ok(strong.some(c => n[c]), "strong flags should still come up sometimes");
});

test("extra practice: a round has the size asked for, and All takes every practiced flag", () => {
  const t = setup({}, seeded(5)); learn(t, CODES.slice(0, 72));
  for (const n of [20, 50]) assert.equal(new Set(t.core.buildQueue("extra", { n }).map(it => it.c)).size, n);
  const all = t.core.buildQueue("extra", newRun(Infinity)).map(it => it.c);
  assert.deepEqual([...all].sort(), [...t.core.practiced()].sort());
  // All stays all when more flags get practiced during the run (in another tab, say).
  const run = t.core.afterRound(newRun(Infinity), new Set(all));
  learn(t, CODES.slice(72, 77));
  assert.equal(t.core.buildQueue("extra", run).length, 77);
});

test("extra practice: Another rounds repeat nothing until every flag has had a turn", () => {
  const t = setup({}, seeded(6)); learn(t, CODES.slice(0, 60));
  const [r1, r2, r3, r4] = playRun(t, 20, 4);
  assert.equal(new Set([...r1, ...r2, ...r3]).size, 60);
  // Then the run starts over, but not with the flags just practiced.
  assert.equal(r4.length, 20);
  assert.ok(r4.every(c => !r3.includes(c)), "round 4 repeated a flag from round 3");
});

test("extra practice: the round that finishes a pass fills its other places from earlier rounds", () => {
  const t = setup({}, seeded(7)); learn(t, CODES.slice(0, 50));
  const [r1, r2, r3, r4] = playRun(t, 20, 4);
  assert.equal(new Set([...r1, ...r2]).size, 40);
  const left = CODES.slice(0, 50).filter(c => !r1.includes(c) && !r2.includes(c));
  assert.equal(r3.length, 20);
  assert.ok(left.every(c => r3.includes(c)), "round 3 skipped a flag that hadn't had a turn");
  assert.ok(r3.every(c => !r2.includes(c)), "round 3 repeated a flag from round 2");
  assert.ok(r4.every(c => !r3.includes(c)), "round 4 repeated a flag from round 3");
});

test("extra practice: a round repeats the one just done only when there aren't enough other flags", () => {
  const t = setup({}, seeded(10)); learn(t, CODES.slice(0, 30));
  const [r1, r2] = playRun(t, 20, 2);
  const left = CODES.slice(0, 30).filter(c => !r1.includes(c));
  assert.equal(r2.length, 20);
  assert.ok(left.every(c => r2.includes(c)), "round 2 skipped a flag that hadn't had a turn");
});

test("extra practice: a round ended early only uses up the flags that were answered", () => {
  const t = setup({}, seeded(8)); learn(t, CODES.slice(0, 60));
  const r1 = t.core.buildQueue("extra", newRun(20)).map(it => it.c);
  const run = t.core.afterRound(newRun(20), new Set(r1.slice(0, 5)));
  assert.equal(run.skip.size, 5);
  const r2 = t.core.buildQueue("extra", run).map(it => it.c);
  assert.ok(r2.every(c => !run.skip.has(c)));
});

test("extra practice: flags missed today lead a new run, but Another rounds don't repeat them", () => {
  const t = setup({}, seeded(9)); learn(t, CODES.slice(0, 60));
  const missed = CODES.slice(0, 3);
  missed.forEach(c => t.core.grade(c, 1));
  const [r1, r2] = playRun(t, 20, 2);
  assert.ok(missed.every(c => r1.includes(c)));
  assert.ok(missed.every(c => !r2.includes(c)));
  assert.ok(missed.every(c => t.core.buildQueue("extra", { n: 20 }).some(it => it.c === c)), "a new run should bring them back");
});

/* ---------- Saved progress ---------- */
test("saved progress: anything unreadable becomes a fresh start", () => {
  for (const bad of [null, undefined, 5, "x", []]) assert.deepEqual(migrate(bad), blankState());
});

test("saved progress: version 1 saves are upgraded and gaps filled in", () => {
  const cards = { fr: { stage: "typed", S: 30 } };
  const s = migrate({ v: 1, cards, day: { n: 3, newDone: 2 }, settings: { perDay: 15, kosovo: true, dark: true }, confusions: { "td>ro": 2 } });
  assert.equal(s.v, VERSION);
  assert.deepEqual(s.settings, { perDay: 15, kosovo: true, theme: "dark" });
  assert.deepEqual(s.day, { n: 3, newDone: 2, bonus: 0 });
  assert.deepEqual(s.cards, cards);
  assert.deepEqual(s.confusions, { "td>ro": 2 });
  assert.equal(migrate({ v: 1, settings: { dark: false } }).settings.theme, "system");
});

test("saved progress: a save from a newer version is recognized", () => {
  assert.equal(isNewer({ v: VERSION + 1 }), true);
  assert.equal(isNewer({ v: VERSION }), false);
  assert.equal(isNewer({ v: 1 }), false);
  assert.equal(isNewer(null), false);
});

// What a save holds at each VERSION: the keys at the top level, in day and settings, and across all cards.
// A "?" marks a key only some saves have. Earlier versions stay on record, to check SAVES below.
const SAVED_SHAPE = {
  1: {
    top: ["cards", "confusions", "day", "settings", "v"],
    day: ["bonus", "n", "newDone"],
    settings: ["dark", "kosovo", "perDay"],
    cards: ["D", "S", "due", "lapses", "last", "reps", "stage", "streak"],
  },
  2: {
    top: ["cards", "confusions", "day", "settings", "v"],
    day: ["bonus", "n", "newDone"],
    settings: ["kosovo", "perDay", "theme"],
    // A card gets missedOn at its first miss.
    cards: ["D", "S", "due", "lapses", "last", "missedOn?", "reps", "stage", "streak"],
  },
};
// A full save from each version, as that version wrote it, with a card holding every key cards had then. Add one
// along with each SAVED_SHAPE and keep them all: the upgrade test below checks that UPGRADES carries each one over.
const SAVES = {
  1: {
    v: 1,
    cards: {
      td: { stage: "mc", streak: 1, reps: 3, lapses: 1, S: 1.2093, D: 7.3416, last: 20770, due: 20771 },
      fr: { stage: "typed", streak: 0, reps: 2, lapses: 0, S: 14.9694, D: 5.0867, last: 20769, due: 20772 },
    },
    day: { n: 20770, newDone: 10, bonus: 5 },
    settings: { perDay: 15, kosovo: true, dark: true },
    confusions: { "td>ro": 2 },
  },
  2: {
    v: 2,
    cards: {
      td: { stage: "mc", streak: 1, reps: 5, lapses: 2, S: 0.8571, D: 8.1022, last: 20776, due: 20777, missedOn: 20776 },
      fr: { stage: "typed", streak: 2, reps: 4, lapses: 0, S: 31.4462, D: 4.9718, last: 20775, due: 20806 },
    },
    day: { n: 20776, newDone: 8, bonus: 5 },
    settings: { perDay: 10, kosovo: false, theme: "dark" },
    confusions: { "td>ro": 3, "ro>td": 1 },
  },
};
// A state's keys, in the form of SAVED_SHAPE.
function shapeOf(S){
  const keys = o => Object.keys(o).sort();
  return { top: keys(S), day: keys(S.day), settings: keys(S.settings), cards: [...new Set(Object.values(S.cards).flatMap(keys))].sort() };
}
// A SAVED_SHAPE entry with every key, "?" or not: the shape of a save that has them all.
const everyKey = shape => shape && Object.fromEntries(Object.entries(shape).map(([part, keys]) => [part, keys.map(k => k.replace(/\?$/, ""))]));
// How a state differs from SAVED_SHAPE[v]: keys it has that the entry doesn't list (left over from an older
// version, say), and keys it lacks that aren't marked "?". Each card is compared on its own.
function shapeProblems(S, v){
  const want = SAVED_SHAPE[v];
  const { top, day, settings } = shapeOf(S);
  const parts = [["the top level", top, want.top], ["day", day, want.day], ["settings", settings, want.settings],
    ...Object.entries(S.cards).map(([c, card]) => [`card "${c}"`, Object.keys(card), want.cards])];
  const out = [];
  for (const [part, has, listed] of parts){
    const all = listed.map(k => k.replace(/\?$/, ""));
    for (const k of has) if (!all.includes(k)) out.push(`${part} has "${k}", which SAVED_SHAPE[${v}] doesn't list`);
    for (const k of listed) if (!k.endsWith("?") && !has.includes(k)) out.push(`${part} lacks "${k}"`);
  }
  return out;
}

// Plays through everything that writes saved progress, with Kosovo on: 20 days of sessions with right answers,
// hard ones and misses, a right pick after Show choices, "Learn 5 more", and extra practice. Returns the setup.
function playThrough(Core){
  const t = setup({ kosovo: true }, seeded(11), Core), answer = seeded(12);
  for (let d = 0; d < 20; d++){
    if (d === 5) t.core.touchDay().bonus += 5;
    for (const it of t.core.buildQueue("normal")){
      if (it.k === "ask"){ const r = answer(); t.core.grade(it.c, r < 0.15 ? 1 : r < 0.3 ? 2 : 3); }
    }
    const typed = Object.keys(t.S.cards).find(c => t.S.cards[c].stage === "typed");
    if (typed) t.core.grade(typed, 1, { keepStage: true });
    playRun(t, 20, 2);
    t.nextDay();
  }
  return t;
}

test("saved progress: what gets saved matches the snapshot for this VERSION", () => {
  const saved = JSON.parse(JSON.stringify(playThrough().S));
  // The page adds a key for each pair of flags mixed up, so only its type is checked.
  assert.ok(saved.confusions && typeof saved.confusions === "object" && !Array.isArray(saved.confusions), "confusions should be an object");
  const shape = shapeOf(saved);
  // The play-through reaches every key, so the ones marked "?" must be there too.
  assert.deepEqual(shape, everyKey(SAVED_SHAPE[VERSION]), `What gets saved doesn't match SAVED_SHAPE[${VERSION}] in test/core.test.js, `
    + "or there is none. When what gets saved changes, raise VERSION in src/core.js, add an UPGRADES step there that "
    + "turns saves from the old version into the new shape, and add a SAVED_SHAPE for the new VERSION here, with \"?\" "
    + `after any key only some saves have. What gets saved now:\n  ${JSON.stringify(shape)}`);
});

test("saved progress: a full save from every older version upgrades to this VERSION's shape", () => {
  const missing = [];
  for (let v = 1; v < VERSION; v++) if (!SAVES[v]) missing.push(v);
  assert.deepEqual(missing, [], `SAVES in test/core.test.js has no save from version ${missing.join(", ")}. When you raise `
    + "VERSION, add a full save from the old version there, as that version wrote it, with a card holding every card key. "
    + "This test upgrades it, to check that UPGRADES carries existing players' progress over.");
  assert.ok(SAVED_SHAPE[VERSION], `There's no SAVED_SHAPE[${VERSION}] in test/core.test.js: add it (see the snapshot test above).`);
  const problems = [];
  // From the newest down, so the first problem names the newest step.
  for (let v = VERSION; v >= 1; v--){
    if (!SAVES[v]) continue;
    assert.deepEqual(shapeOf(SAVES[v]), everyKey(SAVED_SHAPE[v]), `SAVES[${v}] in test/core.test.js should be a full `
      + `version ${v} save, with every key SAVED_SHAPE[${v}] lists (at least one card holding every card key) and no others.`);
    let s;
    try { s = migrate(structuredClone(SAVES[v])); }
    catch (e){ problems.push(`version ${v} save: upgrading it threw "${e.message}"`); continue; }
    const lost = Object.keys(SAVES[v].cards).filter(c => !s.cards[c]);
    if (lost.length) problems.push(`version ${v} save: upgrading it lost cards ${lost.join(", ")}`);
    for (const p of shapeProblems(s, VERSION)) problems.push(`version ${v} save: ${p}`);
  }
  assert.deepEqual(problems, [], `Upgrading older saves doesn't give the shape in SAVED_SHAPE[${VERSION}]. UPGRADES in `
    + `src/core.js needs a step for every version from 1 to ${VERSION - 1} (UPGRADES[v] turns a version v save into a `
    + "version v + 1 save), and each step must add, rename or remove every key that changed in that version. "
    + "Found:\n  " + problems.join("\n  "));
});

// Functions createCore returns that change saved progress.
const WRITERS = ["touchDay", "introduce", "grade"];
// Every other function createCore returns, each called with realistic arguments: `codes`, flags to ask about, and
// `run`, an extra practice run (see readArgs).
const READS = {
  dayNum: k => k.dayNum(), today: k => k.today(), active: k => k.active(), dueList: k => k.dueList(),
  practiced: k => k.practiced(), newAllowance: k => k.newAllowance(), planToday: k => k.planToday(), pickNew: k => k.pickNew(10),
  isActive: (k, { codes }) => codes.map(c => k.isActive(c)), card: (k, { codes }) => codes.map(c => k.card(c)),
  seen: (k, { codes }) => codes.map(c => k.seen(c)), mastered: (k, { codes }) => codes.map(c => k.mastered(c)),
  status: (k, { codes }) => codes.map(c => k.status(c)),
  lookalikes: (k, { codes }) => codes.map(c => k.lookalikes(c, 5)), distractors: (k, { codes }) => codes.map(c => k.distractors(c)),
  // The right name, a typo of it, a typo as close to another country, another country's name, and a blank.
  judge: k => [["Cote d'Ivoire", "ci"], ["Argentna", "ar"], ["Austrlia", "au"], ["Romania", "td"], ["", "fr"]].map(([s, c]) => k.judge(s, c)),
  buildQueue: (k, { run }) => [k.buildQueue("normal"), k.buildQueue("extra"), k.buildQueue("extra", run)],
  afterRound: (k, { codes, run }) => k.afterRound(run, new Set(codes)),
  shuffle: (k, { codes }) => k.shuffle(codes),
};
// Arguments for READS: the first three flags seen, one not seen yet (if any is left), Kosovo, and an extra practice
// run two rounds in, as afterRound leaves it.
function readArgs(t){
  const seenCodes = Object.keys(t.S.cards), unseen = CODES.find(c => !t.S.cards[c]);
  return {
    codes: [...seenCodes.slice(0, 3), ...(unseen ? [unseen] : []), "xk"],
    run: { n: 20, skip: new Set(seenCodes.slice(0, 40)), last: new Set(seenCodes.slice(20, 40)) },
  };
}

test("saved progress: read-only functions never change it, with day counters from an earlier day or from today", () => {
  const t = setup({ kosovo: true }, seeded(13)); practice(t, 8);
  // Today's misses don't touch the day counters, so those are still yesterday's.
  const [missed, hinted] = Object.keys(t.S.cards);
  t.core.grade(missed, 1); t.core.grade(hinted, 1, { keepStage: true });
  t.S.confusions = { [`${missed}>fr`]: 2 };
  const args = readArgs(t);

  const unsorted = Object.keys(t.core).filter(f => typeof t.core[f] === "function" && !(f in READS) && !WRITERS.includes(f));
  assert.deepEqual(unsorted, [], `createCore returns ${unsorted.join(", ")}, which this test doesn't know about. Add each one `
    + "to WRITERS if it can change saved progress, or to READS with a realistic call if it can't.");

  assert.notEqual(t.S.day.n, t.core.dayNum());
  for (const counters of ["left over from an earlier day", "from today"]){
    // The second time, today's counters, as after "Learn 5 more" five times: big enough that a read clamping them would show.
    if (counters === "from today") Object.assign(t.core.touchDay(), { newDone: 12, bonus: 25 });
    // Taken before any read is called, so a read that writes shows up below.
    const before = JSON.stringify(t.S);
    for (const [f, call] of Object.entries(READS)){
      call(t.core, args);
      assert.ok(JSON.stringify(t.S) === before, `${f} changed saved progress (with day counters ${counters}), but it's meant `
        + "to only read it: the page's next save would store the change. Make it leave the state alone, or if it's meant "
        + "to write, move it to WRITERS.");
    }
  }
});

/* ---------- No page code ---------- */
const CORE_PATH = path.join(__dirname, "..", "src", "core.js");
// Names the page or Node has. In the sandbox, reading one throws, even through typeof, so a check like
// `typeof document !== "undefined"` can't hide page code. Using any other name the sandbox lacks throws a ReferenceError.
const PAGE_AND_NODE = ["window", "self", "document", "location", "navigator", "localStorage", "sessionStorage", "indexedDB",
  "fetch", "requestAnimationFrame", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "crypto", "performance",
  "console", "process", "require", "global", "Buffer"];
// Loads src/core.js in a fresh context with nothing but the language itself, where reading the clock or randomness
// directly throws. Returns what core.js exports, through the module object it looks for.
function sandboxedCore(){
  const context = vm.createContext({ module: {} });
  const g = vm.runInContext("globalThis", context);
  const off = what => { throw Object.assign(new Error(`core.js used ${what}`), { used: what }); };
  for (const name of PAGE_AND_NODE) Object.defineProperty(g, name, { get: () => off(name) });
  g.Math.random = () => off("Math.random()");
  // new Date(ms) still works: dayNum() turns env.now() into a date.
  const RealDate = g.Date;
  function SandboxDate(...args){
    if (!new.target) off("Date()");
    if (!args.length) off("new Date() with no time");
    return Reflect.construct(RealDate, args, new.target);
  }
  Object.assign(SandboxDate, { prototype: RealDate.prototype, UTC: RealDate.UTC, parse: RealDate.parse, now: () => off("Date.now()") });
  g.Date = SandboxDate;
  vm.runInContext(fs.readFileSync(CORE_PATH, "utf8"), context, { filename: CORE_PATH });
  return context.module.exports;
}

test("core.js: no page code, and the clock and randomness come only through env", () => {
  // Runs everything the page does with core.js, in the sandbox. Code that never runs isn't checked this way, but
  // code that never runs can't misbehave either.
  try {
    const Core = sandboxedCore();
    const early = setup({ kosovo: true }, seeded(13), Core); practice(early, 3);
    const late = playThrough(Core);
    for (const t of [early, late]){
      const [a, b] = Object.keys(t.S.cards);
      t.S.confusions = { [`${a}>${b}`]: 2, [`${b}>fr`]: 1 };   // mix-ups, as the page records them
      for (const call of Object.values(READS)) call(t.core, readArgs(t));
    }
    for (const v in SAVES) Core.migrate(structuredClone(SAVES[v]));
    Core.migrate(null); Core.isNewer({ v: Core.VERSION + 1 });
  } catch (e){
    const used = e.used || (e.name === "ReferenceError" && (/^(\S+) is not defined/.exec(e.message) || [])[1]);
    if (!used) throw e;
    const line = (/src[\\/]core\.js:(\d+)/.exec(e.stack) || [])[1];
    assert.fail(`src/core.js${line ? ` line ${line}` : ""} uses ${used}. core.js must not use page or Node globals, and must `
      + "take the clock and randomness only through env (now, random) in createCore, so the page and the tests control them.");
  }
});

/* ---------- FSRS ---------- */
test("FSRS: first answers use the weights, and intervals target 90% recall", () => {
  assert.equal(fsrs(null, 3).S, W[2]);
  assert.equal(retr(0, 5), 1);
  assert.ok(Math.abs(ivlFor(10) - 10) < 1e-9);
  assert.ok(Math.abs(retr(ivlFor(10), 10) - 0.9) < 1e-9);
});
