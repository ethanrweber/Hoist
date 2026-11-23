// Builds index.html (one self-contained file) from src/template.html, the page script (src/page.ts, bundled with
// src/core.ts by esbuild), the country data and the flag SVGs.
// Usage: node src/build.ts
// test/structure.test.ts calls build() to check that the committed index.html is up to date.
// esbuild only strips the types: npm run typecheck checks them.
import fs from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import type { Code, Country, Neighbors } from "./core.ts";
import { COUNTRIES, FAMILIES } from "./countries.ts";
import neighborsJSON from "./neighbors.json" with { type: "json" };

const here = (...p: string[]) => path.join(import.meta.dirname, ...p);
const neighbors: Neighbors = neighborsJSON;

// Returns {html, problems}. If any country code is wrong, problems lists each one and there is no html.
export function build(): { html: string | null; problems: string[] } {
  // Every code must name a real country, so a typo fails the build instead of being silently ignored by the app.
  const problems: string[] = [];
  const codes = new Set<Code>();
  for (const c of COUNTRIES) {
    if (codes.has(c.c)) problems.push(`countries.ts lists "${c.c}" twice`);
    codes.add(c.c);
    if (!fs.existsSync(here("flags", `${c.c}.svg`)))
      problems.push(`src/flags/${c.c}.svg is missing`);
    if (!Array.isArray(neighbors[c.c])) problems.push(`neighbors.json has no list for "${c.c}"`);
  }
  const familyOf: Record<Code, number> = {};
  FAMILIES.forEach((f, i) =>
    f.forEach((c) => {
      if (!codes.has(c)) problems.push(`FAMILIES[${i}] has unknown code "${c}"`);
      if (c in familyOf)
        problems.push(`"${c}" is in both FAMILIES[${familyOf[c]}] and FAMILIES[${i}]`);
      familyOf[c] = i;
    }),
  );
  for (const [c, list] of Object.entries(neighbors)) {
    if (!codes.has(c)) problems.push(`neighbors.json has unknown country "${c}"`);
    // TypeScript checks neighbors.json's shape, but the build runs without that check: something other than a list
    // is skipped here (and reported above, if it's a country's).
    const listed: readonly Code[] = Array.isArray(list) ? list : [];
    for (const x of listed)
      if (!codes.has(x)) problems.push(`neighbors.json["${c}"] has unknown code "${x}"`);
  }
  if (problems.length) return { html: null, problems };

  const curly = (s: string) => s.replace(/'/g, "’");
  const countries = COUNTRIES.map((c) => {
    const o: Country = { c: c.c, n: curly(c.n), r: c.r, h: curly(c.h) };
    if (c.a) o.a = c.a;
    if (c.optional) o.optional = true;
    return o;
  });

  const flags: Record<Code, string> = {};
  for (const c of COUNTRIES) {
    let svg = fs.readFileSync(here("flags", `${c.c}.svg`), "utf8").trim();
    const m = svg.match(/viewBox="([-\d.]+)[ ,]+([-\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)"/);
    if (!m) throw new Error("No viewBox in " + c.c + ".svg");
    const H = 400,
      W = Math.round((H * +m[3]) / +m[4]);
    // Give the root <svg> fixed pixel dimensions so the browser knows each flag's shape.
    svg = svg.replace(/<svg\b[^>]*>/, (tag) =>
      tag
        .replace(/\s(width|height|preserveAspectRatio)="[^"]*"/g, "")
        .replace(/^<svg\b/, `<svg width="${W}" height="${H}" preserveAspectRatio="xMidYMid meet"`),
    );
    flags[c.c] = svg;
  }

  // The data, as the globals that page.ts declares. It's all JSON, so escaping "</script" inside it can't change
  // its meaning.
  const data = (
    `const COUNTRIES=${JSON.stringify(countries)};\n` +
    `const FAMILIES=${JSON.stringify(FAMILIES)};\n` +
    `const NEIGHBORS=${JSON.stringify(neighbors)};\n` +
    `const FLAGS=${JSON.stringify(flags)};`
  ).replace(/<\/script/gi, "<\\/script");
  // The page script and core.ts as one classic script, unminified. ES modules are strict, but a script esbuild makes
  // from them isn't unless it says so.
  const page = buildSync({
    entryPoints: [here("page.ts")],
    bundle: true,
    format: "iife",
    charset: "utf8",
    banner: { js: '"use strict";' },
    write: false,
  }).outputFiles[0].text;
  if (/<\/script/i.test(page))
    throw new Error('The page script must not contain "</script" (it would end the inline script)');

  const html = fs
    .readFileSync(here("template.html"), "utf8")
    .replace("/*__DATA__*/", () => data)
    .replace("/*__PAGE__*/", () => page);
  return { html, problems };
}

// What to show when build() finds problems. The test of the build shows the same message.
export function problemsMessage(problems: string[]): string {
  return "Build stopped. Fix these in src/:\n  " + problems.join("\n  ");
}

if (import.meta.main) {
  const { html, problems } = build();
  if (html === null) {
    console.error(problemsMessage(problems));
    process.exit(1);
  }
  fs.writeFileSync(here("..", "index.html"), html);
  console.log(
    `Wrote index.html (${(html.length / 1048576).toFixed(2)} MB, ${COUNTRIES.length} flags)`,
  );
}
