// Checks on the source files themselves, for rules that are easy to miss when editing src/. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { build } = require("../src/build.js");

const root = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(root, f), "utf8");

/* ---------- The build ---------- */
test("build: every country code checks out, and index.html is built from the current src/", () => {
  const { html, problems } = build();
  assert.deepEqual(problems, [], "Build stopped. Fix these in src/:\n  " + problems.join("\n  "));
  assert.ok(html === read("index.html"), "index.html is out of date: run npm run build");
});

/* ---------- core.js ---------- */
// Page and environment globals. The page and the tests hand core.js its state, clock and randomness through env.
const ENV_GLOBALS = [/\bdocument\b/, /\bwindow\b/, /\blocalStorage\b/, /\bsessionStorage\b/, /\bperformance\b/,
  /\bset(Timeout|Interval)\b/, /\bDate\.now\b/, /\bMath\.random\b/, /\bnew Date\(\s*\)/];

test("core.js: no page code, and the clock and randomness come only through env", () => {
  // Comments are blanked out, keeping their line breaks, so they can mention these freely.
  const code = read("src/core.js")
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
    .replace(/\/\/.*/g, "")
    // The defaults createCore falls back to when env leaves them out.
    .replace("env.now || Date.now", "").replace("env.random || Math.random", "");
  const found = [];
  code.split("\n").forEach((line, i) => {
    for (const re of ENV_GLOBALS) if (re.test(line)) found.push(`line ${i + 1}: ${line.match(re)[0]}`);
  });
  assert.deepEqual(found, [], "src/core.js must not use page or environment globals. It must receive these through env "
    + "(state, now, random) in createCore, so the page and the tests control them. Found:\n  " + found.join("\n  "));
});

/* ---------- Accents ---------- */
test("source files: no literal combining accent marks", () => {
  const js = dir => fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith(".js")).map(f => `${dir}/${f}`);
  const files = js("src").concat("src/template.html", js("test"));
  const found = [];
  for (const f of files) read(f).split("\n").forEach((line, i) => {
    for (const ch of line.match(/[\u0300-\u036f]/g) || []) found.push(`${f} line ${i + 1}: U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
  });
  assert.deepEqual(found, [], "Write combining accent marks as escapes (like \\u0301), not as the characters themselves. "
    + "Editors and copy-paste can merge or drop them without showing it, which once broke accent stripping in norm(). Found:\n  "
    + found.join("\n  "));
});

/* ---------- Buttons ---------- */
test("template.html: every data-act button has a branch in the click handler, and every branch has a button", () => {
  const src = read("src/template.html");
  const start = src.indexOf('document.addEventListener("click"'), end = src.indexOf("\n});", start);
  assert.ok(start >= 0 && end > start, 'Can\'t find the click handler, document.addEventListener("click", ...), in src/template.html');
  const branches = new Set([...src.slice(start, end).matchAll(/\ba === "([^"]*)"/g)].map(m => m[1]));
  // Attribute values only: selectors like [data-act=next] find buttons rather than make them.
  const acts = new Set([...src.matchAll(/\bdata-act="([^"]*)"/g)].map(m => m[1]));
  const found = [
    ...[...acts].filter(a => !branches.has(a)).map(a => `data-act="${a}" has no a === "${a}" branch in the click handler`),
    ...[...branches].filter(a => !acts.has(a)).map(a => `a === "${a}" in the click handler has no button with data-act="${a}"`),
  ];
  assert.deepEqual(found, [], "Buttons and the click handler in src/template.html don't match. "
    + "Add the missing branch or button, or remove the one left over:\n  " + found.join("\n  "));
});
