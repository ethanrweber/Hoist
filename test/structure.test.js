// Checks on the source files themselves, for rules that are easy to miss when editing src/. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { build, problemsMessage } = require("../src/build.js");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

/* ---------- The build ---------- */
test("build: every country code checks out, and index.html is built from the current src/", () => {
  const { html, problems } = build();
  assert.deepEqual(problems, [], problemsMessage(problems));
  assert.ok(html === read("index.html"), "index.html is out of date: run npm run build");
});

/* ---------- Buttons ---------- */
test("template.html: every data-act button has a branch in the click handler, and every branch has a button", () => {
  const src = read("src/template.html");
  // The handler ends at the first "});" indented as deep as the line it starts on.
  const start = src.indexOf('document.addEventListener("click"');
  const indent = src.slice(src.lastIndexOf("\n", start) + 1, start);
  const end = src.indexOf("\n" + indent + "});", start);
  assert.ok(
    start >= 0 && end > start,
    'Can\'t find the click handler, document.addEventListener("click", ...), in src/template.html',
  );
  const branches = new Set(
    [...src.slice(start, end).matchAll(/\ba === "([^"]*)"/g)].map((m) => m[1]),
  );
  // data-act on <button> tags only, in the markup and in the script's template strings. A selector like
  // '[data-act="home"]' finds a button rather than makes one.
  const tags = [...src.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
  const acts = new Set(
    tags.flatMap((tag) => [...tag.matchAll(/\sdata-act="([^"]*)"/g)].map((m) => m[1])),
  );
  const found = [
    ...[...acts]
      .filter((a) => !branches.has(a))
      .map((a) => `data-act="${a}" has no a === "${a}" branch in the click handler`),
    ...[...branches]
      .filter((a) => !acts.has(a))
      .map((a) => `a === "${a}" in the click handler has no button with data-act="${a}"`),
  ];
  assert.deepEqual(
    found,
    [],
    "Buttons and the click handler in src/template.html don't match. " +
      "Add the missing branch or button, or remove the one left over:\n  " +
      found.join("\n  "),
  );
});
