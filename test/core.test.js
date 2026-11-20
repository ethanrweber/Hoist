// Tests for src/core.js. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { COUNTRIES, FAMILIES } = require("../src/countries.js");
const NEIGHBORS = require("../src/neighbors.json");
const { createCore, blankState, isNewer, migrate, VERSION, fsrs, retr, ivlFor, W } = require("../src/core.js");

const DAY = 864e5;
// A core over fresh progress, with a clock the test moves forward and fixed randomness (or `random`).
function setup(settings, random = () => 0.5){
  const t = { S: blankState(), now: Date.UTC(2026, 0, 15, 12) };
  Object.assign(t.S.settings, settings);
  t.core = createCore({ countries: COUNTRIES, families: FAMILIES, neighbors: NEIGHBORS },
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
function playRun(t, n, rounds){
  let skip = new Set(); const out = [];
  for (let i = 0; i < rounds; i++){
    const q = t.core.buildQueue("extra", { n, skip }).map(it => it.c);
    out.push(q); skip = t.core.nextSkip(skip, new Set(q));
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
  const all = t.core.buildQueue("extra", { n: 72 }).map(it => it.c);
  assert.deepEqual([...all].sort(), [...t.core.practiced()].sort());
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
  assert.ok(r4.every(c => !r3.includes(c)), "round 4 repeated a flag from round 3");
});

test("extra practice: a round ended early only uses up the flags that were answered", () => {
  const t = setup({}, seeded(8)); learn(t, CODES.slice(0, 60));
  const r1 = t.core.buildQueue("extra", { n: 20 }).map(it => it.c);
  const skip = t.core.nextSkip(new Set(), new Set(r1.slice(0, 5)));
  assert.equal(skip.size, 5);
  const r2 = t.core.buildQueue("extra", { n: 20, skip }).map(it => it.c);
  assert.ok(r2.every(c => !skip.has(c)));
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

/* ---------- FSRS ---------- */
test("FSRS: first answers use the weights, and intervals target 90% recall", () => {
  assert.equal(fsrs(null, 3).S, W[2]);
  assert.equal(retr(0, 5), 1);
  assert.ok(Math.abs(ivlFor(10) - 10) < 1e-9);
  assert.ok(Math.abs(retr(ivlFor(10), 10) - 0.9) < 1e-9);
});
