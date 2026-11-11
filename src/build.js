// Builds index.html (one self-contained file) from src/template.html, the country data and the flag SVGs.
// Usage: node src/build.js
const fs = require("fs");
const path = require("path");
const here = (...p) => path.join(__dirname, ...p);
const { COUNTRIES, FAMILIES } = require("./countries.js");

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

const neighbors = JSON.parse(fs.readFileSync(here("neighbors.json"), "utf8"));
const data =
  `const COUNTRIES=${JSON.stringify(countries)};\n` +
  `const FAMILIES=${JSON.stringify(FAMILIES)};\n` +
  `const NEIGHBORS=${JSON.stringify(neighbors)};\n` +
  `const FLAGS=${JSON.stringify(flags).replace(/<\/script/gi, "<\\/script")};`;

const html = fs.readFileSync(here("template.html"), "utf8").replace("/*__DATA__*/", () => data);
fs.writeFileSync(path.join(__dirname, "..", "index.html"), html);
console.log(`Wrote index.html (${(html.length / 1048576).toFixed(2)} MB, ${COUNTRIES.length} flags)`);
