// The page: draws the screens, turns clicks and keys into answers for core.ts, and saves progress in the browser.
// build.ts bundles it, with core.ts, into the script in index.html.
import { blankState, createCore, isNewer, migrate } from "./core.ts";
import type {
  AnswerResult,
  Code,
  Country,
  Family,
  Mode,
  Neighbors,
  Region,
  Run,
  Session,
  State,
  Summary,
  Theme,
} from "./core.ts";

// The data, from a script that build.ts puts before this one: COUNTRIES and FAMILIES from countries.ts (with
// curly apostrophes in names and hooks), NEIGHBORS from neighbors.json, and FLAGS, each flag's SVG by code.
declare const COUNTRIES: readonly Country[];
declare const FAMILIES: readonly Family[];
declare const NEIGHBORS: Neighbors;
declare const FLAGS: Readonly<Record<Code, string>>;

const KEY = "hoist.v1";
const REGIONS: Region[] = ["Africa", "Americas", "Asia", "Europe", "Oceania"];
// A kind of element, such as HTMLInputElement.
type ElementClass<T extends Element> = new () => T;
// The element `selector` finds in `root` (the page unless given). It must be there, and be a `type` (any
// HTMLElement unless given): give the type to use what only that kind of element has.
function $(selector: string): HTMLElement;
function $<T extends Element>(selector: string, type: ElementClass<T>, root?: ParentNode): T;
function $(
  selector: string,
  type: ElementClass<Element> = HTMLElement,
  root: ParentNode = document,
): Element {
  const el = root.querySelector(selector);
  if (!(el instanceof type)) throw new Error(`${selector} should find a ${type.name}`);
  return el;
}
// Every element `selector` finds in `root`, each of which must be a `type`.
function $$<T extends Element>(
  selector: string,
  type: ElementClass<T>,
  root: ParentNode = document,
): T[] {
  return [...root.querySelectorAll(selector)].map((el) => {
    if (!(el instanceof type)) throw new Error(`${selector} should find only ${type.name}s`);
    return el;
  });
}
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string) => String(s).replace(/[&<>"]/g, (ch) => ENTITIES[ch]);

/* ---------- Storage ---------- */
// Progress lives under one localStorage key, and other tabs may save it too. So the page reloads it when
// another tab saves and whenever the page is shown again (see Events), instead of writing back a stale copy.
let S: State;
let saveFailed = false;
// True while the saved progress comes from a newer version of Hoist (open in another tab). This page then
// shows that progress but never saves, and asks to be reloaded.
let outdated = false;
function load(): State {
  let saved: unknown = null;
  try {
    // Nothing saved yet parses as null.
    saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch (e) {}
  outdated = isNewer(saved);
  $("#outdated").classList.toggle("hidden", !outdated);
  return migrate(saved);
}
function save() {
  if (outdated) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(S));
    saveFailed = false;
  } catch (e) {
    saveFailed = true;
  }
}
// core.ts calls this when it changes the progress (env.changed in core.ts). The save waits until the code running now
// is done, so it holds the whole change, and changes made together are saved once. It still runs before the next
// event, so loading what another tab saved (see refresh) can't drop the change first.
let savePending = false;
function changed() {
  if (savePending) return;
  savePending = true;
  queueMicrotask(() => {
    savePending = false;
    save();
  });
}
// Skipped while saving fails (private mode, full storage), so progress that exists only in this page isn't dropped.
function reload() {
  if (!saveFailed) S = load();
}
S = load();

const {
  BY,
  dayNum,
  active,
  isActive,
  card,
  seen,
  mastered,
  status,
  practiced,
  lookalikes,
  planToday,
  session,
  setSetting,
  shuffle,
} = createCore(
  { countries: COUNTRIES, families: FAMILIES, neighbors: NEIGHBORS },
  { state: () => S, changed },
);

/* ---------- Flags ---------- */
// Each SVG becomes a blob: URL once, so <img> tags carry a short link instead of the whole file.
const urlCache: Record<Code, string> = {};
function src(c: Code) {
  return (
    urlCache[c] ||
    (urlCache[c] = URL.createObjectURL(new Blob([FLAGS[c]], { type: "image/svg+xml" })))
  );
}
function img(c: Code, alt?: string) {
  return `<img class="flag" src="${src(c)}" alt="${esc(alt == null ? "Flag" : alt)}" decoding="async">`;
}
// The "Easy to mix up with" row. With `clickable`, each flag opens its detail dialog.
function alikesHTML(list: Code[], clickable?: boolean) {
  if (!list.length) return "";
  const item = (x: Code) =>
    clickable
      ? `<button class="alike" type="button" data-show="${x}">${img(x, "")}<span>${esc(BY[x].n)}</span></button>`
      : `<div class="alike">${img(x, "")}<span>${esc(BY[x].n)}</span></div>`;
  return `<div class="alikes"><p>Easy to mix up with</p><div class="alike-row">${list.map(item).join("")}</div></div>`;
}

/* ---------- Home ---------- */
function renderHome() {
  const plan = planToday(),
    due = plan.due,
    nNew = plan.nNew;
  const anySeen = Object.keys(S.cards).length > 0;
  const total = active().length;

  // Today's hoist: the flags waiting for review, plus blank tags for the new ones
  const row = $("#hoistRow");
  const hal = $("#halyard");
  const doneToday =
    !due.length && !nNew
      ? active().filter((c) => {
          const k = card(c);
          return !!k && k.last === dayNum() && k.reps > 0;
        })
      : [];
  const show = shuffle(due.length ? due : doneToday).slice(0, 14);
  let h = show.map((c) => `<div class="pennant">${img(c, "")}</div>`).join("");
  const blanks = Math.min(nNew, Math.max(0, 16 - show.length));
  for (let i = 0; i < blanks; i++) h += `<div class="pennant blank"><span></span></div>`;
  const extra = (due.length ? due.length : doneToday.length) - show.length + nNew - blanks;
  if (extra > 0) h += `<div class="pennant more">+${extra}</div>`;
  row.innerHTML = h;
  hal.classList.toggle("empty", !h);

  const mins = Math.max(1, Math.round((due.length * 9 + nNew * 22) / 60));
  const lead = $("#lead"),
    acts = $("#actions");
  const kbd = `<span class="kbd">Enter</span>`;
  if (!anySeen) {
    lead.innerHTML = `Learn all ${total} flags in short daily sessions. Today: <strong>${nNew} new flags</strong>, about ${mins} minutes.`;
    acts.innerHTML = `<button class="btn btn-primary" data-act="start" type="button">Start session${kbd}</button>`;
  } else if (due.length || nNew) {
    const parts = [];
    if (due.length)
      parts.push(`<strong>${due.length} ${due.length === 1 ? "review" : "reviews"}</strong>`);
    if (nNew) parts.push(`<strong>${nNew} new ${nNew === 1 ? "flag" : "flags"}</strong>`);
    lead.innerHTML = `${parts.join(" and ")} today, about ${mins} ${mins === 1 ? "minute" : "minutes"}.`;
    acts.innerHTML = `<button class="btn btn-primary" data-act="start" type="button">Start session${kbd}</button>`;
  } else {
    const next: number | undefined = active()
      .flatMap((c) => card(c)?.due ?? [])
      .sort((a, b) => a - b)[0];
    const leftToLearn = active().filter((c) => !seen(c)).length;
    const when =
      next == null
        ? ""
        : next - dayNum() <= 1
          ? " Next reviews tomorrow."
          : ` Next reviews in ${next - dayNum()} days.`;
    lead.innerHTML = `You’re done for today.${when}`;
    const pool = practiced().length;
    acts.innerHTML =
      (leftToLearn
        ? `<button class="btn btn-primary" data-act="more" type="button">Learn 5 more flags</button>`
        : "") + (pool >= 4 ? extraHTML(pool) : "");
  }
  updateWall(total);
}
// Extra practice buttons: 20 and 50 when there are more flags than that to practice, and always all of them.
// data-n is the round size, or "all". The screen-reader labels start with the visible text, so voice control
// users can say what they see.
function extraHTML(pool: number) {
  const btn = (n: number | "all", label: string | number, aria?: string) =>
    `<button class="btn btn-quiet" data-act="extra" data-n="${n}" type="button"${aria ? ` aria-label="${aria}"` : ""}>${label}</button>`;
  const sizes = [20, 50].filter((n) => n < pool);
  if (!sizes.length) return btn("all", `Extra practice (${pool})`);
  return (
    `<div class="extra" role="group" aria-labelledby="extraLabel"><span id="extraLabel">Extra practice</span>` +
    sizes.map((n) => btn(n, n, `${n} flags`)).join("") +
    btn("all", `All ${pool}`, `All ${pool} flags`) +
    `</div>`
  );
}

/* ---------- The wall: built once, then only each tile's status changes ---------- */
function buildWall() {
  $("#regions").innerHTML = REGIONS.map((r) => {
    const list = COUNTRIES.filter((c) => c.r === r).sort((a, b) => a.n.localeCompare(b.n));
    return `<section class="region"><div class="region-head"><h3>${r}</h3><span></span></div>
      <div class="tiles">${list.map((c) => `<button class="tile" type="button" data-show="${c.c}">${img(c.c, "")}</button>`).join("")}</div></section>`;
  }).join("");
}
function updateWall(total: number) {
  const m = active().filter(mastered).length,
    l = active().filter((c) => status(c) === "learning").length;
  $("#wallTitle").textContent = `All ${total} flags`;
  $("#wallStats").textContent = `${m} mastered, ${l} learning, ${total - m - l} not started`;
  document.querySelectorAll("#regions .region").forEach((sec) => {
    let shown = 0,
      done = 0;
    $$(".tile", HTMLElement, sec).forEach((t) => {
      const c = t.dataset.show;
      if (c === undefined || !isActive(c)) {
        t.className = "tile hidden";
        return;
      }
      const st = status(c);
      shown++;
      if (st === "mastered") done++;
      t.className = `tile is-${st}`;
      t.setAttribute("aria-label", `${BY[c].n}, ${st === "new" ? "not started" : st}`);
    });
    $(".region-head span", HTMLElement, sec).textContent = `${done} of ${shown} mastered`;
  });
}

/* ---------- Detail dialog ---------- */
function showDetail(c: Code) {
  const k = card(c),
    t = dayNum(),
    st = status(c);
  let line: string;
  if (!k) line = "Not introduced yet.";
  else {
    const d = k.due - t;
    const when =
      d <= 0 ? "due today" : d === 1 ? "next review tomorrow" : `next review in ${d} days`;
    line =
      (st === "mastered"
        ? "Mastered"
        : k.stage === "typed"
          ? "Learning, typing the name"
          : "Learning, multiple choice") +
      ", " +
      when +
      ".";
  }
  $("#detailBody").innerHTML = `
    <div class="dlg-top"><h2>${esc(BY[c].n)}</h2><button class="close" type="button" data-close aria-label="Close">&times;</button></div>
    <div class="mast small">${img(c, "Flag of " + BY[c].n)}</div>
    <p class="hook">${esc(BY[c].h)}</p>
    <p class="status">${line}</p>
    ${alikesHTML(lookalikes(c, 5), true)}`;
  const dlg = $("#detail", HTMLDialogElement);
  if (!dlg.open) dlg.showModal();
}

/* ---------- Session ---------- */
// The session on screen. sess.core is its rules and progress (session() in core.ts); the rest is the page's:
// view routes keys, t0 and firstKey time the answer, opts are the choices in order, timer moves on after an answer,
// and missAt is when the miss screen came up. Each is set before it's read (see renderAsk and showMiss).
interface OnScreen {
  core: Session;
  view: "intro" | "mc" | "typed" | "done-good" | "miss" | null;
  t0: number;
  firstKey: number | null;
  opts: Code[];
  timer?: number;
  missAt: number;
}
let sess: OnScreen | null = null;
// The current run of extra practice (see afterRound in core.ts). A size button on the home screen starts a run;
// "Another" on the summary continues it.
let run: Run | undefined;
function startSession(mode: Mode) {
  const s = session(mode, run);
  // Nothing to do, say after progress was reset in another tab while this one showed the summary.
  if (!s) {
    goHome();
    return;
  }
  sess = { core: s, view: null, t0: 0, firstKey: null, opts: [], missAt: 0 };
  $("#home").classList.add("hidden");
  $("#summary").classList.add("hidden");
  $("#session").classList.remove("hidden");
  window.scrollTo(0, 0);
  next();
}
function endSession() {
  const s = sess;
  sess = null;
  if (s) clearTimeout(s.timer);
  const done = s && s.core.end();
  if (done) run = done.run;
  $("#session").classList.add("hidden");
  if (done && done.summary.total) showSummary(done.summary);
  else {
    $("#home").classList.remove("hidden");
    renderHome();
  }
}
function updateBar(s: OnScreen) {
  const { done, total } = s.core.progress();
  $("#progressFill").style.width = (100 * done) / Math.max(1, total) + "%";
  $("#count").textContent = `${Math.min(done + 1, total)} of ${total}`;
}
function next() {
  if (!sess) return;
  sess.core.next();
  const it = sess.core.current();
  if (!it) {
    endSession();
    return;
  }
  updateBar(sess);
  if (it.k === "intro") renderIntro(sess, it.c);
  else renderAsk(sess);
}
function mastHTML(c: Code, cls?: string) {
  return `<div class="mast raise ${cls || ""}">${img(c, "Flag to identify")}</div>`;
}

function renderIntro(s: OnScreen, c: Code) {
  s.view = "intro";
  $("#stage").innerHTML = `
    <p class="tag">New flag</p>
    <div class="mast raise">${img(c, "Flag of " + BY[c].n)}</div>
    <h2 class="name">${esc(BY[c].n)}</h2>
    <p class="hook">${esc(BY[c].h)}</p>
    ${alikesHTML(lookalikes(c, 5))}
    <button class="btn btn-primary" type="button" data-act="next">Got it<span class="kbd">Enter</span></button>`;
  focusMain();
}

// forceMC: "Show choices" on a typing question. Does nothing once the question has its answer.
function renderAsk(s: OnScreen, forceMC?: boolean) {
  const ask = s.core.question({ hint: forceMC }),
    it = s.core.current();
  if (!ask || !it || it.k !== "ask") return;
  const c = it.c;
  s.view = ask.view;
  s.t0 = performance.now();
  s.firstKey = null;
  const tag =
    s.core.mode === "extra"
      ? `<p class="tag">Extra practice</p>`
      : it.n > 1
        ? `<p class="tag">Try again</p>`
        : "";
  if (ask.view === "mc") {
    const opts = ask.options;
    s.opts = opts;
    $("#stage").innerHTML = `${tag}${forceMC ? "" : mastHTML(c, "fit")}
      ${forceMC ? `<div class="mast fit">${img(c, "Flag to identify")}</div>` : ""}
      <p class="prompt">Which country?</p>
      <div class="choices">${opts.map((o, i) => `<button class="choice" type="button" data-pick="${o}"><span class="n">${i + 1}</span><span>${esc(BY[o].n)}</span></button>`).join("")}</div>`;
    focusMain();
  } else {
    $("#stage").innerHTML = `${tag}${mastHTML(c, "fit")}
      <form class="typed" id="typedForm" autocomplete="off">
        <label class="sr" for="answer">Country name</label>
        <div class="typed-row">
          <input id="answer" name="answer" type="text" placeholder="Type the country" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="done">
          <button class="btn btn-primary" type="submit">Check</button>
        </div>
        <p class="hint retry hidden" id="typedNote"></p>
        <div class="typed-help">
          <button class="linkbtn" type="button" data-act="hint">Show choices</button>
          <button class="linkbtn" type="button" data-act="dunno">I don’t know</button>
        </div>
        <p class="hint kbd-hint">Press Enter on an empty box to see choices, or Esc if you don’t know.</p>
      </form>`;
    const inp = $("#answer", HTMLInputElement);
    inp.addEventListener("input", () => {
      if (sess && sess.firstKey == null) sess.firstKey = performance.now() - sess.t0;
    });
    inp.focus({ preventScroll: true });
  }
  $(".stage").scrollTop = 0;
  fitFlag();
  const im = $("#stage .mast.fit img", HTMLImageElement);
  if (!im.complete) im.addEventListener("load", fitFlag, { once: true }); // its size isn't known until it loads
}
// Shrinks the question's flag (to no less than 56px tall) until the last answer, or the text box, is inside the
// visible stage: on small phones, or above the on-screen keyboard. It measures rather than assumes, so tag lines,
// answers that wrap and the retype note all count. Links below the text box may still need a scroll.
function fitFlag() {
  const im = sess && document.querySelector("#stage .mast.fit img");
  if (!(im instanceof HTMLImageElement)) return;
  const target =
    document.querySelector("#stage .typed-row") ||
    [...document.querySelectorAll("#stage .choice")].pop();
  if (!target) return;
  im.style.maxHeight = "";
  const stage = $(".stage");
  const bottom =
    target.getBoundingClientRect().bottom - stage.getBoundingClientRect().top + stage.scrollTop; // within the stage's content
  const over = bottom + 4 - stage.clientHeight;
  if (over > 0) im.style.maxHeight = Math.max(56, im.getBoundingClientRect().height - over) + "px";
}
function focusMain() {
  const b = document.querySelector("#stage .choice, #stage [data-act=next]");
  if (b instanceof HTMLElement) b.focus({ preventScroll: true });
}

// The view checks map input to the question on screen. core.ts ignores an answer once the question has one.
function pick(o: Code) {
  if (!sess || sess.view !== "mc") return;
  const r = sess.core.answer({ pick: o }, { ms: performance.now() - sess.t0 }),
    it = sess.core.current();
  if (!r || !it) return;
  const c = it.c;
  $$("#stage .choice", HTMLButtonElement).forEach((b) => {
    b.disabled = true;
    if (b.dataset.pick === c) b.classList.add("right");
    else if (b.dataset.pick === o) b.classList.add("wrong");
  });
  afterAnswer(sess, c, r);
}
function submitTyped() {
  if (!sess || sess.view !== "typed") return;
  const inp = $("#answer", HTMLInputElement);
  const val = inp.value;
  const r = sess.core.answer(
    { typed: val },
    { ms: performance.now() - sess.t0, firstKeyMs: sess.firstKey },
  );
  const it = sess.core.current();
  if (!r || !it) return;
  if (r.verdict === "empty") {
    renderAsk(sess, true);
    return;
  }
  if (r.verdict === "ambiguous") {
    // As close to another country as to the right one: ask again instead of guessing which was meant.
    const note = $("#typedNote");
    note.textContent = "That’s close to more than one country. Check the spelling.";
    note.classList.remove("hidden");
    fitFlag();
    inp.select();
    return;
  }
  inp.readOnly = true;
  inp.classList.add(r.verdict === "miss" ? "wrong" : "right");
  afterAnswer(sess, it.c, r, val);
}
function dunno() {
  if (!sess) return;
  const r = sess.core.answer({ dunno: true }),
    it = sess.core.current();
  if (!r || !it) return;
  afterAnswer(sess, it.c, r);
}
// Shows the verdict and moves on, or shows the miss screen. typed: the typed answer, if any.
function afterAnswer(s: OnScreen, c: Code, r: AnswerResult, typed?: string) {
  if (r.verdict !== "miss") {
    // "hinted": a right pick after "Show choices". Shown as right, but it counts as a miss everywhere else.
    const hinted = r.verdict === "hinted",
      typo = r.verdict === "typo";
    const v = document.createElement("p");
    v.className = hinted ? "verdict" : "verdict good";
    v.textContent = hinted
      ? "Right, but using choices counts as a miss. It’ll come back."
      : typo
        ? `Correct. It’s spelled ${BY[c].n}.`
        : `${BY[c].n}`;
    $("#stage").appendChild(v);
    s.view = "done-good";
    s.timer = setTimeout(() => next(), hinted ? 2000 : typo ? 1500 : 650);
  } else {
    s.timer = setTimeout(() => showMiss(c, r, typed), s.view === "mc" ? 450 : 350);
  }
}
function showMiss(c: Code, r: AnswerResult, typed?: string) {
  if (!sess) return;
  sess.view = "miss";
  sess.missAt = performance.now();
  const ans = BY[c];
  let body: string;
  if (r.guess) {
    const gs = BY[r.guess];
    body = `
      ${r.quick ? `<p class="tag quick">That was a fast answer. Look at what sets them apart.</p>` : ""}
      <div class="compare">
        <div class="side guess"><p class="who">You said</p><div class="mast small">${img(r.guess, "Flag of " + gs.n)}</div><p class="nm">${esc(gs.n)}</p><p class="tl">${esc(gs.h)}</p></div>
        <div class="side answer"><p class="who">It’s</p><div class="mast small">${img(c, "Flag of " + ans.n)}</div><p class="nm">${esc(ans.n)}</p><p class="tl">${esc(ans.h)}</p></div>
      </div>`;
  } else {
    body = `
      ${typed ? `<p class="tag">“${esc(typed)}” didn’t match a country.</p>` : ""}
      <div class="mast">${img(c, "Flag of " + ans.n)}</div>
      <h2 class="name" style="color:var(--good)">${esc(ans.n)}</h2>
      <p class="hook">${esc(ans.h)}</p>
      ${alikesHTML(lookalikes(c, 4))}`;
  }
  $("#stage").innerHTML =
    body +
    `<button class="btn btn-primary" type="button" data-act="next">Continue<span class="kbd">Enter</span></button>`;
  focusMain();
}

/* ---------- Summary ---------- */
// s: the summary from the session's end() in core.ts.
function showSummary(s: Summary) {
  const el = $("#summary");
  const list = s.mixups.slice(0, 6);
  const lead =
    `${s.total} ${s.total === 1 ? "flag" : "flags"}, <strong>${s.right} right on the first try</strong>.` +
    (s.mode === "extra" ? " Extra practice doesn’t change your review schedule." : "");
  let again = "";
  if (s.mode === "extra") {
    // endSession has just set run to the run after this round.
    if (!run) throw new Error("Extra practice ended without its run");
    again = `<button class="btn btn-quiet" type="button" data-act="another">${run.n === Infinity ? `All ${practiced().length} again` : `Another ${run.n}`}</button>`;
  }
  el.className = "summary";
  el.innerHTML = `
    <h2>${s.mode === "extra" ? "Practice done" : "Session done"}</h2>
    <p class="lead">${lead}</p>
    ${
      list.length
        ? `<div class="mixups"><p class="note">Mixed up today</p>${list
            .map(
              ([a, b]) =>
                `<div class="mixup">${img(a, "")}<span><strong>${esc(BY[a].n)}</strong></span><span class="vs">mistaken for</span>${img(b, "")}<span>${esc(BY[b].n)}</span></div>`,
            )
            .join("")}</div>`
        : ""
    }
    <div class="actions"><button class="btn btn-primary" type="button" data-act="home">Back to my flags<span class="kbd">Enter</span></button>${again}</div>`;
  el.classList.remove("hidden");
  $("[data-act=home]", HTMLElement, el).focus({ preventScroll: true });
}

/* ---------- Settings ---------- */
// A row of radio buttons styled as a segmented control. options: [[value, label], ...]
function segHTML(
  name: string,
  options: readonly (readonly [string | number, string | number])[],
  current: string | number,
) {
  return options
    .map(
      ([value, label]) =>
        `<label><input type="radio" name="${name}" value="${value}" ${String(current) === String(value) ? "checked" : ""}><span>${label}</span></label>`,
    )
    .join("");
}
function renderSettings() {
  $("#perDay").innerHTML = segHTML(
    "perDay",
    [5, 10, 15, 20].map((n) => [n, n]),
    S.settings.perDay,
  );
  $("#theme").innerHTML = segHTML(
    "theme",
    [
      ["system", "System"],
      ["light", "Light"],
      ["dark", "Dark"],
    ],
    S.settings.theme,
  );
  $("#kosovo", HTMLInputElement).checked = !!S.settings.kosovo;
  const rb = $("#resetBtn");
  rb.textContent = "Reset all progress";
  rb.dataset.armed = "";
}
// The theme buttons' values are themes, but the DOM types a value as any string.
const isTheme = (v: string): v is Theme => v === "system" || v === "light" || v === "dark";
function applyTheme() {
  const t = S.settings.theme;
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  else document.documentElement.removeAttribute("data-theme");
}

/* ---------- Events ---------- */
document.addEventListener("click", (e) => {
  const t =
    e.target instanceof Element
      ? e.target.closest("[data-act],[data-pick],[data-show],[data-close]")
      : null;
  if (!(t instanceof HTMLElement)) return;
  if (t.dataset.pick) return pick(t.dataset.pick);
  if (t.dataset.show) return showDetail(t.dataset.show);
  if (t.hasAttribute("data-close")) return $("#detail", HTMLDialogElement).close();
  const a = t.dataset.act;
  if (a === "start") startSession("normal");
  else if (a === "more") startSession("more");
  else if (a === "extra") {
    run = {
      n: t.dataset.n === "all" ? Infinity : Number(t.dataset.n),
      skip: new Set(),
      last: new Set(),
    };
    startSession("extra");
  } else if (a === "another") startSession("extra");
  else if (a === "next") {
    if (sess) {
      clearTimeout(sess.timer);
      next();
    }
  } else if (a === "hint") {
    if (sess) renderAsk(sess, true);
  } else if (a === "dunno") dunno();
  else if (a === "reload") location.reload();
  else if (a === "home") goHome();
});
function goHome() {
  $("#summary").classList.add("hidden");
  $("#home").classList.remove("hidden");
  renderHome();
  window.scrollTo(0, 0);
}
document.addEventListener("submit", (e) => {
  if (e.target instanceof Element && e.target.id === "typedForm") {
    e.preventDefault();
    submitTyped();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if ($("#detail", HTMLDialogElement).open || $("#settings", HTMLDialogElement).open) return;
  if (sess) {
    if (sess.view === "mc" && /^[1-4]$/.test(e.key)) {
      const o = sess.opts[+e.key - 1];
      if (o) {
        e.preventDefault();
        pick(o);
      }
      return;
    }
    if (sess.view === "typed" && e.key === "Escape") {
      e.preventDefault();
      dunno();
      return;
    }
    if (
      (e.key === "Enter" || e.key === " ") &&
      (sess.view === "miss" || sess.view === "done-good" || sess.view === "intro")
    ) {
      if (sess.view === "miss" && performance.now() - sess.missAt < 300) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      clearTimeout(sess.timer);
      next();
      return;
    }
    if (e.key === "Escape" && sess.view !== "typed") {
      e.preventDefault();
      endSession();
    }
    return;
  }
  // Enter goes home from the summary unless a button has focus: then Enter presses that button, as usual.
  if (
    e.key === "Enter" &&
    !$("#summary").classList.contains("hidden") &&
    document.activeElement === document.body
  ) {
    e.preventDefault();
    $("#summary [data-act=home]").click();
    return;
  }
  if (
    e.key === "Enter" &&
    !$("#home").classList.contains("hidden") &&
    document.activeElement === document.body
  ) {
    const b = document.querySelector("#actions .btn-primary");
    if (b instanceof HTMLElement) {
      e.preventDefault();
      b.click();
    }
  }
});
$("#endSession").addEventListener("click", endSession);
$("#openSettings").addEventListener("click", () => {
  renderSettings();
  $("#settings", HTMLDialogElement).showModal();
});
$("#settingsForm").addEventListener("change", (e) => {
  if (e.target instanceof HTMLInputElement) {
    if (e.target.name === "perDay") setSetting("perDay", +e.target.value);
    if (e.target.name === "theme" && isTheme(e.target.value)) {
      setSetting("theme", e.target.value);
      applyTheme();
    }
    if (e.target.id === "kosovo") setSetting("kosovo", e.target.checked);
  }
  renderHome();
});
$("#resetBtn").addEventListener("click", (e) => {
  const b = e.currentTarget;
  if (!(b instanceof HTMLElement)) return;
  if (!b.dataset.armed) {
    b.dataset.armed = "1";
    b.textContent = "Click again to erase everything";
    return;
  }
  const keep = S.settings;
  S = blankState();
  S.settings = keep;
  save();
  $("#settings", HTMLDialogElement).close();
  renderHome();
});
$("#detail").addEventListener("click", (e) => {
  if (e.target === $("#detail")) $("#detail", HTMLDialogElement).close();
});
// Pick up progress saved by other tabs, so this page never writes an older copy over it.
// A hidden page only reloads the data; visibilitychange redraws it when it's shown again.
function refresh() {
  reload();
  applyTheme();
  if (!document.hidden && !sess && !$("#home").classList.contains("hidden")) renderHome();
}
window.addEventListener("storage", (e) => {
  if (e.key === KEY || e.key === null) refresh();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});

/* ---------- Phones: the visible part of the screen ---------- */
// On phones the on-screen keyboard covers part of the page without resizing it. --vvh and --vvtop follow the
// part that's actually visible, so the session fits there (see .session in the CSS), and fitFlag() re-fits the
// question. Only #session reads them, so they're set there, and only when they change. While pinch-zoomed the
// last values are kept, so zooming in enlarges the screen as it is instead of reflowing it.
function trackVisibleArea() {
  const vv = window.visualViewport;
  if (!vv) return;
  const style = $("#session").style;
  let last = "";
  const update = () => {
    if (Math.abs(vv.scale - 1) > 0.01) return;
    const now = vv.height + "," + vv.offsetTop;
    if (now === last) return;
    last = now;
    style.setProperty("--vvh", vv.height + "px");
    style.setProperty("--vvtop", vv.offsetTop + "px");
    fitFlag();
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();
}

applyTheme();
trackVisibleArea();
buildWall();
document.querySelectorAll("#legend [data-sw]").forEach((el) => (el.innerHTML = img("mu", "")));
renderHome();
