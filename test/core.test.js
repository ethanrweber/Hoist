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
// t.changed counts the core's calls to env.changed(), which tell the page to save.
// `Core` is what src/core.js exports: the one Node loaded, unless a test loads its own (see sandboxedCore).
function setup(settings, random = () => 0.5, Core = HoistCore) {
  const t = { S: Core.blankState(), now: Date.UTC(2026, 0, 15, 12), changed: 0 };
  Object.assign(t.S.settings, settings);
  t.core = Core.createCore(
    { countries: COUNTRIES, families: FAMILIES, neighbors: NEIGHBORS },
    { state: () => t.S, now: () => t.now, random, changed: () => t.changed++ },
  );
  t.nextDay = () => {
    t.now += DAY;
  };
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
  for (const c of COUNTRIES) {
    if (c.optional) continue;
    const n = c.n.toLowerCase(),
      slips = new Set();
    for (let i = 0; i < n.length; i++) slips.add(n.slice(0, i) + n.slice(i + 1)); // dropped letter
    for (let i = 0; i < n.length - 1; i++)
      slips.add(n.slice(0, i) + n[i + 1] + n[i] + n.slice(i + 2)); // swapped letters
    for (const s of slips)
      if (s !== n && judge(s, c.c).guess) blamed.push(`${s} (${c.c} -> ${judge(s, c.c).guess})`);
  }
  assert.deepEqual(blamed, []);
});

test("answer checking: Kosovo only counts as an answer when it's switched on", () => {
  assert.deepEqual(setup().core.judge("Kosovo", "cy"), { ok: false });
  assert.deepEqual(setup({ kosovo: true }).core.judge("Kosovo", "cy"), { ok: false, guess: "xk" });
});

/* ---------- Stages and grading ---------- */
test("stages: two right multiple-choice answers move a flag to typing; a typing miss sends it back", () => {
  const t = setup(),
    { grade, card } = t.core;
  grade("fr", 3);
  assert.equal(card("fr").stage, "mc");
  t.nextDay();
  grade("fr", 3);
  assert.equal(card("fr").stage, "typed");
  t.nextDay();
  grade("fr", 1);
  assert.equal(card("fr").stage, "mc");
});

test("stages: a right pick after Show choices is a miss that keeps the flag at typing", () => {
  const t = setup(),
    { grade, card, dayNum } = t.core;
  grade("fr", 3);
  t.nextDay();
  grade("fr", 3);
  for (let i = 0; i < 4; i++) {
    t.nextDay();
    grade("fr", 3);
  }
  const before = card("fr").S;
  t.nextDay();
  grade("fr", 1, { keepStage: true });
  const k = card("fr");
  assert.equal(k.stage, "typed");
  assert.equal(k.streak, 0);
  assert.ok(k.S < before, "stability should drop like any miss");
  assert.equal(k.due, dayNum() + 1);
});

test("stages: answering only through Show choices never reaches Mastered", () => {
  const t = setup(),
    { grade, mastered } = t.core;
  grade("fr", 3);
  t.nextDay();
  grade("fr", 3);
  for (let i = 0; i < 60; i++) {
    t.nextDay();
    grade("fr", 1, { keepStage: true });
  }
  assert.equal(mastered("fr"), false);
});

/* ---------- Today's plan ---------- */
test("today's plan: the home screen's new-flag count matches what the session introduces", () => {
  const t = setup({ perDay: 5 }),
    { planToday, buildQueue, introduce } = t.core;
  let overLimit = 0;
  for (let day = 0; day < 40; day++) {
    const plan = planToday();
    const intros = buildQueue("normal")
      .filter((it) => it.k === "intro")
      .map((it) => it.c);
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
  t.S.day = { n: 1, newDone: 7, bonus: 5 }; // left over from an earlier day
  const before = JSON.stringify(t.S);
  t.core.planToday();
  t.core.newAllowance();
  t.core.today();
  assert.equal(JSON.stringify(t.S), before);
  assert.equal(t.core.newAllowance(), 10);
  // With today's counters too, today() hands out a copy: only touchDay() gives the stored ones.
  Object.assign(t.core.touchDay(), { newDone: 3, bonus: 5 });
  const d = t.core.today();
  d.newDone = 0;
  d.bonus = 0;
  assert.deepEqual(
    t.S.day,
    { n: t.core.dayNum(), newDone: 3, bonus: 5 },
    "Changing what today() returns changed saved progress. today() must return a copy: use touchDay() to change the counters.",
  );
  assert.equal(t.core.newAllowance(), 12);
});

/* ---------- Extra practice ---------- */
// Repeatable randomness, for tests where the picks need to vary.
function seeded(s) {
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
// Plays `days` of normal sessions, answering everything right.
function practice(t, days) {
  for (let d = 0; d < days; d++) {
    for (const it of t.core.buildQueue("normal")) if (it.k === "ask") t.core.grade(it.c, 3);
    t.nextDay();
  }
}

test("extra practice: rounds on the same day draw different flags, without changing progress", () => {
  const t = setup({}, seeded(1));
  practice(t, 6);
  const before = JSON.stringify(t.S);
  const rounds = Array.from({ length: 10 }, () => t.core.buildQueue("extra").map((it) => it.c));
  assert.equal(JSON.stringify(t.S), before);
  for (const r of rounds) assert.equal(new Set(r).size, 20);
  assert.ok(
    new Set(rounds.map((r) => [...r].sort().join())).size > 1,
    "every round drew the same flags",
  );
  assert.ok(new Set(rounds.flat()).size > 30, "rounds should reach beyond one fixed set of 20");
});

test("extra practice: flags missed today come back in every new run, including Show choices picks", () => {
  const t = setup({}, seeded(2));
  practice(t, 6);
  const [hinted, ...missed] = Object.keys(t.S.cards).slice(0, 5);
  missed.forEach((c) => t.core.grade(c, 1));
  t.core.grade(hinted, 1, { keepStage: true });
  for (let i = 0; i < 30; i++) {
    const r = t.core.buildQueue("extra").map((it) => it.c);
    for (const c of [hinted, ...missed]) assert.ok(r.includes(c), `round ${i} is missing ${c}`);
  }
});

test("extra practice: with more than 20 flags missed today, rounds take turns among them", () => {
  const t = setup({}, seeded(3));
  practice(t, 6);
  const missed = Object.keys(t.S.cards).slice(0, 25);
  missed.forEach((c) => t.core.grade(c, 1));
  const shown = new Set();
  for (let i = 0; i < 10; i++) {
    const r = t.core.buildQueue("extra").map((it) => it.c);
    assert.equal(r.length, 20);
    assert.ok(
      r.every((c) => missed.includes(c)),
      "a flag answered right took a missed flag's place",
    );
    r.forEach((c) => shown.add(c));
  }
  assert.equal(shown.size, 25);
});

const CODES = COUNTRIES.filter((c) => !c.optional).map((c) => c.c);
// Marks `codes` as practiced, all last answered two days ago with stability S.
function learn(t, codes, S = 5) {
  const d = t.core.dayNum();
  codes.forEach(
    (c) =>
      (t.S.cards[c] = {
        stage: "typed",
        streak: 1,
        reps: 3,
        lapses: 0,
        S,
        D: 5,
        last: d - 2,
        due: d + 2,
      }),
  );
}
// Plays `rounds` rounds of one extra practice run, answering every flag. Returns each round's flags.
const newRun = (n) => ({ n, skip: new Set(), last: new Set() });
function playRun(t, n, rounds) {
  let run = newRun(n);
  const out = [];
  for (let i = 0; i < rounds; i++) {
    const q = t.core.buildQueue("extra", run).map((it) => it.c);
    out.push(q);
    run = t.core.afterRound(run, new Set(q));
  }
  return out;
}

test("extra practice: weak flags come up more often, but strong ones still get a turn", () => {
  const t = setup({}, seeded(4));
  const weak = CODES.slice(0, 30),
    strong = CODES.slice(30, 60);
  learn(t, weak, 2);
  learn(t, strong, 60);
  const n = {};
  for (let i = 0; i < 300; i++)
    t.core.buildQueue("extra").forEach((it) => (n[it.c] = (n[it.c] || 0) + 1));
  const avg = (list) => list.reduce((s, c) => s + (n[c] || 0), 0) / list.length;
  assert.ok(avg(weak) > 3 * avg(strong), `weak ${avg(weak)} vs strong ${avg(strong)} times each`);
  assert.ok(
    strong.some((c) => n[c]),
    "strong flags should still come up sometimes",
  );
});

test("extra practice: a round has the size asked for, and All takes every practiced flag", () => {
  const t = setup({}, seeded(5));
  learn(t, CODES.slice(0, 72));
  for (const n of [20, 50])
    assert.equal(new Set(t.core.buildQueue("extra", { n }).map((it) => it.c)).size, n);
  const all = t.core.buildQueue("extra", newRun(Infinity)).map((it) => it.c);
  assert.deepEqual([...all].sort(), [...t.core.practiced()].sort());
  // All stays all when more flags get practiced during the run (in another tab, say).
  const run = t.core.afterRound(newRun(Infinity), new Set(all));
  learn(t, CODES.slice(72, 77));
  assert.equal(t.core.buildQueue("extra", run).length, 77);
});

test("extra practice: Another rounds repeat nothing until every flag has had a turn", () => {
  const t = setup({}, seeded(6));
  learn(t, CODES.slice(0, 60));
  const [r1, r2, r3, r4] = playRun(t, 20, 4);
  assert.equal(new Set([...r1, ...r2, ...r3]).size, 60);
  // Then the run starts over, but not with the flags just practiced.
  assert.equal(r4.length, 20);
  assert.ok(
    r4.every((c) => !r3.includes(c)),
    "round 4 repeated a flag from round 3",
  );
});

test("extra practice: the round that finishes a pass fills its other places from earlier rounds", () => {
  const t = setup({}, seeded(7));
  learn(t, CODES.slice(0, 50));
  const [r1, r2, r3, r4] = playRun(t, 20, 4);
  assert.equal(new Set([...r1, ...r2]).size, 40);
  const left = CODES.slice(0, 50).filter((c) => !r1.includes(c) && !r2.includes(c));
  assert.equal(r3.length, 20);
  assert.ok(
    left.every((c) => r3.includes(c)),
    "round 3 skipped a flag that hadn't had a turn",
  );
  assert.ok(
    r3.every((c) => !r2.includes(c)),
    "round 3 repeated a flag from round 2",
  );
  assert.ok(
    r4.every((c) => !r3.includes(c)),
    "round 4 repeated a flag from round 3",
  );
});

test("extra practice: a round repeats the one just done only when there aren't enough other flags", () => {
  const t = setup({}, seeded(10));
  learn(t, CODES.slice(0, 30));
  const [r1, r2] = playRun(t, 20, 2);
  const left = CODES.slice(0, 30).filter((c) => !r1.includes(c));
  assert.equal(r2.length, 20);
  assert.ok(
    left.every((c) => r2.includes(c)),
    "round 2 skipped a flag that hadn't had a turn",
  );
});

test("extra practice: a round ended early only uses up the flags that were answered", () => {
  const t = setup({}, seeded(8));
  learn(t, CODES.slice(0, 60));
  const r1 = t.core.buildQueue("extra", newRun(20)).map((it) => it.c);
  const run = t.core.afterRound(newRun(20), new Set(r1.slice(0, 5)));
  assert.equal(run.skip.size, 5);
  const r2 = t.core.buildQueue("extra", run).map((it) => it.c);
  assert.ok(r2.every((c) => !run.skip.has(c)));
});

test("extra practice: flags missed today lead a new run, but Another rounds don't repeat them", () => {
  const t = setup({}, seeded(9));
  learn(t, CODES.slice(0, 60));
  const missed = CODES.slice(0, 3);
  missed.forEach((c) => t.core.grade(c, 1));
  const [r1, r2] = playRun(t, 20, 2);
  assert.ok(missed.every((c) => r1.includes(c)));
  assert.ok(missed.every((c) => !r2.includes(c)));
  assert.ok(
    missed.every((c) => t.core.buildQueue("extra", { n: 20 }).some((it) => it.c === c)),
    "a new run should bring them back",
  );
});

/* ---------- Sessions ---------- */
// Each country's name, for typed answers.
const NAME = Object.fromEntries(COUNTRIES.map((c) => [c.c, c.n]));
const oneOf = (rand, list) => list[Math.floor(rand() * list.length)];
// Makes `codes` due today at `stage`. With perDay 0 there's nothing new, so a session asks just these.
function dueToday(t, codes, stage = "mc") {
  const d = t.core.dayNum();
  codes.forEach(
    (c) =>
      (t.S.cards[c] = { stage, streak: 0, reps: 3, lapses: 0, S: 5, D: 5, last: d - 2, due: d }),
  );
}
// A wrong choice among the options.
const wrongPick = (q, c) => q.options.find((o) => o !== c);
// Plays session `s` to its end, answering each question with `answer(it, question)`. Returns the items shown.
function playAll(s, answer) {
  const shown = [];
  for (s.next(); s.current(); s.next()) {
    const it = s.current();
    shown.push(it);
    if (it.k === "ask") answer(it, s.question());
  }
  return shown;
}
// Typed answers a player might give for flag c: right, a letter dropped, another country, no country, blank,
// and one as close to two countries (ambiguous for the flags listed, a wrong guess for the rest).
const AMBIGUOUS = {
  au: "Austrlia",
  at: "Austrlia",
  ne: "Nigeri",
  ng: "Nigeri",
  gm: "ambia",
  zm: "ambia",
  is: "Ieland",
  ie: "Ieland",
  bi: "Brundi",
  gy: "Gyana",
  na: "Nambia",
  rs: "Seria",
};
function typedAnswer(c, rand) {
  const n = NAME[c],
    i = Math.floor(rand() * n.length);
  return oneOf(rand, [
    n,
    n.slice(0, i) + n.slice(i + 1),
    NAME[oneOf(rand, CODES)],
    "zzzz",
    "",
    AMBIGUOUS[c] || "Nigeri",
  ]);
}
// Answers the question on screen the way a player might, at random: right and wrong picks, any typedAnswer,
// "Show choices" and "I don't know". Like the page, it shows choices after a blank and asks again after an
// ambiguous answer. Returns each result, the answer last.
function answerRandomly(s, it, q, rand) {
  const out = [];
  if (q.view === "typed" && rand() < 0.15) q = s.question({ hint: true });
  for (;;) {
    let r;
    if (q.view === "mc")
      r = s.answer({ pick: rand() < 0.7 ? it.c : oneOf(rand, q.options) }, { ms: rand() * 9000 });
    else if (rand() < 0.1) r = s.answer({ dunno: true });
    else
      r = s.answer(
        { typed: typedAnswer(it.c, rand) },
        { ms: rand() * 15000, firstKeyMs: rand() < 0.2 ? null : rand() * 4000 },
      );
    out.push(r);
    if (r.verdict === "empty") q = s.question({ hint: true });
    else if (r.verdict !== "ambiguous") return out;
  }
}

// Answers the one question of a session about Argentina, due today at `stage`, with `act(s, question)`.
function answerOne(stage, act) {
  const t = setup({ perDay: 0 });
  dueToday(t, ["ar"], stage);
  const s = t.core.session("normal");
  s.next();
  const r = act(s, s.question());
  return { r, card: t.S.cards.ar };
}
// The card Argentina would have after grading it g directly.
function gradedAs(stage, g, opts) {
  const t = setup({ perDay: 0 });
  dueToday(t, ["ar"], stage);
  t.core.grade("ar", g, opts);
  return t.S.cards.ar;
}

test("sessions: picks and typed answers are graded by time, typos and Show choices, on each side of every cutoff", () => {
  const pick = (o, ms) => (s, q) =>
    s.answer({ pick: o === "wrong" ? wrongPick(q, "ar") : o }, { ms });
  const hintedPick = (o, ms) => (s) => pick(o, ms)(s, s.question({ hint: true }));
  // Show choices, then the question asked again without it: the choices stay until the next card.
  const askedAgain = (o, ms) => (s) => {
    s.question({ hint: true });
    return pick(o, ms)(s, s.question());
  };
  const typed =
    (text, ms, firstKeyMs = 500) =>
    (s) =>
      s.answer({ typed: text }, { ms, firstKeyMs });
  // [stage, answer, verdict, quick, grade, keepStage]. A wrong pick's guess is the choice picked.
  const cases = [
    ["mc", pick("ar", 6000), "right", false, 3],
    ["mc", pick("ar", 6001), "right", false, 2],
    ["mc", pick("wrong", 2199), "miss", true, 1],
    ["mc", pick("wrong", 2200), "miss", false, 1],
    // Show choices is only for typing: on a multiple-choice flag, asking for it changes nothing.
    ["mc", hintedPick("ar", 1000), "right", false, 3],
    ["typed", hintedPick("ar", 1000), "hinted", false, 1, true],
    ["typed", hintedPick("wrong", 1000), "miss", false, 1],
    ["typed", askedAgain("ar", 1000), "hinted", false, 1, true],
    ["typed", typed("Argentina", 12000), "right", false, 3],
    ["typed", typed("Argentina", 12001), "right", false, 2],
    ["typed", typed("Argentna", 1000), "typo", false, 2],
    ["typed", typed("Brazil", 3000, 2499), "miss", true, 1],
    ["typed", typed("Brazil", 3000, 2500), "miss", false, 1],
    ["typed", typed("Brazil", 3000, null), "miss", false, 1],
    ["typed", typed("zzzz", 3000, 100), "miss", false, 1],
    ["typed", (s) => s.answer({ dunno: true }), "miss", false, 1],
  ];
  for (const [i, [stage, act, verdict, quick, g, keepStage]] of cases.entries()) {
    const { r, card } = answerOne(stage, act),
      name = `case ${i} (${verdict})`;
    assert.equal(r && r.verdict, verdict, name);
    assert.equal(r.quick, quick, name);
    assert.deepEqual(card, gradedAs(stage, g, { keepStage }), `${name} should grade ${g}`);
  }
  assert.equal(answerOne("typed", typed("Brazil", 3000)).r.guess, "br");
  assert.equal(answerOne("typed", typed("zzzz", 3000)).r.guess, null);
  // After Show choices, the question is multiple choice until the next card, so a typed answer isn't one.
  answerOne("typed", (s) => {
    s.question({ hint: true });
    s.question();
    assert.equal(
      s.answer({ typed: "Argentina" }, { ms: 1000, firstKeyMs: 100 }),
      null,
      "A typed answer after Show choices was taken. Show choices must hold until next(), even if question() is called again.",
    );
  });
  // A blank or ambiguous answer isn't one: nothing changes, and the question can still be answered.
  for (const [code, text, verdict] of [
    ["ar", " ", "empty"],
    ["au", "Austrlia", "ambiguous"],
  ]) {
    const t = setup({ perDay: 0 });
    dueToday(t, [code], "typed");
    const s = t.core.session("normal");
    s.next();
    s.question();
    const before = JSON.stringify(t.S);
    assert.deepEqual(s.answer({ typed: text }, { ms: 1000, firstKeyMs: 100 }), {
      verdict,
      guess: null,
      quick: false,
    });
    assert.equal(JSON.stringify(t.S), before);
    assert.equal(s.answer({ typed: NAME[code] }, { ms: 1000 }).verdict, "right");
  }
});

test("sessions: a missed flag comes back 3 cards later after a quick miss, 5 otherwise, and is asked at most 3 times", () => {
  const t = setup({ perDay: 0 });
  dueToday(t, CODES.slice(0, 12));
  const s = t.core.session("normal"),
    asked = [];
  let target = null;
  // Misses one flag every time it's asked: quickly, then slowly, then quickly again. Answers the rest right.
  playAll(s, (it, q) => {
    target = target || it.c;
    if (it.c !== target) return s.answer({ pick: it.c }, { ms: 1000 });
    asked.push([s.progress().done, it.n]);
    s.answer({ pick: wrongPick(q, it.c) }, { ms: it.n === 2 ? 3000 : 1000 });
  });
  assert.deepEqual(asked, [
    [0, 1],
    [4, 2],
    [10, 3],
  ]);
  // Near the end of the queue, it comes back as the next card.
  const t2 = setup({ perDay: 0 });
  dueToday(t2, ["ar"]);
  const s2 = t2.core.session("normal");
  assert.deepEqual(
    playAll(s2, (it, q) => s2.answer({ pick: wrongPick(q, it.c) }, { ms: 3000 })),
    [1, 2, 3].map((n) => ({ k: "ask", c: "ar", n })),
  );
});

test("sessions: a normal session grades each flag once, even when it's asked again", () => {
  const codes = CODES.slice(0, 6);
  const t = setup({ perDay: 0 });
  dueToday(t, codes);
  // Misses each flag at first, then gets it right.
  const s = t.core.session("normal");
  const shown = playAll(s, (it, q) =>
    s.answer({ pick: it.n === 1 ? wrongPick(q, it.c) : it.c }, { ms: 3000 }),
  );
  assert.equal(shown.length, 12);
  for (const c of codes) assert.deepEqual(t.S.cards[c], gradedAs("mc", 1), c); // as one miss, and nothing else
});

test("sessions: extra practice never changes cards, but records mix-ups", () => {
  const t = setup({}, seeded(14));
  learn(t, CODES.slice(0, 40));
  const cards = JSON.stringify(t.S.cards),
    s = t.core.session("extra", newRun(20)),
    wrong = [];
  playAll(s, (it, q) => {
    const r = s.answer(
      { typed: it.n > 1 ? NAME[it.c] : it.c === "fr" ? NAME.de : NAME.fr },
      { ms: 3000 },
    );
    if (r.guess) wrong.push(`${it.c}>${r.guess}`);
  });
  assert.equal(wrong.length, 20);
  assert.equal(JSON.stringify(t.S.cards), cards);
  assert.deepEqual(Object.keys(t.S.confusions).sort(), wrong.sort());
});

test("sessions: a right pick after Show choices counts as a miss, comes back, and the flag stays at typing", () => {
  const t = setup({ perDay: 0 });
  dueToday(t, ["ar"], "typed");
  const s = t.core.session("normal");
  s.next();
  assert.deepEqual(s.question(), { view: "typed" });
  const q = s.question({ hint: true });
  assert.equal(q.view, "mc");
  assert.ok(q.options.includes("ar"));
  assert.deepEqual(s.answer({ pick: "ar" }, { ms: 1000 }), {
    verdict: "hinted",
    guess: null,
    quick: false,
  });
  assert.equal(t.S.cards.ar.stage, "typed");
  s.next();
  assert.deepEqual(s.current(), { k: "ask", c: "ar", n: 2 });
  assert.deepEqual(s.question(), { view: "typed" }, "Show choices lasts until the next card");
  s.answer({ typed: "Argentina" }, { ms: 1000 });
  assert.deepEqual(s.end().summary, { mode: "normal", right: 0, total: 1, mixups: [] });
});

test("sessions: reaching a new flag introduces it, and its intro is skipped if another tab introduced it first", () => {
  const t = setup(),
    s = t.core.session("normal");
  const [a, b, ...rest] = t.core.planToday().groups.flat();
  assert.equal(s.next(), true);
  assert.deepEqual(s.current(), { k: "intro", c: a });
  assert.ok(t.core.seen(a));
  // Another tab introduces b, the next new flag, and this page loads what it saved.
  t.S = structuredClone(t.S);
  t.core.introduce(b);
  const shown = [s.current()].concat(playAll(s, (it) => s.answer({ dunno: true })));
  const intros = shown.filter((it) => it.k === "intro").map((it) => it.c);
  assert.deepEqual(intros, [a, ...rest]);
  assert.ok(
    shown.some((it) => it.k === "ask" && it.c === b),
    "the flag is still asked",
  );
});

test("sessions: once a question has its answer, more answers, Show choices and I don't know are ignored", () => {
  const t = setup({ perDay: 0 });
  dueToday(t, ["ar"], "typed");
  const s = t.core.session("normal");
  s.next();
  assert.equal(
    s.answer({ typed: "Argentina" }, { ms: 1000 }),
    null,
    "an answer before the question is shown",
  );
  s.question();
  assert.equal(s.answer({ pick: "ar" }, { ms: 1000 }), null, "a pick on a typing question");
  assert.equal(s.answer({ typed: "Brazil" }, { ms: 3000, firstKeyMs: 1000 }).verdict, "miss");
  const after = JSON.stringify(t.S);
  assert.equal(s.answer({ typed: "Argentina" }, { ms: 1000 }), null);
  assert.equal(s.answer({ dunno: true }), null);
  assert.equal(s.question({ hint: true }), null);
  assert.equal(JSON.stringify(t.S), after);
  assert.equal(s.progress().total, 2, "asked again once");
  assert.deepEqual(s.end().summary, { mode: "normal", right: 0, total: 1, mixups: [["ar", "br"]] });
});

test("sessions: Learn 5 more adds 5 new flags to today, and the session brings them in", () => {
  const t = setup({ perDay: 5 }),
    first = t.core.session("normal");
  playAll(first, (it) => first.answer({ pick: it.c }, { ms: 1000 }));
  assert.equal(t.core.newAllowance(), 0);
  const s = t.core.session("more");
  assert.equal(s.mode, "normal");
  assert.equal(t.core.today().bonus, 5);
  assert.equal(t.core.newAllowance(), 5);
  const plan = t.core.planToday();
  const intros = playAll(s, (it) => s.answer({ pick: it.c }, { ms: 1000 }))
    .filter((it) => it.k === "intro")
    .map((it) => it.c);
  assert.deepEqual(intros, plan.groups.flat());
  assert.equal(intros.length, 5);
});

test("sessions: the summary counts first answers, and lists each mix-up once, in order", () => {
  // In extra practice, so a miss leaves the flag at typing.
  const t = setup();
  learn(t, CODES.slice(0, 5));
  const s = t.core.session("extra", newRun(20)),
    [x, y] = CODES.slice(10, 12),
    order = [];
  // The first flag asked is taken for x at its first two asks, the second for y at its first. All else is right.
  playAll(s, (it) => {
    if (!order.includes(it.c)) order.push(it.c);
    const wrong = it.c === order[0] && it.n < 3 ? x : it.c === order[1] && it.n === 1 ? y : null;
    s.answer({ typed: NAME[wrong || it.c] }, { ms: 3000 });
  });
  const [a, b] = order;
  assert.deepEqual(s.end().summary, {
    mode: "extra",
    right: 3,
    total: 5,
    mixups: [
      [a, x],
      [b, y],
    ],
  });
  assert.deepEqual(t.S.confusions, { [`${a}>${x}`]: 2, [`${b}>${y}`]: 1 });
});

// Only session("more"), next() when it introduces a flag, and real answers write.
test("sessions: starting a normal or extra session, and every session read, leave saved progress alone", () => {
  const t = setup({}, seeded(15));
  practice(t, 3);
  const same = (what, f) => {
    const before = JSON.stringify(t.S),
      calls = t.changed,
      out = f();
    assert.equal(JSON.stringify(t.S), before, `${what} changed saved progress`);
    assert.equal(t.changed, calls, `${what} called env.changed() without changing saved progress`);
    return out;
  };
  same('session("extra")', () => t.core.session("extra", newRun(20)));
  const s = same('session("normal")', () => t.core.session("normal")),
    rand = seeded(16);
  for (;;) {
    const before = JSON.stringify(t.S),
      isNew = s.next();
    if (!isNew)
      assert.equal(
        JSON.stringify(t.S),
        before,
        "next() changed saved progress, but returned false",
      );
    const it = same("current()", () => s.current());
    if (!it) break;
    assert.equal(isNew, it.k === "intro");
    same("progress()", () => s.progress());
    if (it.k === "ask")
      answerRandomly(
        s,
        it,
        same("question()", () => s.question()),
        rand,
      );
  }
  same("end()", () => s.end());
});

// The current behavior, kept as it is: unlike a miss in a normal session (see "flags missed today come back in
// every new run" above), a miss in extra practice isn't remembered for the next run.
test("sessions: a miss in extra practice doesn't set missedOn, so it doesn't lead the next run", () => {
  const t = setup({}, seeded(17));
  learn(t, CODES.slice(0, 60));
  const s = t.core.session("extra", newRun(20));
  s.next();
  s.question();
  const c = s.current().c;
  s.answer({ dunno: true });
  assert.equal(t.S.cards[c].missedOn, undefined);
  const inRuns = Array.from({ length: 10 }, () =>
    t.core.buildQueue("extra", newRun(20)).some((it) => it.c === c),
  );
  assert.ok(inRuns.includes(false), "it was in every new run");
});

// Many sessions of random events: answers of every kind, answering twice, ending early, another tab introducing a
// flag, and the day rolling over. Every session call that changes saved progress must call env.changed().
test("sessions: random play keeps every rule", () => {
  const rand = seeded(18),
    t = setup({}, seeded(19)),
    verdicts = new Set();
  // Calls f, and fails if it changed saved progress without calling env.changed(). The state as JSON is kept from
  // the last call that didn't call changed(), and reused while the state and the count of changed() calls stay the same.
  let last = {};
  const told =
    (what, f) =>
    (...args) => {
      const calls = t.changed,
        before = last.S === t.S && last.calls === calls ? last.json : JSON.stringify(t.S),
        out = f(...args);
      if (t.changed > calls) {
        last = {};
        return out;
      }
      const json = JSON.stringify(t.S);
      assert.ok(
        json === before,
        `${what} changed saved progress without calling env.changed(), so the page won't save the ` +
          "change and it's lost on reload. In src/core.js, call changed() wherever saved progress is written.",
      );
      last = { S: t.S, calls, json };
      return out;
    };
  // The session with each method checked by told().
  const watched = (s) =>
    s &&
    Object.fromEntries(
      Object.entries(s).map(([k, f]) => [k, typeof f === "function" ? told(k + "()", f) : f]),
    );
  let run = null,
    sessions = 0;
  for (let n = 0; n < 30; n++) {
    if (rand() < 0.5) t.nextDay();
    const mode = oneOf(rand, ["normal", "normal", "more", "extra"]);
    if (mode === "extra" && (!run || rand() < 0.5)) run = newRun(oneOf(rand, [20, 50, Infinity]));
    const s = watched(told(`session("${mode}")`, t.core.session)(mode, run));
    if (!s) continue;
    sessions++;
    const upcoming = t.core.planToday().groups.flat(),
      cards = mode === "extra" && JSON.stringify(t.S.cards);
    const elsewhere = new Set(),
      asks = {},
      grades = {};
    for (let steps = 0; ; steps++) {
      assert.ok(steps < 2000, "the session never ended");
      if (rand() < 0.02) break; // ended early
      if (mode !== "extra" && rand() < 0.04) {
        // Another tab introduces a flag this session hasn't reached, and this page loads what it saved.
        const c = upcoming.find((x) => !t.core.seen(x));
        if (c) {
          t.S = structuredClone(t.S);
          t.core.introduce(c);
          elsewhere.add(c);
        }
      }
      if (rand() < 0.02) t.now += DAY; // the day rolls over
      s.next();
      const it = s.current();
      if (!it) break;
      if (it.k === "intro") {
        assert.ok(!elsewhere.has(it.c), `${it.c} was introduced twice`);
        continue;
      }
      asks[it.c] = (asks[it.c] || 0) + 1;
      assert.ok(
        asks[it.c] <= 3 && it.n === asks[it.c],
        `${it.c} asked ${asks[it.c]} times, as attempt ${it.n}`,
      );
      const reps = t.core.card(it.c).reps;
      answerRandomly(s, it, s.question(), rand).forEach((r) => verdicts.add(r.verdict));
      grades[it.c] = (grades[it.c] || 0) + t.core.card(it.c).reps - reps;
      if (rand() < 0.2) {
        assert.equal(s.answer({ pick: it.c }, { ms: 1000 }), null);
        assert.equal(s.answer({ typed: NAME[it.c] }, { ms: 1000 }), null);
        assert.equal(s.answer({ dunno: true }), null);
        assert.equal(s.question({ hint: true }), null);
      }
    }
    const end = s.end();
    if (mode === "extra") {
      assert.equal(JSON.stringify(t.S.cards), cards, "extra practice changed a card");
      assert.deepEqual(
        [...end.run.last].sort(),
        Object.keys(asks).sort(),
        "the run should use up the flags answered, and only those",
      );
      run = end.run;
    } else
      for (const c in asks)
        assert.equal(grades[c], 1, `${c} was graded ${grades[c]} times in one session`);
    assert.equal(end.summary.total, Object.keys(asks).length);
  }
  assert.ok(sessions >= 25, `only ${sessions} sessions had anything to do`);
  assert.deepEqual([...verdicts].sort(), ["ambiguous", "empty", "hinted", "miss", "right", "typo"]);
});

/* ---------- Saved progress ---------- */
test("saved progress: anything unreadable becomes a fresh start", () => {
  for (const bad of [null, undefined, 5, "x", []]) assert.deepEqual(migrate(bad), blankState());
});

test("saved progress: version 1 saves are upgraded and gaps filled in", () => {
  const cards = { fr: { stage: "typed", S: 30 } };
  const s = migrate({
    v: 1,
    cards,
    day: { n: 3, newDone: 2 },
    settings: { perDay: 15, kosovo: true, dark: true },
    confusions: { "td>ro": 2 },
  });
  assert.equal(s.v, VERSION);
  assert.deepEqual(s.settings, { perDay: 15, kosovo: true, theme: "dark" });
  assert.deepEqual(s.day, { n: 3, newDone: 2, bonus: 0 });
  assert.deepEqual(s.cards, cards);
  assert.deepEqual(s.confusions, { "td>ro": 2 });
  assert.equal(migrate({ v: 1, settings: { dark: false } }).settings.theme, "system");
});

test("saved progress: setSetting changes only settings a fresh save has", () => {
  const t = setup();
  t.core.setSetting("perDay", 20);
  t.core.setSetting("theme", "light");
  t.core.setSetting("kosovo", true);
  assert.deepEqual(t.S.settings, { perDay: 20, theme: "light", kosovo: true });
  for (const name of ["dark", "toString", "__proto__"])
    assert.throws(() => t.core.setSetting(name, true), /Unknown setting/, name);
  assert.deepEqual(t.S.settings, { perDay: 20, theme: "light", kosovo: true });
});

test("saved progress: a save from a newer version is recognized", () => {
  assert.equal(isNewer({ v: VERSION + 1 }), true);
  assert.equal(isNewer({ v: VERSION }), false);
  assert.equal(isNewer({ v: 1 }), false);
  assert.equal(isNewer(null), false);
});

test("saved progress: odd versions and odd field types never stop the upgrade, and isNewer and migrate agree on what a version means", () => {
  assert.equal(
    VERSION,
    2,
    "The table below is for VERSION 2. When you raise VERSION, update which upgrade steps each v " +
      "runs, and how this test tells that a step ran.",
  );
  // [v, isNewer, the UPGRADES steps migrate runs]. No version, or one below 1 or not a number, is version 1; a fraction
  // counts as the version below it; anything past VERSION is newer, and gets no steps.
  const ODD = [
    [undefined, false, [1]],
    [null, false, [1]],
    [-1, false, [1]],
    [0, false, [1]],
    [NaN, false, [1]],
    ["x", false, [1]],
    [true, false, [1]],
    [[], false, [1]],
    [{}, false, [1]],
    [1.5, false, [1]],
    ["2", false, []],
    [2.5, true, []],
    ["3", true, []],
    [[3], true, []],
    [Infinity, true, []],
  ];
  for (const [v, newer, steps] of ODD) {
    const name = `v: ${typeof v} ${String(v)}`;
    // Shaped as a version 1 save: settings.dark, and no theme.
    const saved = { v, settings: { perDay: 15, dark: true } },
      newerSave = isNewer(saved);
    assert.equal(newerSave, newer, `${name}: isNewer`);
    let s;
    assert.doesNotThrow(() => {
      s = migrate(saved);
    }, `${name}: migrate threw`);
    assert.equal(s.v, VERSION, name);
    // UPGRADES[1], the only step, is what removes settings.dark.
    assert.deepEqual("dark" in s.settings ? [] : [1], steps, `${name}: the upgrade steps run`);
    if (steps.includes(1))
      assert.deepEqual(
        s.settings,
        { perDay: 15, kosovo: false, theme: "dark" },
        `${name}: theme from dark`,
      );
    // A newer save may have fields this version doesn't know, so migrate must leave them, dark included.
    if (newerSave)
      assert.deepEqual(
        s.settings,
        { perDay: 15, kosovo: false, theme: "system", dark: true },
        `${name}: isNewer says a newer version wrote this save, but migrate upgraded it. A newer save gets no upgrade steps.`,
      );
    // A save that has a theme keeps it, whatever its version says.
    assert.equal(
      migrate({ v, settings: { theme: "dark" } }).settings.theme,
      "dark",
      `${name}: a save with a theme lost it`,
    );
  }
  for (const odd of [null, 5, "x", true, [], [1, 2]]) {
    for (const field of ["cards", "day", "settings", "confusions"]) {
      for (const v of [1, VERSION, 1.5]) {
        assert.deepEqual(
          migrate({ v, [field]: odd }),
          blankState(),
          `v ${v} with ${field}: ${JSON.stringify(odd)}`,
        );
      }
    }
  }
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
      td: {
        stage: "mc",
        streak: 1,
        reps: 3,
        lapses: 1,
        S: 1.2093,
        D: 7.3416,
        last: 20770,
        due: 20771,
      },
      fr: {
        stage: "typed",
        streak: 0,
        reps: 2,
        lapses: 0,
        S: 14.9694,
        D: 5.0867,
        last: 20769,
        due: 20772,
      },
    },
    day: { n: 20770, newDone: 10, bonus: 5 },
    settings: { perDay: 15, kosovo: true, dark: true },
    confusions: { "td>ro": 2 },
  },
  2: {
    v: 2,
    cards: {
      td: {
        stage: "mc",
        streak: 1,
        reps: 5,
        lapses: 2,
        S: 0.8571,
        D: 8.1022,
        last: 20776,
        due: 20777,
        missedOn: 20776,
      },
      fr: {
        stage: "typed",
        streak: 2,
        reps: 4,
        lapses: 0,
        S: 31.4462,
        D: 4.9718,
        last: 20775,
        due: 20806,
      },
    },
    day: { n: 20776, newDone: 8, bonus: 5 },
    settings: { perDay: 10, kosovo: false, theme: "dark" },
    confusions: { "td>ro": 3, "ro>td": 1 },
  },
};
// A state's keys, in the form of SAVED_SHAPE.
function shapeOf(S) {
  const keys = (o) => Object.keys(o).sort();
  return {
    top: keys(S),
    day: keys(S.day),
    settings: keys(S.settings),
    cards: [...new Set(Object.values(S.cards).flatMap(keys))].sort(),
  };
}
// A SAVED_SHAPE entry with every key, "?" or not: the shape of a save that has them all.
const everyKey = (shape) =>
  shape &&
  Object.fromEntries(
    Object.entries(shape).map(([part, keys]) => [part, keys.map((k) => k.replace(/\?$/, ""))]),
  );
// How a state differs from SAVED_SHAPE[v]: keys it has that the entry doesn't list (left over from an older
// version, say), and keys it lacks that aren't marked "?". Each card is compared on its own.
function shapeProblems(S, v) {
  const want = SAVED_SHAPE[v];
  const { top, day, settings } = shapeOf(S);
  const parts = [
    ["the top level", top, want.top],
    ["day", day, want.day],
    ["settings", settings, want.settings],
    ...Object.entries(S.cards).map(([c, card]) => [`card "${c}"`, Object.keys(card), want.cards]),
  ];
  const out = [];
  for (const [part, has, listed] of parts) {
    const all = listed.map((k) => k.replace(/\?$/, ""));
    for (const k of has)
      if (!all.includes(k)) out.push(`${part} has "${k}", which SAVED_SHAPE[${v}] doesn't list`);
    for (const k of listed)
      if (!k.endsWith("?") && !has.includes(k)) out.push(`${part} lacks "${k}"`);
  }
  return out;
}

// Plays through everything that writes saved progress, the way the page does, with Kosovo on: 10 days of sessions
// with random answers of every kind (see answerRandomly), "Learn 5 more", two rounds of extra practice a day, and
// each setting. Returns the setup, with the verdicts it got in t.verdicts.
function playThrough(Core) {
  const t = setup({}, seeded(11), Core),
    rand = seeded(12);
  t.verdicts = new Set();
  t.core.setSetting("kosovo", true);
  t.core.setSetting("theme", "dark");
  const play = (s) => {
    if (!s) return null;
    playAll(s, (it, q) => answerRandomly(s, it, q, rand).forEach((r) => t.verdicts.add(r.verdict)));
    return s.end();
  };
  for (let d = 0; d < 10; d++) {
    if (d === 6) t.core.setSetting("perDay", 15);
    play(t.core.session(d === 4 ? "more" : "normal"));
    const round = play(t.core.session("extra", newRun(5)));
    if (round) play(t.core.session("extra", round.run));
    t.nextDay();
  }
  return t;
}

test("saved progress: what gets saved matches the snapshot for this VERSION", () => {
  const saved = JSON.parse(JSON.stringify(playThrough().S));
  // The page adds a key for each pair of flags mixed up, so only its type is checked.
  assert.ok(
    saved.confusions && typeof saved.confusions === "object" && !Array.isArray(saved.confusions),
    "confusions should be an object",
  );
  const shape = shapeOf(saved);
  // The play-through reaches every key, so the ones marked "?" must be there too.
  assert.deepEqual(
    shape,
    everyKey(SAVED_SHAPE[VERSION]),
    `What gets saved doesn't match SAVED_SHAPE[${VERSION}] in test/core.test.js, ` +
      "or there is none. When what gets saved changes, raise VERSION in src/core.js, add an UPGRADES step there that " +
      'turns saves from the old version into the new shape, and add a SAVED_SHAPE for the new VERSION here, with "?" ' +
      `after any key only some saves have. What gets saved now:\n  ${JSON.stringify(shape)}`,
  );
});

test("saved progress: a full save from every older version upgrades to this VERSION's shape", () => {
  const missing = [];
  for (let v = 1; v < VERSION; v++) if (!SAVES[v]) missing.push(v);
  assert.deepEqual(
    missing,
    [],
    `SAVES in test/core.test.js has no save from version ${missing.join(", ")}. When you raise ` +
      "VERSION, add a full save from the old version there, as that version wrote it, with a card holding every card key. " +
      "This test upgrades it, to check that UPGRADES carries existing players' progress over.",
  );
  assert.ok(
    SAVED_SHAPE[VERSION],
    `There's no SAVED_SHAPE[${VERSION}] in test/core.test.js: add it (see the snapshot test above).`,
  );
  const problems = [];
  // From the newest down, so the first problem names the newest step.
  for (let v = VERSION; v >= 1; v--) {
    if (!SAVES[v]) continue;
    assert.deepEqual(
      shapeOf(SAVES[v]),
      everyKey(SAVED_SHAPE[v]),
      `SAVES[${v}] in test/core.test.js should be a full ` +
        `version ${v} save, with every key SAVED_SHAPE[${v}] lists (at least one card holding every card key) and no others.`,
    );
    let s;
    try {
      s = migrate(structuredClone(SAVES[v]));
    } catch (e) {
      problems.push(`version ${v} save: upgrading it threw "${e.message}"`);
      continue;
    }
    const lost = Object.keys(SAVES[v].cards).filter((c) => !s.cards[c]);
    if (lost.length) problems.push(`version ${v} save: upgrading it lost cards ${lost.join(", ")}`);
    for (const p of shapeProblems(s, VERSION)) problems.push(`version ${v} save: ${p}`);
  }
  assert.deepEqual(
    problems,
    [],
    `Upgrading older saves doesn't give the shape in SAVED_SHAPE[${VERSION}]. UPGRADES in ` +
      `src/core.js needs a step for every version from 1 to ${VERSION - 1} (UPGRADES[v] turns a version v save into a ` +
      "version v + 1 save), and each step must add, rename or remove every key that changed in that version. " +
      "Found:\n  " +
      problems.join("\n  "),
  );
});

// Functions createCore returns that change saved progress, each called so that it does (with the arguments from
// readArgs). session writes for "Learn 5 more"; its methods are checked in "random play keeps every rule".
const WRITERS = {
  touchDay: (k) => k.touchDay(),
  introduce: (k, { unseen }) => k.introduce(unseen),
  grade: (k, { codes }) => k.grade(codes[0], 3),
  session: (k) => k.session("more"),
  setSetting: (k) => k.setSetting("perDay", 20),
};
// Every other function createCore returns, each called with realistic arguments: `codes`, flags to ask about, and
// `run`, an extra practice run (see readArgs).
const READS = {
  dayNum: (k) => k.dayNum(),
  today: (k) => k.today(),
  active: (k) => k.active(),
  dueList: (k) => k.dueList(),
  practiced: (k) => k.practiced(),
  newAllowance: (k) => k.newAllowance(),
  planToday: (k) => k.planToday(),
  pickNew: (k) => k.pickNew(10),
  isActive: (k, { codes }) => codes.map((c) => k.isActive(c)),
  card: (k, { codes }) => codes.map((c) => k.card(c)),
  seen: (k, { codes }) => codes.map((c) => k.seen(c)),
  mastered: (k, { codes }) => codes.map((c) => k.mastered(c)),
  status: (k, { codes }) => codes.map((c) => k.status(c)),
  lookalikes: (k, { codes }) => codes.map((c) => k.lookalikes(c, 5)),
  distractors: (k, { codes }) => codes.map((c) => k.distractors(c)),
  // The right name, a typo of it, a typo as close to another country, another country's name, and a blank.
  judge: (k) =>
    [
      ["Cote d'Ivoire", "ci"],
      ["Argentna", "ar"],
      ["Austrlia", "au"],
      ["Romania", "td"],
      ["", "fr"],
    ].map(([s, c]) => k.judge(s, c)),
  buildQueue: (k, { run }) => [
    k.buildQueue("normal"),
    k.buildQueue("extra"),
    k.buildQueue("extra", run),
  ],
  afterRound: (k, { codes, run }) => k.afterRound(run, new Set(codes)),
  shuffle: (k, { codes }) => k.shuffle(codes),
};
// Arguments for READS and WRITERS: the first three flags seen, one not seen yet (if any is left), Kosovo, and an
// extra practice run two rounds in, as afterRound leaves it.
function readArgs(t) {
  const seenCodes = Object.keys(t.S.cards),
    unseen = CODES.find((c) => !t.S.cards[c]);
  return {
    codes: [...seenCodes.slice(0, 3), ...(unseen ? [unseen] : []), "xk"],
    unseen,
    run: { n: 20, skip: new Set(seenCodes.slice(0, 40)), last: new Set(seenCodes.slice(20, 40)) },
  };
}

test("saved progress: read-only functions never change it, with day counters from an earlier day or from today", () => {
  const t = setup({ kosovo: true }, seeded(13));
  practice(t, 8);
  // Today's misses don't touch the day counters, so those are still yesterday's.
  const [missed, hinted] = Object.keys(t.S.cards);
  t.core.grade(missed, 1);
  t.core.grade(hinted, 1, { keepStage: true });
  t.S.confusions = { [`${missed}>fr`]: 2 };
  const args = readArgs(t);

  const unsorted = Object.keys(t.core).filter(
    (f) => typeof t.core[f] === "function" && !(f in READS) && !(f in WRITERS),
  );
  assert.deepEqual(
    unsorted,
    [],
    `createCore returns ${unsorted.join(", ")}, which this test doesn't know about. Add each one ` +
      "to WRITERS with a call that changes saved progress if it can, or to READS with a realistic call if it can't.",
  );

  assert.notEqual(t.S.day.n, t.core.dayNum());
  for (const counters of ["left over from an earlier day", "from today"]) {
    // The second time, today's counters, as after "Learn 5 more" five times: big enough that a read clamping them would show.
    if (counters === "from today") Object.assign(t.core.touchDay(), { newDone: 12, bonus: 25 });
    // Taken before any read is called, so a read that writes shows up below.
    const before = JSON.stringify(t.S);
    for (const [f, call] of Object.entries(READS)) {
      const calls = t.changed;
      call(t.core, args);
      assert.ok(
        JSON.stringify(t.S) === before,
        `${f} changed saved progress (with day counters ${counters}), but it's meant ` +
          "to only read it: the page's next save would store the change. Make it leave the state alone, or if it's meant " +
          "to write, move it to WRITERS.",
      );
      assert.equal(
        t.changed,
        calls,
        `${f} called env.changed() (with day counters ${counters}), but it only reads saved ` +
          "progress, so the page saves for nothing. Call changed() in src/core.js only where saved progress is written.",
      );
    }
  }
});

test("saved progress: every function that changes it calls env.changed(), so the page saves", () => {
  for (const [f, call] of Object.entries(WRITERS)) {
    const t = setup({}, seeded(20));
    practice(t, 2);
    const args = readArgs(t),
      before = JSON.stringify(t.S),
      calls = t.changed;
    call(t.core, args);
    assert.notEqual(
      JSON.stringify(t.S),
      before,
      `WRITERS.${f} in test/core.test.js should call ${f} so that it changes saved progress`,
    );
    assert.ok(
      t.changed > calls,
      `${f} changed saved progress without calling env.changed(), so the page won't save the change ` +
        "and it's lost on reload. In src/core.js, call changed() wherever saved progress is written.",
    );
  }
});

/* ---------- No page code ---------- */
const CORE_PATH = path.join(__dirname, "..", "src", "core.js");
// Names the page or Node has. In the sandbox, reading one throws, even through typeof, so a check like
// `typeof document !== "undefined"` can't hide page code. Using any other name the sandbox lacks throws a ReferenceError.
const PAGE_AND_NODE = [
  "window",
  "self",
  "document",
  "location",
  "navigator",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "fetch",
  "requestAnimationFrame",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "crypto",
  "performance",
  "console",
  "process",
  "require",
  "global",
  "Buffer",
];
// Loads src/core.js in a fresh context with nothing but the language itself, where reading the clock or randomness
// directly throws. Returns what core.js exports, through the module object it looks for.
function sandboxedCore() {
  const context = vm.createContext({ module: {} });
  const g = vm.runInContext("globalThis", context);
  const off = (what) => {
    throw Object.assign(new Error(`core.js used ${what}`), { used: what });
  };
  for (const name of PAGE_AND_NODE) Object.defineProperty(g, name, { get: () => off(name) });
  g.Math.random = () => off("Math.random()");
  // new Date(ms) still works: dayNum() turns env.now() into a date.
  const RealDate = g.Date;
  function SandboxDate(...args) {
    if (!new.target) off("Date()");
    if (!args.length) off("new Date() with no time");
    return Reflect.construct(RealDate, args, new.target);
  }
  Object.assign(SandboxDate, {
    prototype: RealDate.prototype,
    UTC: RealDate.UTC,
    parse: RealDate.parse,
    now: () => off("Date.now()"),
  });
  g.Date = SandboxDate;
  vm.runInContext(fs.readFileSync(CORE_PATH, "utf8"), context, { filename: CORE_PATH });
  return context.module.exports;
}

test("core.js: no page code, and the clock and randomness come only through env", () => {
  // Runs everything the page does with core.js, in the sandbox. Code that never runs isn't checked this way, but
  // code that never runs can't misbehave either.
  try {
    const Core = sandboxedCore();
    const early = setup({ kosovo: true }, seeded(13), Core);
    practice(early, 3);
    const late = playThrough(Core);
    assert.deepEqual(
      [...late.verdicts].sort(),
      ["ambiguous", "empty", "hinted", "miss", "right", "typo"],
      "The play-through " +
        "no longer gives every kind of answer, so this test doesn't run all of the session code. Change its seed or play more days.",
    );
    for (const t of [early, late]) {
      const [a, b] = Object.keys(t.S.cards);
      t.S.confusions = { [`${a}>${b}`]: 2, [`${b}>fr`]: 1 }; // mix-ups, as the page records them
      for (const call of Object.values(READS)) call(t.core, readArgs(t));
    }
    for (const v in SAVES) Core.migrate(structuredClone(SAVES[v]));
    Core.migrate(null);
    Core.isNewer({ v: Core.VERSION + 1 });
  } catch (e) {
    const used =
      e.used || (e.name === "ReferenceError" && (/^(\S+) is not defined/.exec(e.message) || [])[1]);
    if (!used) throw e;
    const line = (/src[\\/]core\.js:(\d+)/.exec(e.stack) || [])[1];
    assert.fail(
      `src/core.js${line ? ` line ${line}` : ""} uses ${used}. core.js must not use page or Node globals, and must ` +
        "take the clock and randomness only through env (now, random) in createCore, so the page and the tests control them.",
    );
  }
});

/* ---------- FSRS ---------- */
test("FSRS: first answers use the weights, and intervals target 90% recall", () => {
  assert.equal(fsrs(null, 3).S, W[2]);
  assert.equal(retr(0, 5), 1);
  assert.ok(Math.abs(ivlFor(10) - 10) < 1e-9);
  assert.ok(Math.abs(retr(ivlFor(10), 10) - 0.9) < 1e-9);
});
