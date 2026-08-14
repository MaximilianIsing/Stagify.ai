# Instagram post playbook

You are running the post factory for **@stagify.ai**. Someone opened a session in
`instagram/` and asked for a post. This file is the whole procedure. Follow it in order.

Output is a folder they upload by hand. **You never publish anything.**

**Run every command in this file from the repo root.** The session opens in `instagram/` so
that this playbook loads, but the commands are written as `node instagram/bin/...`, so `cd ..`
first. The scripts themselves resolve the repo root internally and work from anywhere; it is
only the path you type that matters.

---

## The hard rules

### The two that code enforces

**1. Never use an em dash.** Not in the caption, not in on-image text, not anywhere. This
applies to en dashes too. Use a period, a comma or a colon.

This is enforced in code (`lib/validate/rules.js`), gated inside the renderer so no template
can bypass it, and the render will throw. Do not try to route around it. The account's own
post 07-27 shipped with "Coastal preset — staged in ~8 seconds" because a careful person
wrote it without noticing, which is exactly why the check exists.

**2. Posts must not all look the same.** Enforced by `bin/check.js` against the history
ledger. A candidate that reuses a template, **layout family**, hook, room, style, audience,
CTA or product feature inside its cooldown window is blocked outright, and near-duplicate
topics, headlines and visual descriptions are blocked by similarity.

Layout family is the coarse visual shape sitting one level above template, and it exists
because of a real miss: three consecutive posts divided the frame with a blue line under
three different template ids, so every other cooldown passed while the grid showed the same
post three times. `fullbleed` covers every split-frame reveal, so blocking it holds back
`diagonal-reveal` and `slider-hero` together. You never declare it on a candidate; it is
derived from the template you picked (`withLayoutFamily` in `lib/history/store.js`).

Both are gates, not preferences. If one fires, change the post, not the gate.

### The thirteen that only you enforce

Nothing below throws. That is exactly why they are written down: every one of them is a
rule you can break in a way that renders cleanly, exits zero and ships wrong.

**Quality**

**3. Never trade quality for a cheaper call.** `gemini-3.1-flash-image`, the full retry
loop, never `skipQualityReview`. The image is the product demo, so a weak render is worse
than no post.

**4. When `quality.perfect` is false, open the image yourself.** `processStaging` returns
its best attempt once it runs out of retries even when nothing passed review, so read the
file with Read and hand `quality.defects` to the image reviewer. Never ship on the score
alone.

**5. The "Virtually staged" disclosure never comes off.** It is already in the template
chrome (`_macros.js` `disclosure()` and `fieldFooter()`), and it is not layout you may
reclaim for copy.

**Process**

**6. Step 6 is the only checkpoint.** Do not build before the user approves, and do not
stop again after they do, with the single exception of the two-round cap in step 8.

**7. The devil's advocate and the image reviewer are separate subagents with fresh
context.** Never you: an author defends their own work, and a reviewer who has read the
caption confirms it instead of looking at the pixels.

**8. On-image text is plain Latin, digits and basic punctuation.** `public/fonts/` ships
Inter latin and latin-ext only, so an arrow, an emoji or a typographic symbol renders in a
fallback system face and looks subtly wrong. Caption emoji is fine; we never render the
caption.

**Design**

**9. Nothing may overlap, clip or run out of frame.** `html`, `body` and `.frame` all set
`overflow: hidden` and `.pill` and `.cta` set `white-space: nowrap`, so a headline one word
too long is silently cut off or pushed past the edge with no error and no failed request.
Every glyph in the finished image has to be fully visible with nothing sitting on top of
it, and the fix is shorter copy, not type shrunk below the template's scale.

**10. Type over a photo sits on a scrim.** Use `.card__scrim` or the template's own
`.scrim`. White text straight onto a photo reads fine in your head and disappears over a
bright window.

**11. The brand paints on three grounds and no others:** the deep blue, the pale wash, and
a photo. Anything else stops reading as Stagify.

**12. Colour comes from the tokens, never a hand-typed hex.** `brand-css.js` pulls the real
`:root` block out of `public/styles/styles.css` at render time, which is the only thing
stopping a post shipping in last quarter's blue.

**13. Use the shared chrome rather than restyling a lookalike.** `lockup()`, `eyebrow()`,
`cta()`, `disclosure()`, `headline()`, `photoCard()`, `fieldHeader()` and `fieldFooter()`
exist so ten layouts cannot drift into ten slightly different logo treatments.

**14. Respect the safe margins.** 52px gutters at 4:5; story and reel are 570px taller and
the platform draws its own UI top and bottom, so chrome moves inward there (`.frame--tall`
uses `top: 150px` and `bottom: 220px`) and the extra height goes to the photo, not the copy.

**15. One headline and one CTA per frame.** In a carousel only the last slide asks for the
click, because a CTA on every slide reads as an advert rather than a thought.

---

## The run

### 0. Metrics intake

Read the last 10 entries of `history/posts.jsonl` where `publishedAt` is set. For any with
no measurement in `history/metrics.jsonl` in the last 5 days, ask the user in **one**
message for likes, views, saves and comments.

Accept partial answers. Accept "skip". **Never invent a number** and never carry a stale
one forward as if it were fresh. Write what you get with `bin/metrics.js`.

### 1. See what is open

```
node instagram/bin/check.js --available
```

This prints, per dimension, what you may use today and what is on cooldown. Treat the open
list as your palette. Do not propose anything from the blocked list; it will be rejected in
step 4 and you will have wasted the round.

### 2. Research

```
node instagram/bin/research.js --plan
```

Prints which cache keys are stale. Most days this is zero or one, so research is fast.

For each stale key, spawn a **researcher subagent** with WebSearch:

> Research `<key>` for an Instagram account in the virtual staging and interior design
> niche. Return discrete claims, not prose. Every claim carries `sourceUrl`, `sourceTitle`
> and `retrievedAt`. Do not propose post ideas; that is a different role. Do not return a
> claim you cannot attribute to a URL.

Write results back with `bin/research.js --write <key>`.

### 3. Generate a long idea list

Produce **15 to 25** candidates yourself. Not five. The devil's advocate needs real
alternatives to kill, and a short list means the winner wins by default.

Each candidate is an object with every cooldown dimension filled in:

```json
{
  "id": "i07",
  "topic": "short kebab-friendly subject phrase",
  "angle": "the specific claim this post makes",
  "template": "stat-card",
  "featureShown": "disclosure-stamping",
  "hookArchetype": "myth-bust",
  "audience": "agents",
  "roomType": "Bathroom",
  "style": "modern",
  "palette": "cool grey and white",
  "ctaStyle": "save-this-for-your-next-listing",
  "visualSummary": "what the finished image literally shows",
  "copy": { "headline": "the actual headline" },
  "whyNow": "why this week",
  "whyThisEarnsAClick": "not just a like"
}
```

Rules for the list:

- Spread across all three audiences. At least a third must target someone other than agents.
- Spread across **features**, not just rooms. Read `config.json` `features` and work through
  the product. Masking Studio, floor plan to 3D, furniture reference upload and disclosure
  stamping are all under-posted and all more interesting than another living room.
- Vary the format. Not everything is a single 4:5.
- `roomType` must be one of the 8 in `config.json`. Map friendly names through
  `roomTypes.aliases`. A nursery is a `Bedroom`; a patio is `Outdoors`.

Write them to `posts/<slug>/work/ideas.json`.

### 4. Gate the list

```
node instagram/bin/check.js posts/<slug>/work/ideas.json --json
```

Discard everything blocked and regenerate replacements until you have at least 10 that
pass. **The devil's advocate only ever sees candidates that already cleared the gate**, so
it is choosing on merit rather than re-litigating cooldowns.

### 5. Devil's advocate

Spawn a **separate subagent**. Not yourself. It must have no memory of authoring the ideas,
because an author defends their own work.

> You are the devil's advocate for an Instagram post. Attached are candidates that have
> already cleared the uniqueness gate, the last 10 post records, and the performance
> table.
>
> Argue **against** every candidate. Kill the weak ones and state why. Shortlist exactly
> five, and for each write the single strongest argument that it will flop, then the
> rebuttal that lets it survive anyway. A shortlist entry with a hedging or empty attack is
> a failure.
>
> Then pick exactly one winner. Answer two questions explicitly: why does this earn a
> **click**, not just a like; and how is it genuinely different from the recent posts you
> were shown. Finally name one residual risk. "None" is not an acceptable answer.
>
> Return JSON: `{ killed[], shortlist[], winner, whyThisOne, whyNotTheOtherFour,
> residualRisk }`.

### 6. CHECKPOINT. Stop and ask.

This is the **only** checkpoint. Show the user:

- the winner, in one line
- the advocate's reasoning and its residual risk
- the two strongest runners-up, in one line each

Then wait. Do not build until they approve or redirect. Everything after this runs to
completion without stopping.

### 7. Build

Write the copy. Acquire the images. Render.

**Copy:**
- Caption at most 2200 characters, with the hook inside the first 125, because Instagram
  truncates there.
- 5 to 15 hashtags drawn from the audience pool in `config.json`, plus at most three new ones.
- Alt text for every image, at most 100 characters each.
- One static bio link. **Never invent a tracked or campaign URL**; per-post links were
  considered and deliberately not built.
- Read `config.json` `voice` before writing. Short declarative sentences. Numbers over
  adjectives.

**Images:** use `lib/images/acquire.js`. It sources a real empty room (free-license stock
first, then fal, then Gemini) and stages it through the actual product. The "after" in a
post is always a genuine `processStaging` render.

**Render:** `node instagram/bin/render.js --record posts/<slug>/post.json`

### 8. Review

Spawn a **separate subagent** with fresh context that did not build this post.

> Review the finished Instagram post at these paths. **Use Read on each image file.** Judge
> only what you can see in the pixels. Do not read the caption or post.json first; it will
> bias you toward confirming.
>
> Check for: warped, melted or impossible furniture and geometry; text clipped, overflowing
> or colliding; poor contrast where text sits over photo; wrong aspect or an off-centre
> crop; a distorted logo; anything that reads as an AI artifact.
>
> Also: list every dash-like character you can see, and for each describe its rendered
> length relative to an adjacent lowercase "n". Do not answer yes or no.
>
> Finally, compare against these thumbnails of the last five posts. Does this read as a
> rerun of any of them in composition, colour or idea?
>
> Return `{ reviewedFiles[], verdict: "pass"|"fix"|"reject", blocking[], nits[],
> dashAudit[], samenessVerdict }`.

If `blocking` is non-empty, fix and re-render. **At most two rounds**, then stop and hand
the problem to the user rather than looping.

### 9. Finalise

```
node instagram/bin/finalize.js <slug>
```

**This is not optional and it is not something you do later.** It appends the record to
`history/posts.jsonl`, derives `layoutFamily` if it is missing, runs the copy checks, and
refreshes the ledger. A post that is not in history is invisible to every cooldown, so the
next run can rebuild the same idea and the gate will report all clear. That has already
happened once: a finished carousel sat rendered on disk and out of history until someone
noticed.

If several posts are being built in one sitting, **finalise each one before planning the
next**. That is the whole reason sequential building is safe: every post is checked against
real history rather than a guess.

The command prints what the next post is now blocked from. Read it, because it is the
constraint the next run starts from.

Then tell the user the folder path and what to upload.

Before starting any post, confirm nothing was dropped:

```
node instagram/bin/finalize.js --check
```

---

## Things that will bite you

**Room types are a closed set.** `Bedroom, Living room, Dining room, Kitchen, Office,
Bathroom, Outdoors, Dorm`. Anything else is rejected by `processStaging`.

**Exteriors are not rooms.** For curb appeal use `Outdoors` with the exterior prompt path,
not a normal staging call.

**A render can ship having failed QA.** `processStaging` returns its best attempt once it
runs out of retries, even when none passed review. That is right for a customer and wrong
for a public advertisement, so `acquirePair` reports `quality.perfect`, `quality.bestScore`
and `quality.defects`, and tries a second source photo when the first one fails. Rule 4 is
what you do about it.

**Known artifact: chair legs.** Across repeated renders the reviewer flags office and dining
chairs for an extra or disconnected leg, scoring 70 to 85. It is usually subtle at feed size
and obvious at full size. Prefer compositions where seating is not the focal point, and
check chair bases specifically before shipping.

**Aspect.** Gemini text to image returns square, and `processStaging` pins the output aspect
to its input. Stock photos searched with `orientation: portrait` give better 4:5 crops than
generated squares, so prefer stock when the brief allows it.

---

## Commands

```
node instagram/bin/check.js --available            what dimensions are open today
node instagram/bin/check.js <candidates.json>      gate a candidate list, exit 1 if blocked
node instagram/bin/render.js --record <post.json>  render a post record to files
node instagram/bin/render.js --fixture <file>      render a fixture into posts/_scratch/
node instagram/bin/smoke-images.js                 prove the image chain with real calls
node instagram/bin/finalize.js <slug>              step 9: put a post into history
node instagram/bin/finalize.js --check             find posts rendered but not in history
node instagram/bin/metrics.js --pending            which posts need numbers
node instagram/bin/metrics.js --top                what has performed best so far
node instagram/bin/templates.js --list             the layout library and what each is for
node --test "instagram/**/*.test.js"               the tool's own tests
```

## Keys

In the repo-root `.env`. Missing keys disable a source rather than failing a run.

| Key | Effect if missing |
|---|---|
| `GOOGLE_AI_API_KEY` | Required. No staging, no generation. |
| `GPT_KEY` | Alt text degrades to hand-written. |
| `FAL_AI_API_KEY` | fal source disabled, falls back to Gemini. |
| `PEXELS_API_KEY` | Stock search loses a provider. |
| `UNSPLASH_ACCESS_KEY` | Optional second stock provider. Pexels alone is enough. |
