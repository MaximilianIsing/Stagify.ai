# to-build/media-png/instagram/ — cover masters for the homepage #instagram section

These are the three Instagram posts shown on the homepage. `scripts/build-instagram-covers.js`
turns them into `public/media-webp/instagram/*.webp` at 660×825 (2× the 330 px card).

## These are NOT lossless masters

They are PNG copies of Instagram's own CDN JPEGs — the "WebP-derived copies" exception in
`to-build/README.md`, running the same way round. No lossless origin was ever saved for
these posts. **Do not sharpen or upscale expecting detail to come back.**

The local post generator in `instagram/posts/` holds a counterpart for each (see the table
below), but only as a 400×500 `thumb.jpg` — smaller than what ships. The fetched CDN image
is the better source, which is why these were downloaded rather than copied across.

## Where each one came from

| Master | Post | Shortcode | `instagram/posts/` counterpart |
|---|---|---|---|
| `empty-to-staged.png` | "Empty to staged. One click. Free." | `DbMhP88TW-u` | `legacy-01-one-click-turns-an-empty-room-into-a-staged-one` |
| `floor-plan-to-render.png` | "Sell it before it's built." | `Dbb5d_Hz5TF` | `legacy-06-turning-a-floor-plan-into-a-photoreal-room` |
| `five-styles.png` | "One empty room. Five different buyers." | `DbRw_GgxZx8` | `legacy-02-one-room-staged-five-ways-for-five-different` |

The counterparts were identified by perceptual hash against each folder's `thumb.jpg`. The
first two match decisively; `five-styles` matches by subject and headline with a weaker
pixel distance, most likely because that post is a carousel and the local thumb is a
different frame. Nothing depends on the mapping — it is recorded so the next person does
not have to redo the search.

## Refetching a cover

Instagram's legacy media redirect serves the full-size image without authentication:

```sh
curl -L "https://www.instagram.com/p/<shortcode>/media/?size=l" -o cover.jpg
```

It returns the 1080×1350 post image (frame 1 for a carousel, which is the right cover).
Convert to PNG, drop it in here, and rerun the build script. **Give it a new filename** —
`public/media-webp/` is served `immutable` for a year, so a cover replaced in place would
never reach returning visitors. Update the `src` and the `home.instagram.posts.*` alt key
in `public/index.html` to match.

## Adding or removing a post

The section shows three cards on desktop and one on mobile (`.ig-card:not(:first-child)` is
hidden under 720 px), so the first card is the one everybody sees — put the strongest post
there. The shortcodes live only in `public/index.html`; nothing in `instagram/` records an
Instagram permalink, so the URL has to be added by hand.

`test/frontend/home-instagram.test.js` pins the card count, the link attributes and the
absence of any `<iframe>` in this section.
