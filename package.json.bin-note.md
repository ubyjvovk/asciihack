# package.json — proposed `bin` entry (for the PM to apply)

The ssh login wrapper calls `node dist/cli.js` by absolute path, so a `bin`
entry is **not required** for serving. It is purely a convenience so operators
can run the built client directly from a checkout.

If the PM wants to add it, apply this exact block to `package.json`:

```json
  "bin": {
    "asciihack": "dist/cli.js"
  },
```

Notes for the PM:

- `dist/cli.js` already has a shebang-agnostic `main()` guard
  (`process.argv[1] === import.meta.url`), but as written it is **not**
  executable on its own: it has no `#!/usr/bin/env node` shebang and `npm`
  does not add one unless `dist/cli.js` carries one at build time.
- To make the bin actually executable, either (a) add `#!/usr/bin/env node`
  as the first line of `src/cli.ts` (build preserves it via `tsc`), or (b)
  skip the bin entirely and keep the login wrapper's direct `node
  dist/cli.js` call, which is what T-0014 ships.
- Because this is optional and touches PM-owned `package.json` (+ lockfile if
  the bin is made executable via a wrapper), T-0014 did **not** add it; the
  login wrapper works without it. Recommend skipping the bin.
