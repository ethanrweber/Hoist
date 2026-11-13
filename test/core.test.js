// Tests for src/core.js. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { COUNTRIES, FAMILIES } = require("../src/countries.js");
const NEIGHBORS = require("../src/neighbors.json");
const { createCore, blankState, migrate, VERSION, fsrs, retr, ivlFor, W } = require("../src/core.js");

const DAY = 864e5;
// A core over fresh progress, with a clock the test moves forward and fixed randomness.
function setup(settings){
  const t = { S: blankState(), now: Date.UTC(2026, 0, 15, 12) };
  Object.assign(t.S.settings, settings);
  t.core = createCore({ countries: COUNTRIES, families: FAMILIES, neighbors: NEIGHBORS },
    { state: () => t.S, now: () => t.now, random: () => 0.5 });
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

test("answer checking: a typo as close to another country as to the right one is wrong", () => {
  const { judge } = setup().core;
  assert.deepEqual(judge("Nigeri", "ne"), { ok: false, guess: "ng" });
  assert.deepEqual(judge("Nigeri", "ng"), { ok: false, guess: "ne" });
  assert.deepEqual(judge("Austrlia", "at"), { ok: false, guess: "au" });
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

/* ---------- FSRS ---------- */
test("FSRS: first answers use the weights, and intervals target 90% recall", () => {
  assert.equal(fsrs(null, 3).S, W[2]);
  assert.equal(retr(0, 5), 1);
  assert.ok(Math.abs(ivlFor(10) - 10) < 1e-9);
  assert.ok(Math.abs(retr(ivlFor(10), 10) - 0.9) < 1e-9);
});
