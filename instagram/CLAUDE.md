# Instagram post factory

Read `instagram/PLAYBOOK.md` and follow it. That is the operating manual for this folder.

Fifteen hard rules. The first two are enforced in code, so do not try to work around them:

1. Never use an em dash or an en dash, anywhere.
2. Posts must not all look the same. `bin/check.js` is the gate.

The other thirteen nothing enforces but you. Each one can be broken in a way that renders
cleanly, exits zero and still ships wrong:

3. Never trade quality for a cheaper call. Full retry loop, never `skipQualityReview`.
4. When `quality.perfect` is false, open the image yourself before shipping it.
5. The "Virtually staged" disclosure never comes off to make room for copy.
6. Step 6 of the playbook is the only checkpoint. Do not stop anywhere else.
7. The devil's advocate and the image reviewer are separate subagents, never you.
8. On-image text is plain Latin, digits and basic punctuation. The font has nothing else.
9. Nothing may overlap, clip or run out of frame. Overflow is hidden, so it fails silently.
10. Type over a photo sits on a scrim.
11. Three grounds only: the deep blue, the pale wash, a photo.
12. Colour comes from the brand tokens, never a hand-typed hex.
13. Use the shared chrome in `_macros.js` rather than restyling a lookalike.
14. Respect the safe margins. Story and reel move their chrome further in.
15. One headline and one CTA per frame.

This file is a pointer only. The source of truth is `PLAYBOOK.md`, which carries the reasoning behind
every rule above.
