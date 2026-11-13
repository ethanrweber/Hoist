// The app's rules, with no page or storage code: saved-progress upgrades, the FSRS scheduler, which flags
// are new today, building a session, and checking typed answers.
// build.js inlines this file into index.html, and test/core.test.js loads it in Node.
const HoistCore = (() => {
"use strict";

/* ---------- Saved progress ---------- */
const VERSION = 2;
function blankState(){
  return {v: VERSION, cards: {}, day: {n: 0, newDone: 0, bonus: 0}, settings: {perDay: 10, kosovo: false, theme: "system"}, confusions: {}};
}
const isObj = x => x !== null && typeof x === "object" && !Array.isArray(x);
// UPGRADES[k] turns a version-k save into a version k + 1 save. Add a step whenever the saved shape changes.
const UPGRADES = {
  // settings.dark (true/false) became settings.theme ("system", "light" or "dark").
  1: s => { const st = isObj(s.settings) ? s.settings : {}; st.theme = st.dark ? "dark" : "system"; delete st.dark; s.settings = st; },
};
// True when the save was written by a newer version of Hoist (open in another tab). Such a save can be
// shown, but this version must not write over it: it doesn't know the newer fields.
function isNewer(saved){ return isObj(saved) && saved.v > VERSION; }
// Turns whatever was in storage into a current-version state, filling in anything missing.
function migrate(saved){
  if (!isObj(saved)) return blankState();
  for (let v = saved.v || 1; v < VERSION; v++) UPGRADES[v](saved);
  const b = blankState();
  return {
    v: VERSION,
    cards: isObj(saved.cards) ? saved.cards : b.cards,
    day: Object.assign(b.day, isObj(saved.day) ? saved.day : {}),
    settings: Object.assign(b.settings, isObj(saved.settings) ? saved.settings : {}),
    confusions: isObj(saved.confusions) ? saved.confusions : b.confusions,
  };
}

/* ---------- FSRS-4.5 scheduler ---------- */
const W = [0.4872,1.4003,3.7145,13.8206,5.1618,1.2298,0.8975,0.031,1.6474,0.1367,1.0461,2.1072,0.0793,0.3246,1.587,0.2272,2.8755];
const DECAY = -0.5, FACTOR = 19/81, RETAIN = 0.9;
const clampD = d => Math.min(10, Math.max(1, d));
const retr = (t, s) => Math.pow(1 + FACTOR * t / s, DECAY);
const ivlFor = s => s / FACTOR * (Math.pow(RETAIN, 1/DECAY) - 1);
const D0 = g => clampD(W[4] - (g - 3) * W[5]);
function fsrs(st, g, elapsed){
  if (!st) return {S: W[g-1], D: D0(g)};
  const r = retr(elapsed, st.S);
  let D = st.D - W[6] * (g - 3); D = clampD(W[7] * D0(4) + (1 - W[7]) * D);
  let s;
  if (g === 1) s = Math.min(st.S, W[11] * Math.pow(st.D, -W[12]) * (Math.pow(st.S + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r)));
  else s = st.S * (1 + Math.exp(W[8]) * (11 - st.D) * Math.pow(st.S, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * (g === 2 ? W[15] : 1));
  return {S: Math.max(0.1, s), D};
}

/* ---------- Randomness ---------- */
function shuffle(a, rand){ a = a.slice(); for (let i = a.length - 1; i > 0; i--){ const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function rng(seed){ return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/*
 * data: {countries, families, neighbors}
 * env:  {state: () => the current state, now?: () => ms (default Date.now), random?: () => [0, 1) (default Math.random)}
 * Every function reads env.state() when called, so the page can swap in a freshly loaded state.
 * Functions here change the state but never save it: the caller saves.
 */
function createCore(data, env){
  const COUNTRIES = data.countries, FAMILIES = data.families, NEIGHBORS = data.neighbors;
  const state = env.state, now = env.now || Date.now, random = env.random || Math.random;
  const BY = {}; COUNTRIES.forEach(c => BY[c.c] = c);
  const SIB = {}; FAMILIES.forEach(f => f.forEach(c => SIB[c] = f.filter(x => x !== c)));

  /* ---------- Days: a day rolls over at 4am local time ---------- */
  function dayNum(){ const d = new Date(now() - 4*3600e3); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5); }
  // Today's counters. Reading never changes the state: counters from an earlier day read as zeros.
  function today(){ const t = dayNum(), d = state().day; return d.n === t ? d : {n: t, newDone: 0, bonus: 0}; }
  // Today's counters, stored in the state so they can be changed. Call only right before saving.
  function touchDay(){ const s = state(); s.day = today(); return s.day; }

  /* ---------- Flags and their status ---------- */
  function active(){ return COUNTRIES.filter(c => !c.optional || state().settings.kosovo).map(c => c.c); }
  function isActive(c){ return !!BY[c] && (!BY[c].optional || state().settings.kosovo); }
  function card(c){ return state().cards[c]; }
  function seen(c){ return !!card(c); }
  function mastered(c){ const k = card(c); return !!k && k.stage === "typed" && k.S >= 21; }
  function status(c){ return !seen(c) ? "new" : mastered(c) ? "mastered" : "learning"; }
  function dueList(){ const t = dayNum(); return active().filter(c => seen(c) && card(c).due <= t); }
  function newAllowance(){ const d = today(); return Math.max(0, state().settings.perDay + d.bonus - d.newDone); }

  /* ---------- Look-alikes and wrong answers ---------- */
  function confusedWith(c){
    const conf = state().confusions, m = {};
    for (const k in conf){ const [a,b] = k.split(">"); if (a === c) m[b] = (m[b]||0) + conf[k]; else if (b === c) m[a] = (m[a]||0) + conf[k]; }
    return Object.keys(m).filter(isActive).sort((x,y) => m[y] - m[x]);
  }
  // Collects distinct active codes other than `c`, in the order they are added.
  function collector(c){ const out = []; return {out, add: x => { if (x !== c && isActive(x) && !out.includes(x)) out.push(x); }}; }
  function lookalikes(c, n){
    const {out, add} = collector(c);
    (SIB[c] || []).forEach(add); confusedWith(c).forEach(add);
    if (out.length < 2) (NEIGHBORS[c] || []).slice(0, 3).forEach(add);
    return out.slice(0, n || 5);
  }
  function distractors(c){
    const {out, add} = collector(c);
    const conf = confusedWith(c);
    if (conf[0]) add(conf[0]);
    shuffle(SIB[c] || [], random).forEach(add);
    conf.slice(1).forEach(add);
    (NEIGHBORS[c] || []).forEach(add);
    for (const x of shuffle(active(), random)){ if (out.length >= 3) break; add(x); }
    return out.slice(0, 3);
  }

  /* ---------- New flags: look-alike families come in together, mixed with stand-alone flags ---------- */
  const UNITS = (() => {
    const r = rng(196);
    const inFam = new Set(FAMILIES.flat());
    const fams = shuffle(FAMILIES, r), singles = shuffle(COUNTRIES.map(c => c.c).filter(c => !inFam.has(c)).map(c => [c]), r);
    const units = []; let s = 0;
    for (const f of fams){ units.push(f); for (let k = 0; k < 2 && s < singles.length; k++) units.push(singles[s++]); }
    while (s < singles.length) units.push(singles[s++]);
    return units;
  })();
  // Groups of new flags for a day with room for `n`. A family can run up to 2 over so it isn't split.
  function pickNew(n){
    const groups = []; let left = n;
    for (const u of UNITS){
      if (left <= 0) break;
      const m = u.filter(c => isActive(c) && !seen(c));
      if (!m.length) continue;
      if (m.length <= left + 2){ groups.push(m); left -= m.length; }
    }
    return groups;
  }
  // Today's reviews and new flags. The home screen and the session both use this, so their counts agree.
  function planToday(){
    const due = dueList(), groups = pickNew(newAllowance());
    return {due, groups, nNew: groups.reduce((n, g) => n + g.length, 0)};
  }

  /* ---------- Answer checking ---------- */
  function norm(s){
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/&/g, " and ").replace(/['’`.]/g, "").replace(/[^a-z0-9]+/g, " ").trim()
      .replace(/^the /, "").replace(/\bsaint\b/g, "st");
  }
  const NAMES = [];
  COUNTRIES.forEach(c => [c.n].concat(c.a || []).forEach(n => NAMES.push([norm(n), c.c])));
  const EXACT = new Map(NAMES);
  // Edit distance where swapping two neighboring letters counts as one edit, like a dropped or extra letter.
  function lev(a, b){
    if (Math.abs(a.length - b.length) > 3) return 9;
    let prev2 = null, prev = Array.from({length: b.length + 1}, (_, i) => i);
    for (let i = 1; i <= a.length; i++){
      const cur = [i];
      for (let j = 1; j <= b.length; j++){
        cur[j] = Math.min(prev[j] + 1, cur[j-1] + 1, prev[j-1] + (a[i-1] === b[j-1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i-1] === b[j-2] && a[i-2] === b[j-1]) cur[j] = Math.min(cur[j], prev2[j-2] + 1);
      }
      prev2 = prev; prev = cur;
    }
    return prev[b.length];
  }
  // {empty} for a blank answer, {ok} for the right name, {ok, typo} for a near miss of the right name only,
  // {ambiguous} for a typo as close to another country as to the right one (there's no telling which was
  // meant: "Austrlia" could be Australia or Austria), and {ok: false, guess?} otherwise.
  function judge(input, c){
    const q = norm(input);
    if (!q) return {empty: true};
    const ex = EXACT.get(q);
    if (ex && isActive(ex)) return ex === c ? {ok: true} : {ok: false, guess: ex};
    let best = 9, hits = new Set();
    for (const [n, code] of NAMES){
      if (!isActive(code)) continue;
      const tol = n.length <= 4 ? 0 : n.length <= 7 ? 1 : 2;
      const d = lev(q, n);
      if (d > tol) continue;
      if (d < best){ best = d; hits = new Set([code]); } else if (d === best) hits.add(code);
    }
    const others = [...hits].filter(x => x !== c);
    if (hits.has(c)) return others.length ? {ambiguous: true} : {ok: true, typo: true};
    return others.length ? {ok: false, guess: others[0]} : {ok: false};
  }

  /* ---------- Grading ---------- */
  // Returns true if the flag was new.
  function introduce(c){
    if (seen(c)) return false;
    const t = dayNum();
    state().cards[c] = {stage: "mc", streak: 0, reps: 0, lapses: 0, S: 0, D: 0, last: t, due: t};
    touchDay().newDone++;
    return true;
  }
  // g: 1 again, 2 hard, 3 good. A flag starts as multiple choice ("mc") and moves to typing ("typed") after
  // two right answers in a row; a typing miss sends it back. keepStage makes a miss leave the flag at typing:
  // used for a right pick after "Show choices" (recognized, but the name wasn't recalled).
  function grade(c, g, {keepStage = false} = {}){
    introduce(c);
    const t = dayNum(), k = card(c);
    const first = !k.reps, elapsed = Math.max(0, t - k.last);
    const st = fsrs(first ? null : {S: k.S, D: k.D}, g, elapsed);
    k.S = st.S; k.D = st.D; k.reps++; k.last = t;
    const ok = g > 1; let graduated = false;
    if (k.stage === "mc"){ if (ok){ k.streak++; if (k.streak >= 2){ k.stage = "typed"; k.streak = 0; graduated = true; } } else k.streak = 0; }
    else if (ok) k.streak++;
    else { k.lapses++; if (keepStage) k.streak = 0; else { k.stage = "mc"; k.streak = 1; } }
    let ivl = (first || !ok) ? 1 : Math.max(1, Math.round(ivlFor(k.S) * (k.S > 3 ? 0.95 + random() * 0.1 : 1)));
    if (k.stage === "mc") ivl = Math.min(ivl, 2);   // recognition alone doesn't earn long gaps
    if (graduated) ivl = Math.min(ivl, 3);           // first typed recall comes soon after graduating
    k.due = t + ivl;
  }

  /* ---------- Sessions ---------- */
  // The session's items in order: {k: "intro", c} shows a new flag, {k: "ask", c, n} asks for it (n = attempt).
  function buildQueue(mode){
    const t = dayNum();
    if (mode === "extra"){
      const pool = active().filter(c => seen(c) && card(c).reps > 0)
        .sort((a,b) => retr(t - card(a).last, Math.max(card(a).S, .1)) - retr(t - card(b).last, Math.max(card(b).S, .1))).slice(0, 20);
      return shuffle(pool, random).map(c => ({k: "ask", c, n: 1}));
    }
    const plan = planToday();
    const reviews = shuffle(plan.due, random).sort((a,b) => card(a).due - card(b).due).slice(0, 120);
    const rv = shuffle(reviews, random).map(c => ({k: "ask", c, n: 1}));
    const items = []; let pending = [];
    for (const g of plan.groups){
      g.forEach(c => items.push({k: "intro", c}));
      items.push(...shuffle(pending, random));
      pending = g.map(c => ({k: "ask", c, n: 1}));
    }
    items.push(...shuffle(pending, random));
    const out = []; const total = items.length + rv.length; let ri = 0, ii = 0;
    for (let p = 0; p < total; p++){
      const want = Math.round((p + 1) * rv.length / total);
      if (ri < want || ii >= items.length) out.push(rv[ri++]); else out.push(items[ii++]);
    }
    return out;
  }

  return {BY, dayNum, today, touchDay, active, isActive, card, seen, mastered, status, dueList, newAllowance,
    lookalikes, distractors, pickNew, planToday, judge, introduce, grade, buildQueue, shuffle: a => shuffle(a, random)};
}

return {VERSION, blankState, isNewer, migrate, createCore, fsrs, retr, ivlFor, W};
})();

if (typeof module !== "undefined") module.exports = HoistCore;
