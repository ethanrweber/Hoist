// Builds index.html (one self-contained file) from src/template.html, src/core.js, the country data and the flag SVGs.
// Usage: node src/build.js
const fs = require("fs");
const path = require("path");
const here = (...p) => path.join(__dirname, ...p);
const { COUNTRIES, FAMILIES } = require("./countries.js");
const neighbors = JSON.parse(fs.readFileSync(here("neighbors.json"), "utf8"));

// Every code must name a real country, so a typo fails the build instead of being silently ignored by the app.
const problems = [];
const codes = new Set();
for (const c of COUNTRIES) {
  if (codes.has(c.c)) problems.push(`countries.js lists "${c.c}" twice`);
  codes.add(c.c);
  if (!fs.existsSync(here("flags", `${c.c}.svg`))) problems.push(`src/flags/${c.c}.svg is missing`);
  if (!Array.isArray(neighbors[c.c])) problems.push(`neighbors.json has no list for "${c.c}"`);
}
const familyOf = {};
FAMILIES.forEach((f, i) => f.forEach(c => {
  if (!codes.has(c)) problems.push(`FAMILIES[${i}] has unknown code "${c}"`);
  if (c in familyOf) problems.push(`"${c}" is in both FAMILIES[${familyOf[c]}] and FAMILIES[${i}]`);
  familyOf[c] = i;
}));
for (const [c, list] of Object.entries(neighbors)) {
  if (!codes.has(c)) problems.push(`neighbors.json has unknown country "${c}"`);
  for (const x of Array.isArray(list) ? list : []) if (!codes.has(x)) problems.push(`neighbors.json["${c}"] has unknown code "${x}"`);
}
if (problems.length) {
  console.error("Build stopped. Fix these in src/:\n  " + problems.join("\n  "));
  process.exit(1);
}

const curly = s => s.replace(/'/g, "’");
const countries = COUNTRIES.map(c => {
  const o = { c: c.c, n: curly(c.n), r: c.r, h: curly(c.h) };
  if (c.a) o.a = c.a;
  if (c.optional) o.optional = true;
  return o;
});

const flags = {};
for (const c of COUNTRIES) {
  let svg = fs.readFileSync(here("flags", `${c.c}.svg`), "utf8").trim();
  const m = svg.match(/viewBox="([-\d.]+)[ ,]+([-\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)"/);
  if (!m) throw new Error("No viewBox in " + c.c + ".svg");
  const H = 400, W = Math.round(H * (+m[3]) / (+m[4]));
  // Give the root <svg> fixed pixel dimensions so the browser knows each flag's shape.
  svg = svg.replace(/<svg\b[^>]*>/, tag =>
    tag.replace(/\s(width|height|preserveAspectRatio)="[^"]*"/g, "")
       .replace(/^<svg\b/, `<svg width="${W}" height="${H}" preserveAspectRatio="xMidYMid meet"`));
  flags[c.c] = svg;
}

// The data is all JSON, so escaping "</script" inside it can't change its meaning.
const data = (
  `const COUNTRIES=${JSON.stringify(countries)};\n` +
  `const FAMILIES=${JSON.stringify(FAMILIES)};\n` +
  `const NEIGHBORS=${JSON.stringify(neighbors)};\n` +
  `const FLAGS=${JSON.stringify(flags)};`
).replace(/<\/script/gi, "<\\/script");
const core = fs.readFileSync(here("core.js"), "utf8");
if (/<\/script/i.test(core)) throw new Error('core.js must not contain "</script" (it would end the inline script)');

const html = fs.readFileSync(here("template.html"), "utf8")
  .replace("/*__DATA__*/", () => data)
  .replace("/*__CORE__*/", () => core);
fs.writeFileSync(path.join(__dirname, "..", "index.html"), html);
console.log(`Wrote index.html (${(html.length / 1048576).toFixed(2)} MB, ${COUNTRIES.length} flags)`);
