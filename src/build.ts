// Builds index.html (one self-contained file) from src/template.html and the page script: src/page.ts bundled by
// esbuild with what it imports (src/core.ts, the country data, and the flag SVGs, as the module hoist:flags).
// Usage: node src/build.ts
// test/structure.test.ts calls build() to check that the committed index.html is up to date.
// esbuild only strips the types: npm run typecheck checks them.
import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import type { Code, Neighbors } from "./core.ts";
import { COUNTRIES, FAMILIES } from "./countries.ts";
import neighborsJSON from "./neighbors.json" with { type: "json" };

const here = (...p: string[]) => path.join(import.meta.dirname, ...p);
const neighbors: Neighbors = neighborsJSON;

// Resolves `import FLAGS from "hoist:flags"` in page.ts to a module made from `flags`, each flag's SVG by code.
// Its type is in hoist-flags.d.ts.
function flagsModule(flags: Record<Code, string>): esbuild.Plugin {
  return {
    name: "hoist-flags",
    setup(b) {
      b.onResolve({ filter: /^hoist:flags$/ }, () => ({ path: "flags", namespace: "hoist" }));
      b.onLoad({ filter: /^flags$/, namespace: "hoist" }, () => ({
        contents: `export default ${JSON.stringify(flags)};`,
        loader: "js",
      }));
    },
  };
}

// Resolves to {html, problems}. If any country code is wrong, problems lists each one and there is no html.
export async function build(): Promise<{ html: string | null; problems: string[] }> {
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

  // The page script with everything it imports, as one classic script, unminified. ES modules are strict, but a
  // script esbuild makes from them isn't unless it says so. absWorkingDir fixes the paths esbuild writes in its
  // comments ("// src/core.ts"), so the output is the same from any working directory.
  const result = await esbuild.build({
    entryPoints: [here("page.ts")],
    absWorkingDir: here(".."),
    bundle: true,
    format: "iife",
    charset: "utf8",
    banner: { js: '"use strict";' },
    plugins: [flagsModule(flags)],
    write: false,
  });
  const page = result.outputFiles[0].text;
  // The whole script, data and flags included. esbuild escapes "</script" in what it writes; this checks that it did.
  if (/<\/script/i.test(page))
    throw new Error('The page script must not contain "</script" (it would end the inline script)');

  const html = fs.readFileSync(here("template.html"), "utf8").replace("/*__PAGE__*/", () => page);
  return { html, problems };
}

// What to show when build() finds problems. The test of the build shows the same message.
export function problemsMessage(problems: string[]): string {
  return "Build stopped. Fix these in src/:\n  " + problems.join("\n  ");
}

if (import.meta.main) {
  const { html, problems } = await build();
  if (html === null) {
    console.error(problemsMessage(problems));
    process.exit(1);
  }
  fs.writeFileSync(here("..", "index.html"), html);
  console.log(
    `Wrote index.html (${(html.length / 1048576).toFixed(2)} MB, ${COUNTRIES.length} flags)`,
  );
}
