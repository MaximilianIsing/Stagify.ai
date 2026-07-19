// The upload gatekeeper: the prompt that asks a cheap vision model whether an upload
// is stageable, and the fixed taxonomy of reasons it can reject with.
//
// Prompt and taxonomy live in the SAME file on purpose. The prompt enumerates the
// digits and the taxonomy maps them; if the two ever drift, the gate silently
// mislabels rejections (the model says "4 = document", we tell the user "vehicle").
// Editing one means editing the other, so they must stay side by side.
//
// Consumed by lib/image/image-review.js (validateStageableImage).

export const STAGEABLE_IMAGE_CHECK_PROMPT =
  'You are the upload gatekeeper for a virtual home-staging tool. It works on ' +
  'photographs of a real property space OR of furniture and home furnishings. ' +
  'Treat the image as VALID if it shows ANY of the following:\n' +
  '- An interior room of any kind (living room, bedroom, kitchen, bathroom, office, ' +
  'hallway, basement, etc.), empty and unfurnished OR already furnished.\n' +
  '- A stageable exterior space (patio, balcony, deck, yard, terrace, porch).\n' +
  '- Furniture, decor, or home furnishings on their own — including a close-up or ' +
  'product shot of a single piece such as a sofa, chair, table, bed, rug, lamp, ' +
  'shelving unit, cabinet, or wall art.\n' +
  'A photo where a sofa or other furniture fills most of the frame is VALID — it is ' +
  'furniture, NOT a product to reject — and a photo that mainly shows a room is VALID ' +
  'even if a person happens to be standing in it.\n' +
  'Reject ONLY when the image is clearly NEITHER a property space NOR furniture.\n' +
  'Reply with EXACTLY one line, "CODE: <n>", where <n> is a single digit picked from ' +
  'this list:\n' +
  '0 = VALID — a property space, or furniture/decor. Also use 0 whenever you are unsure.\n' +
  '1 = a person fills the frame (selfie, portrait, headshot)\n' +
  '2 = an animal or pet fills the frame\n' +
  '3 = food or drink\n' +
  '4 = a screenshot, document, page of text, or meme\n' +
  '5 = a car or other vehicle\n' +
  '6 = some other object or product that is not furniture or home decor\n' +
  'Output nothing else.';

export const DEFAULT_UNSTAGEABLE_REASON =
  "This doesn't look like a room, space, or piece of furniture. Please upload a photo of an " +
  "interior room, exterior space, or furniture you'd like to stage.";

// Stable code used when the grader rejects the upload but we could not read a
// category digit out of its reply. Pairs with DEFAULT_UNSTAGEABLE_REASON.
export const GENERIC_UNSTAGEABLE_CODE = 'UNSTAGEABLE';

/**
 * Rejection taxonomy, keyed by the digit the grader emits. Digits (not string enums)
 * because a small, cheap vision model picks reliably from a numbered list but
 * reproduces exact enum spellings much less reliably; we map the digit to a stable
 * code here so nothing downstream — logs, CSV rows, the API response — ever carries
 * a bare magic number.
 *
 * `0` is reserved for "valid" and deliberately has no entry: a valid upload has no
 * rejection to label, so it carries `code: null` rather than a zero sentinel.
 *
 * `message` is the canonical ENGLISH copy. It is what the API returns and what the
 * browser shows until `errors.unstageable.<CODE>` exists in public/languages/*.json —
 * the frontend passes it as the fallback to LanguageSystem.getText(), so translating
 * is purely additive (see public/scripts/unstageable-message.js).
 * @type {Record<string, { code: string, message: string }>}
 */
export const UNSTAGEABLE_CODES = {
  1: {
    code: 'PERSON_PORTRAIT',
    message: 'This looks like a photo of a person. Please upload a photo of a room, space, or piece of furniture.',
  },
  2: {
    code: 'ANIMAL',
    message: 'This looks like a photo of a pet. Please upload a photo of a room, space, or piece of furniture.',
  },
  3: {
    code: 'FOOD',
    message: 'This looks like a photo of food. Please upload a photo of a room, space, or piece of furniture.',
  },
  4: {
    code: 'DOCUMENT',
    message: 'This looks like a screenshot or document. Please upload a photo of a room, space, or piece of furniture.',
  },
  5: {
    code: 'VEHICLE',
    message: 'This looks like a photo of a vehicle. Please upload a photo of a room, space, or piece of furniture.',
  },
  6: {
    code: 'UNRELATED_OBJECT',
    message: "This doesn't look like a room, space, or furniture. Please upload a photo of a space or furniture you'd like to stage.",
  },
};
