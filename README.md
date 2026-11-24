# site-generator-speed-01-run-20261122 — v2

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/ryukaa853/site-generator-speed-01-run-20261122-v2/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/ryukaa853/site-generator-speed-01-run-20261122-v2/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0, written fresh from the competition
spec and the reference program's observable behaviour. `solve.js` exports
`run(input)`, which returns exactly the output tree makefun-site 1.0.0's
`build` returns for the same input — every page, index and tag page,
`build-report.txt` and static file, byte for byte. `main.ts` is the kit's
driver, kept verbatim.

## Run it

```sh
node main.ts
```

## Where the speed comes from

No behaviour change anywhere — only less work per case:

- **Markdown in one fused pass.** No lex token array and no per-character
  escape calls. Inline text is found with one native regex scan; runs of
  plain text are appended untouched, and a string with no markup or escapable
  character at all is returned as it stands. Strong/emphasis/link closers are
  found with `indexOf` jumps plus a backslash-parity check (a character is
  escaped exactly when the run of backslashes before it is odd), instead of a
  character-by-character scan.
- **Front matter scanned in place.** Only the short front-matter region is
  walked line by line; the body is a slice of the source, never a
  split-and-rejoin of the whole file.
- **Memoised slugs with an ASCII fast path.** NFKD is the identity on ASCII
  and ASCII carries no combining marks, so ASCII titles and tags skip the
  normalisation entirely. The memo is reset for every `run()`, so one case
  never influences another.
- **Word counting without allocation.** Reading time is counted with a
  character-code scan instead of building a match array.
- **Leaner template rendering.** One output array per render, joined once; a
  `for` loop reuses a single scope frame for all its elements (rendering is
  synchronous and depth-first, so the reuse is invisible); values that are
  already strings skip the `textOf` call. Each page's card is built once and
  reused by the page itself and by every list that shows it; link targets are
  resolved once per source and cached there.
- **No template compilation.** Compiling templates to functions was tried and
  measured: it was slower (the per-build compile cost beat the render saving),
  so this entry keeps the plain interpreter.

Deterministic: no clock, no randomness, no environment, no I/O. One case's
answer depends only on that case's input.

## Measured (this machine, Node 24, practice set, 3 cases)

- Correctness: **3/3 practice cases byte-identical** to the reference
  (grade-local: `cases_passed 3`, `passed 1`, L1 regrade reproduced byte for
  byte), plus **15/15 freshly drawn validation cases** (5 new generator seeds)
  byte-identical to the oracle.
- Speed, `run()` CPU only (the part the server heat measures net of its
  control): steady median **~200 ms** vs house baseline **~650 ms** — about
  **3.2x faster**. Full process (incl. the driver's JSON parse/stringify and
  Node startup, which are the same for every entry): median **~830 ms** vs
  baseline **~1,260 ms**.
- Determinism: repeated runs produce one identical `answers.json` hash.

## Files

- `solve.js` — the entry (dependency-free ES module).
- `main.ts` — the kit's driver, kept verbatim.
- `package.json` — `{"type": "module"}`.
- `README.md`, `LICENSE` — this file and the MIT licence.

<sub>Entered on [make.fun](https://make.fun/?ref=8tc4hwe6&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
