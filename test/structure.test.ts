// Checks on the source files themselves, for rules that are easy to miss when editing src/. Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { build, problemsMessage } from "../src/build.ts";

const root = path.join(import.meta.dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");

/* ---------- The build ---------- */
test("build: every country code checks out, and index.html is built from the current src/", () => {
  const { html, problems } = build();
  assert.deepEqual(problems, [], problemsMessage(problems));
  assert.ok(html === read("index.html"), "index.html is out of date: run npm run build");
});

/* ---------- Buttons ---------- */
test("page.ts and template.html: every data-act button has a branch in the click handler, and every branch has a button", () => {
  const page = read("src/page.ts");
  // The handler ends at the first "});" indented as deep as the line it starts on.
  const start = page.indexOf('document.addEventListener("click"');
  const indent = page.slice(page.lastIndexOf("\n", start) + 1, start);
  const end = page.indexOf("\n" + indent + "});", start);
  assert.ok(
    start >= 0 && end > start,
    'Can\'t find the click handler, document.addEventListener("click", ...), in src/page.ts',
  );
  const branches = new Set(
    [...page.slice(start, end).matchAll(/\ba === "([^"]*)"/g)].map((m) => m[1]),
  );
  // data-act on <button> tags only, in the markup (template.html) and in the script's template strings (page.ts).
  // A selector like '[data-act="home"]' finds a button rather than makes one.
  const tags = [page, read("src/template.html")].flatMap((src) =>
    [...src.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]),
  );
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
    "Buttons (in src/template.html and src/page.ts) and the click handler (in src/page.ts) don't match. " +
      "Add the missing branch or button, or remove the one left over:\n  " +
      found.join("\n  "),
  );
});
