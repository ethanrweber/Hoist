# Hoist

Learn all 196 flags of the world in a few minutes a day.

Hoist is a single-page flag trainer built on how memory actually works:

- **Spaced repetition.** Each flag has its own review schedule (the FSRS algorithm), so it comes back right before you'd forget it.
- **Look-alikes together.** Similar flags (Chad and Romania, Indonesia and Monaco, the Nordic crosses) are introduced side by side and used as each other's wrong answers.
- **Recognition first, then recall.** A flag starts as multiple choice and moves to typing the name once you know it.
- **Mistakes shown side by side.** A wrong answer shows the flag you picked next to the right one, with what sets them apart.

## Playing

Open the site and press **Start session**. On a keyboard: `1`–`4` pick a choice, `Enter` checks a typed answer (or shows choices if the box is empty), and `Esc` means "I don't know" when typing a name. Anywhere else in a session, `Esc` ends the session.

Progress is saved in your browser, so each browser or device keeps its own progress.

## Editing

Everything ships as one file, `index.html`. To change it, edit the sources, which are TypeScript, and rebuild:

- `src/countries.ts` has each country's name, accepted alternate names, region and one-line description, plus the look-alike families. Names and descriptions appear on the page as written, so they use curly apostrophes (’).
- `src/core.ts` holds the rules: scheduling, which flags are new each day, building and running a session (what each answer means, how it's graded, when a missed flag comes back), checking typed answers, settings, and upgrading saved progress. It has no page code, so it can be tested in Node. It also defines the types the other files share, such as `State` (saved progress), `Country` and `Session`.
- `src/page.ts` is the page's script: it draws screens, turns clicks and keys into answers for `core.ts`, and saves progress in the browser.
- `src/template.html` is the page's HTML and CSS.
- `src/build.ts` builds `index.html`: it bundles `page.ts` with everything it imports into one script with esbuild, and puts it in `template.html`. The page imports the rules from `core.ts` and the data from `countries.ts` and `neighbors.json`, and the flags from `hoist:flags`, a module the build makes from `src/flags/` (its type is in `src/hoist-flags.d.ts`). So the data is type-checked where the page uses it.
- `src/flags/` holds the flag SVGs. `src/neighbors.json` lists the most similar-looking flags for each one, used as extra wrong answers.

You need Node.js 24.2 or later, which runs TypeScript files directly. Install the development tools once with `npm install`, then:

```
npm run build      # rebuild index.html
npm run format     # format the code with Prettier
npm run typecheck  # check the types
npm test           # run the tests
npm run check      # check formatting and types, then run the tests
```

The build rewrites `index.html`, and stops with a list of problems if any country code in `countries.ts` or `neighbors.json` doesn't match a country or a flag file. It doesn't check types (esbuild just removes them), so run `npm run check` too. The tests fail if `index.html` is out of date, so rebuild before checking. The site itself has no dependencies: `index.html` is the whole thing.

Each part is type-checked with only the globals it can use where it runs: `core.ts` and `countries.ts` with none at all (`tsconfig.core.json`), `page.ts` with the browser's (`tsconfig.page.json`), and the build and the tests with Node's (`tsconfig.node.json`). So `core.ts` can't use `document`, `localStorage` or `process`, say: the page passes in what the rules need.

If you change what gets saved in the browser, raise `VERSION` in `src/core.ts` and add an upgrade step to `UPGRADES`, so existing players' progress carries over.

## Credits

Flag artwork comes from [hampusborgos/country-flags](https://github.com/hampusborgos/country-flags), sourced from Wikimedia Commons. Flags themselves are in the public domain. Text is set in [Archivo](https://fonts.google.com/specimen/Archivo) from Google Fonts.
