# Hoist

Learn all 196 flags of the world in a few minutes a day.

Hoist is a single-page flag trainer built on how memory actually works:

- **Spaced repetition.** Each flag has its own review schedule (the FSRS algorithm), so it comes back right before you'd forget it.
- **Look-alikes together.** Similar flags (Chad and Romania, Indonesia and Monaco, the Nordic crosses) are introduced side by side and used as each other's wrong answers.
- **Recognition first, then recall.** A flag starts as multiple choice and moves to typing the name once you know it.
- **Mistakes shown side by side.** A wrong answer shows the flag you picked next to the right one, with what sets them apart.

## Playing

Open the site and press **Start session**. On a keyboard: `1`–`4` pick a choice, `Enter` checks a typed answer (or shows choices if the box is empty), and `Esc` means "I don't know."

Progress is saved in your browser, so each browser or device keeps its own progress.

## Editing

Everything ships as one file, `index.html`. To change it, edit the sources and rebuild:

- `src/countries.js` has each country's name, accepted alternate names, region and one-line description, plus the look-alike families.
- `src/core.js` holds the rules: scheduling, which flags are new each day, building a session, checking typed answers, and upgrading saved progress. It has no page code, so it can be tested in Node.
- `src/template.html` is the page: HTML, CSS, and the JavaScript that draws screens and handles input.
- `src/flags/` holds the flag SVGs. `src/neighbors.json` lists the most similar-looking flags for each one, used as extra wrong answers.

Then run:

```
npm run build   # or: node src/build.js
npm test        # or: node --test
```

Both need Node.js and nothing else. The build rewrites `index.html`, and stops with a list of problems if any country code in `countries.js` or `neighbors.json` doesn't match a country or a flag file.

If you change what gets saved in the browser, raise `VERSION` in `src/core.js` and add an upgrade step to `UPGRADES`, so existing players' progress carries over.

## Credits

Flag artwork comes from [hampusborgos/country-flags](https://github.com/hampusborgos/country-flags), sourced from Wikimedia Commons. Flags themselves are in the public domain. Text is set in [Archivo](https://fonts.google.com/specimen/Archivo) from Google Fonts.
