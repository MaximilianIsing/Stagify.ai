# instagram/ — local post generator

**This is not runtime code and it is never served.** The Express app only ever mounts
`public/` (`lib/http/app-middleware.js`), so nothing in this folder is reachable over HTTP,
on Render or anywhere else. It is a local tool: open a Claude Code session *in this folder*
and ask for a post.

Do not delete anything here as "unused." A grep for usages returns nothing **by design** —
the server never imports this folder. Same rule as `to-build/`.

## What it does

Generates a complete, ready-to-upload Instagram post: the images, the caption, the hashtags
and the alt text. It does **not** publish. You review the folder and upload by hand.

The point of it living inside the repo is that it can drive the real product
(`processStaging`) and inherit the real design tokens and fonts from `public/styles/`, so a
post is made of genuine Stagify output styled like the actual site rather than a lookalike.

## How to use it

Open a session in `instagram/` and say "make me a post." The agent follows `PLAYBOOK.md`.

Reference by hand:

```
node instagram/bin/render.js --fixture instagram/fixtures/diagonal-reveal.json   # render a post record
node instagram/bin/check.js  <candidate.json>                            # uniqueness gate
node instagram/bin/metrics.js --post <id> --likes N --views N --saves N  # record performance
node --test "instagram/**/*.test.js"                                     # the tool's own tests
```

## Two rules that are enforced in code, not by asking nicely

1. **No em dashes.** `lib/validate/rules.js` scans the copy *and* the generated HTML before it
   ever reaches the renderer. U+2012, U+2013, U+2014, U+2015, U+2E3A, U+2E3B and a bare ` -- `
   all fail hard.
2. **Posts must not all look the same.** `lib/history/cooldown.js` blocks a candidate that
   reuses a template, layout family, hook, room, style, palette, audience, CTA or product
   feature inside its cooldown
   window, and a reviewer subagent compares the finished image against the last five thumbnails
   for the kind of sameness a counter cannot see.

`PLAYBOOK.md` carries thirteen more rules covering render quality, the run's process and the
poster design. Nothing enforces those, which is the whole reason they are written down.

## Deliberately outside the deploy gate

The `test/**/*.test.js` glob does not reach here, and `tsconfig.json` uses an explicit
include allowlist that omits it, so a bug in this tool cannot fail `npm test` or a Render
build (`scripts/build.sh` runs only `npm test`). It is linted, though: `eslint.config.js` has
a tooling block for `instagram/**/*.{js,mjs}` and stylelint covers its CSS, so `npm run lint`
in CI does see it. Otherwise it follows the repo's conventions: plain ESM, an import of the
repo-root `load-env.js` when secrets are needed, and its own tests run by hand.

## Layout

```
PLAYBOOK.md      the agent operating manual (the real instructions; CLAUDE.md just points here)
config.json      brand voice, CTA bank, hashtag pools, cooldown windows, feature catalog
history/         posts.jsonl (append-only record), metrics.jsonl, ledger.json (derived)
research/        cached trend research with TTLs
templates/       one directory per layout: meta.json + template.js + template.css
lib/             render, images, history, validate
bin/             the CLIs the agent drives
posts/           one directory per generated post, the hand-off
```

`CLAUDE.md` in this folder is tracked. It points at `PLAYBOOK.md` and restates the fifteen
hard rules at one line each, so a session starts with them in context. `PLAYBOOK.md` stays
the source of truth, so change a rule there first and keep the one-liner in step.
