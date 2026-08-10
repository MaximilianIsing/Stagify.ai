# `#testimonials` section — layout concepts (prototype)

> **DECIDED: concept 5, the swipe deck.** Shipped on 2026-08-10 — see
> `public/scripts/home-testimonials.js`, the `.tw-deck` block in `public/styles/home.css`,
> and `test/frontend/home-testimonials.test.js`. Cards 3–6 went in as marked
> placeholders; the test file carries a **skipped** guard, `no placeholder testimonials
> remain`, to un-skip in the commit that pastes the four real quotes in.
>
> This folder has served its purpose and can be deleted. Two things in it are still
> worth reading first: the **bugs found by actually running it**, and the two live-site
> findings below — one of which (`<figure>`'s unreset UA margin) was fixed as part of
> shipping the deck.

Throwaway design exploration for the homepage section titled
**"What agents are saying"** (`public/index.html:1098-1142`).

**Nothing here is wired into the app.** This folder sits outside `public/`, so the
Express static mount never serves it and no runtime code imports it. It is safe to
delete once a direction is picked — unlike `to-build/`, this is not a build input.
`npm test` and `npm run lint` do not see it either.

## Why

The section holds exactly **two** hard-coded quote cards. Four more are coming, six
total, and today's markup has no path to hold them:

- Six cards in the current 2-up grid run **1267px** — about five phone screens, wedged
  between the studio showcase and the savings calculator, the two heaviest blocks on
  the page.
- On a phone it is worse. `home.css:3211` says
  `.tw-card:nth-child(n + 2) { display: none }`, so a phone shows **one** testimonial
  and silently discards the other five. Open concept 0, hit the phone toggle, and watch
  it happen.

## How to open it

Double-click `index.html`, or:

```
start testimonial-section-concepts/index.html
```

It runs entirely over `file://` — no server, no build step. That is also why
`concepts.js` is a **classic script, not an ES module**: `<script type="module">`
is CORS-blocked on `file://`.

## Decisions this prototype was built against

| Question | Answer |
|---|---|
| Card asset | **Brokerage logo only** — no headshots. Four more logos to source. |
| Mobile | **All six reachable, swipeable.** The `nth-child` trick is retired. |
| Quote length | **~35–45 words**, matching the two real quotes. |

## What's in it

Eight ways to lay out the same six quotes, stacked on one page so they can be compared
directly. Concept 0 is today's section, rebuilt from the same markup and the same CSS.

| # | Concept | Shape | Desktop | Phone |
|---|---------|-------|--------:|------:|
| 0 | Today | Two-up glass grid, six cards deep | 1267px | 496px *(1 of 6)* |
| 1 | **Snap rail** | Scroll-snap rail, 2.35 cards visible, dots + arrows | 441px | 490px |
| 2 | **Featured + roster** | One quote on stage, six logos as a tablist | 437px | 488px |
| 3 | Wall of six | 3×3 mosaic, hero spans 2×2 | 1074px | 465px |
| 4 | Counter-marquee | Two rows ticking opposite ways, pause on hover/focus | 715px | 447px |
| 5 | Swipe deck | Fanned stack, top card drags away | 464px | 514px |
| 6 | Quote + proof | Each quote beside the render it describes | 968px | 553px |
| 7 | **Editorial + rating** | Display pull-quote on a timer, over a 5.0 band + logo strip | 538px | 540px |

Heights are measured live in the browser, not estimated — each concept carries a badge
comparing it to concept 0. **Every concept except 3 and 6 is less than half today's
height while showing three times as many quotes.**

The phone column is the interesting one: every concept lands within ~50px of today's
496px, and all of them show **six** quotes where today shows **one**. On mobile this is
not a trade-off, it is free.

### The recommendation

**7, editorial + rating band**, with **1 (snap rail)** as the safe pick and **2** if the
section must be as short as possible.

7 is the only concept that states an *aggregate* — "5.0 from 6 reviews". A grid of cards
makes a reader count; a number tells them. It is also the only one that opens a door the
repo has not walked through: `AggregateRating` / `Review` structured data, which is what
puts review stars on a Google search result. There is **no** `Review` or
`AggregateRating` JSON-LD anywhere in the repo today. That is a marketing asset sitting
on the floor, and this section is where it would go.

## Three deliberate choices

**The copy is fictional, and must stay in this folder.** Six invented people at six
invented brokerages. They are written at the length of the two real quotes (36–41 words)
because real sentence lengths are what decide whether a layout works, and identical copy
across all eight is what makes the height badges a fair comparison. **None of it is a
real endorsement — do not ship a word of it.** Only the two real names, Justin Stern and
Andy Eras, may appear on the live site, plus whatever the four new agents actually said.

**Responsive rules are `@container`, not `@media`.** Eight concepts share one window, so
a viewport media query would flip all eight at once and only when the browser is
genuinely narrow. Instead `.concept__demo` is a size container, the header toggle clamps
it to 390px, and each concept responds to its own width. **In the real repo these become
plain `@media (max-width: 768px)` — the breakpoint value is unchanged.**

**Concepts 1, 3, 4, 5 and 6 share one card component** (`.tq`). The seven options differ
by *layout*, not by card design, so picking one does not also pick a new card. Concept 0
keeps its own `.tw-*` copy so the baseline stays honest.

## Bugs found by actually running it

Worth recording — three of these pass a code read cleanly:

- **`backdrop-filter` + `overflow: hidden` on the same element stops Chrome painting
  descendant images.** Concept 6's photos were invisible while `naturalWidth` was 1264,
  the box was a correct 176×278, computed style was `opacity: 1 / visibility: visible`,
  and the image was its own hit-test target at its centre. Either property alone is
  fine — the glass `.tq` cards show their logos, and `.t4__row` clips glass cards
  happily. It is the pair. The rounded clip was load-bearing, so the `backdrop-filter`
  is what went.
- **`offsetLeft` is measured from the `offsetParent`, not from the scroll container.**
  Nothing between a rail card and `<body>` is positioned, so `cards[i].offsetLeft`
  returned a *page* coordinate — 327 where the scroller wanted 2, and 2102 where it
  wanted 1777. Feeding that to `scrollTo()` sent every jump to the clamped end of the
  rail. Use `getBoundingClientRect()` deltas plus `scrollLeft`.
- **`@container` rules resolve during layout, so a double-`requestAnimationFrame` is not
  enough to measure after a container resizes.** Every badge read the stale desktop
  height on the first phone toggle. A `ResizeObserver` waits for the size that actually
  happened, and picks up the late font swap and lazy images for free.
- **Grid items honour `z-index`, so they outrank later siblings' `auto`.** Concept 5's
  fanned cards are translated out of the stack's box and were painting over the hint text
  and the arrow buttons below them. Needed a bottom margin on the stack, not a z-index
  fight.
- **`gap` puts N−1 gaps between N items, which breaks a marquee seam.** With `gap: 16px`
  and six cards, half the track was 1120px but one set was 1128px — an 8px lurch every
  loop. Per-card `margin-right` gives a uniform pitch, so `translateX(-50%)` lands
  exactly.

## Two things about the live section, found on the way

**1. `.tw-card` is 80px narrower than its own grid track — right now, in production.**
`<figure>` carries a UA `margin: 1em 40px`, and nothing in `styles.css` or `home.css`
resets it (there is no universal margin reset — `styles.css:1` only sets
`box-sizing`). Measured on the real page:

| | Authored | Actually rendered |
|---|---|---|
| Card width | 419px (the grid track) | **339px** |
| Gap between cards | 22px | **102px** |
| Card top margin | 0 | **16px** |

So `gap: 22px` in `.tw-grid` is very nearly decorative. Concept 0 reproduces this
faithfully on purpose — a baseline that quietly fixes the thing it is a baseline for is
worthless — and every new atom opts out with `.tq { margin: 0 }`. **Whatever ships,
reset the figure margin.** It is a one-line fix and the section gets 24% wider cards.

**2. `@keyframes tw-orbit` and `@property --tw-angle` are dead code**
(`home.css:3040-3091`). The comment above them promises a glow that "continuously orbits
each card's border"; no `animation:` property references `tw-orbit` anywhere, so the
border is a static `linear-gradient`. The `prefers-reduced-motion` rule that holds the
non-existent animation still is dead too. Wire it up or delete all three.

## If a concept is picked — the real-repo checklist

1. **i18n is the actual cost, not the CSS.** Six keys per testimonial × 4 new = **24 new
   keys, in all 11 packs**. `test/server/static.test.js:162` is a one-way english→others
   parity gate that blocks the deploy. Any new *control* label (arrows, dots, "6 verified
   reviews") is another key × 11. Each concept's cost strip states its own delta.
2. **Put `data-lang-html` on an inner `<span>`, never on a wrapper containing a button.**
   `language-loader.js:86` assigns `innerHTML` to every `[data-lang-html]` node, which
   destroys nested interactive children. Concepts 2, 5 and 7 all have controls.
3. **`index-inline.js:44-64` hard-codes `#testimonials .tw-card`** for the cursor
   spotlight. Rename either and it dies silently — the file is on the `UNTESTED` ledger
   (`test/frontend/untested-frontend-modules.test.js:78`), so nothing catches it.
   `card-spotlight.js` is a *separate* spotlight (`--sx`/`--sy`) covering `.whyus-card`
   and friends; a rebuild is the moment to collapse the two into one.
4. **Add the new logo class to `home-reveal.js:33`.** It warms image decodes for
   `.hstrip__img, .ba img, .plus-card__logo, .sponsor-logo, .calc__brandmark` — `.tw-logo`
   is already missing from that list, and six logos in a rail will pop in without it.
5. **New JS goes through `index-deferred.js`**, not a `<script>` tag: ESM, under the
   650-line cap, JSDoc-typed (checkJs gates the deploy), with a spec under
   `test/frontend/`, using the guarded `readyState === 'loading'` init pattern because
   `load` has already fired by then.
6. **Ship it progressively enhanced.** Markup should render as a plain stack of six
   quotes until JS adds a ready class, the way `studio-showcase.js` does with `.shw--ready`
   — a script failure should degrade to a long section, not an empty one.
7. **Keep the reveal contract.** Opt-in is the `.reveal` class plus optional
   `reveal--left/--right` and `--reveal-delay`; exits only run above 901px. The comment at
   `home.css:54` claims "37 elements on the homepage carry .reveal" — update it if the
   count moves.
8. **`#testimonials` is linked from nowhere** and is absent from `sitemap.xml`, so the
   anchor id is free to change.
9. **If concept 7 is picked, add the `AggregateRating` JSON-LD** in the same pass — it is
   most of the reason to pick it. Only publish a rating the reviews actually support.

## Known rough edges (it's a prototype)

- **Concept 5's keyboard story is the weakest of the seven.** The buried cards are marked
  `inert`, which keeps them out of the tab order but also hides partly-visible content
  from screen readers. `aria-hidden` would be worse. A real build needs a proper
  roving-focus model, and that is a real cost — it is why the concept is tagged as such.
- **Concept 4 duplicates every card** to make the loop seamless. The second copy is
  `aria-hidden`, but that means the DOM carries six quotes to show three per row. Also,
  reduced-motion turns it into a plain scroll rail, which is a different widget rather
  than a still version of the same one.
- **Concept 7's timer pauses on hover and focus and stops when the section leaves the
  viewport** (reading `entries[entries.length - 1]`, not `entries[0]` — entry 0 is the
  *oldest*, and a scroll that leaves and re-enters within one callback would latch it off
  permanently). It does **not** yet pause on `document.hidden`.
- **Concept 3's hero is vertically centred** because a 2×2 cell holding one quote would
  otherwise leave ~300px of dead air under it. If the real hero quote is much longer than
  the others, re-check it.
- **Concept 6's photos are STAND-IN.** Only three real before/after pairs exist in
  `public/media-webp/Homepage/BeforeAfter/`, so the three `After*.webp` renders are cycled
  twice. The real thing needs six listings *and* permission from six agents.
- **The logos are generated monograms**, not designed marks. They are the right geometry
  (72×72) and nothing more; judge density and placement from them, not craft.
- **Long-language check not done.** The German and Japanese packs will stress concept 2's
  76px logo chips and concept 7's `clamp(19px, 2.3vw, 28px)` pull-quote hardest. Check
  German before committing to either.
