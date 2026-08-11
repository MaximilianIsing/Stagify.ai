// The AI Designer's half of "Label as virtually staged": the routing-schema fragment the
// model fills in, and the prose that tells it when to.
//
// WHY THIS IS ITS OWN MODULE, next to prompts.js rather than inside it
// Every other staging surface asks this question with a checkbox. The Designer is a
// conversation, so the request is already in words and there is nothing to tick — which
// means the entire contract for this feature is a schema shape plus a set of rules about
// when to use it, and those two must agree. Keeping them in one file is what makes that
// visible; scattered across a 650-line prompt file they are two unrelated-looking edits.
//
// THE STYLE LIST IS SPELLED OUT HERE, not imported from lib/image/stamp-disclosure.js
// where the real allow-list lives. That module loads sharp, and this one is pulled in by
// every request that builds a prompt. Same trade the roomType enum makes in
// DESIGNER_ROUTING_SCHEMA, and it is covered the same way: test/staging/prompts.test.js
// imports both sides and fails the build if they drift apart.

/**
 * The `disclosure` property of a staging request, for DESIGNER_ROUTING_SCHEMA.
 *
 * ONE NULLABLE OBJECT rather than three flat fields (a boolean, a style, a scale). It makes
 * "no label" the structurally obvious answer instead of one of three things to get right,
 * and it puts the style and size out of reach for a badge that is off — there is no way to
 * express a size for a label that was never asked for. `furnitureImageIndex` in the same
 * schema already uses this anyOf-with-null shape.
 */
export const DISCLOSURE_ROUTING_FIELD = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['style', 'scale'],
      properties: {
        style: { type: 'string', enum: ['dark', 'light', 'minimal', 'banner'] },
        scale: { type: 'number', description: 'Badge size multiplier, 0.7 (small) to 1.6 (large). 1 is normal.' },
      },
    },
    { type: 'null' },
  ],
  description: 'null unless the user asked for the "Virtually staged" label to be burned into the photo. Set it to an object only when they asked.',
};

/**
 * When to label a render, appended to both system instructions.
 *
 * The three rules that carry the product decision, in the order they matter:
 *   - DEFAULT NULL. A plain "stage this room" is not a request for a disclosure, and
 *     volunteering one on every render would train people to ignore the subject.
 *   - ASK on publishing cues. "Ready for the MLS" is where the answer genuinely matters
 *     and genuinely cannot be assumed either way, so it is the one place a question beats
 *     a guess. Everywhere else, guessing is not on the table because the default is off.
 *   - The answer lasts the CONVERSATION and is never written to memories. A stored
 *     preference would silently label — or silently stop labelling — someone's photos
 *     weeks later in a different conversation, which is the single thing a compliance
 *     control must never do.
 */
export const AI_DESIGNER_DISCLOSURE_RULES =
  '\n\n"VIRTUALLY STAGED" LABEL (CRITICAL):' +
  '\n- Stagify can burn a small "Virtually staged" label into the bottom-right of a finished photo. It is part of the image, so it travels with the file wherever the user publishes it. Set "disclosure" on a staging request to add it; leave "disclosure" null to leave the photo unlabelled.' +
  '\n- DEFAULT IS NULL. A plain staging request ("stage this living room", "make it modern") gets NO label and NO question about one. Do not raise the subject unprompted.' +
  '\n- ASK FIRST — do not guess — when the user talks about PUBLISHING the photo but says nothing about disclosure: "get this ready for the MLS", "I\'m about to post this listing", "this is going on Zillow tomorrow", "send this to my client to publish". Most MLS rules and NAR Article 12 expect a virtually staged photo to be disclosed, so a listing-bound render is exactly where the answer matters and cannot be assumed either way. Ask one short question ("Would you like me to add the \'Virtually staged\' label to it?") and stage nothing that turn.' +
  '\n- When the user asks for it outright ("label it as virtually staged", "add the disclosure", "mark these as virtually staged"), just do it — no question.' +
  '\n- REMEMBER THE ANSWER FOR THIS CONVERSATION. Once they have said yes or no, apply that to every later staging request in the same conversation without asking again, until they say otherwise. If they said yes and then ask you to stage another room, that room is labelled too.' +
  '\n- Do NOT put this preference in "memories". It belongs to this conversation only — a stored preference would silently label (or silently fail to label) photos in a different conversation weeks later, which is the one thing a disclosure control must never do.' +
  '\n- "style" picks the look: "dark" (dark capsule, the default — use it unless they asked for something else), "light" (white capsule with dark text), "minimal" (plain white text, no capsule — for "subtle", "discreet", "small and out of the way"), "banner" (a strip across the full width of the bottom edge — for "banner", "across the bottom", "make it obvious"). "scale" sizes it from 0.7 to 1.6, where 1 is normal; use it only when they asked for a smaller or larger label.';

/** The one-line summary of the field for the `"staging": { … }` contract in each builder. */
export const DISCLOSURE_CONTRACT_FRAGMENT =
  ', "disclosure": null|{ "style": "dark"|"light"|"minimal"|"banner", "scale": 0.7-1.6 }';

/** The STAGING RULES bullet, in both builders. */
export const DISCLOSURE_STAGING_BULLET =
  '\n- Set "disclosure" to null unless the user asked for the "Virtually staged" label, or answered yes when you asked about it. See the "VIRTUALLY STAGED" LABEL rules above for when to ask rather than guess.';
