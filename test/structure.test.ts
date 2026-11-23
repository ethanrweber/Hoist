// Checks on the source files themselves, for rules that are easy to miss when editing src/. Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, problemsMessage } from "../src/build.ts";
import { COUNTRIES } from "../src/countries.ts";

const root = path.join(import.meta.dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");

/* ---------- The build ---------- */
test("build: every country code checks out, and index.html is built from the current src/", async () => {
  const { html, problems } = await build();
  assert.deepEqual(problems, [], problemsMessage(problems));
  assert.ok(html === read("index.html"), "index.html is out of date: run npm run build");
});

test("build: gives the same index.html from any working directory", async () => {
  const { html } = await build();
  // In a new Node process started in an empty folder: esbuild takes its default working directory from
  // process.cwd() when it loads, so changing folders in this process wouldn't change what it does.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "hoist-build-"));
  let there: string;
  try {
    const script =
      `import { build } from ${JSON.stringify(pathToFileURL(path.join(root, "src", "build.ts")).href)};\n` +
      'process.stdout.write((await build()).html ?? "");';
    there = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: elsewhere,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    fs.rmSync(elsewhere, { recursive: true });
  }
  assert.ok(
    html !== null && there === html,
    "build() gives a different index.html when run from another folder, so npm run build and this test's " +
      "up-to-date check depend on where they're run. Give every esbuild call in src/build.ts " +
      "absWorkingDir (the repo root), so the paths it writes don't depend on the working directory.",
  );
});

/* ---------- The data ---------- */
test("countries.ts: names and hooks use curly apostrophes", () => {
  const straight = COUNTRIES.flatMap((c) =>
    [c.n, c.h].filter((s) => s.includes("'")).map((s) => `${c.c}: ${s}`),
  );
  assert.deepEqual(
    straight,
    [],
    "The page shows names (n) and hooks (h) as they are in src/countries.ts. Use a curly apostrophe (’) " +
      "instead of ' in these. Alternate names (a) are only for checking typed answers, which treats both the same.",
  );
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
