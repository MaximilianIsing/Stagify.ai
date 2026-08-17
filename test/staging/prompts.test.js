// AI Designer system-instruction builders (lib/prompts.js). These are pure string
// builders; a regression (dropped context, missing JSON contract) is silent and
// degrades the model's behavior. We assert the caller-supplied context is embedded
// and the response contract is present — without pinning the exact prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildChatSystemInstruction,
  buildChatUploadSystemInstruction,
  buildWelcomeMessagePrompt,
  generatePrompt,
  qualityRetryFeedbackSuffix,
  styleReferencePromptSuffix,
  maskReferencePromptSuffix,
  furnitureReferencePromptSuffix,
  // Shared model-facing prose (re-exported from ./designer-rules.js) plus the routing
  // schema — the drift guards at the bottom of this file assert these stay single-copy.
  AI_DESIGNER_CAD_RULES,
  AI_DESIGNER_MESSAGE_TAG_RULES,
  MESSAGE_TAG_PREFIXES,
  REALISTIC_DEFECT_FREE_RULES,
  DESIGNER_ROUTING_SCHEMA,
} from '../../lib/staging/prompts.js';

test('buildChatSystemInstruction embeds image/date/base-selection context and the JSON contract', () => {
  const s = buildChatSystemInstruction({
    imageContext: '<<IMAGE_CTX>>',
    memories: [],
    dateContext: '<<DATE_CTX>>',
    baseSelectionContext: '<<BASE_SEL>>',
  });
  assert.match(s, /Stagify\.ai/);
  assert.ok(s.includes('<<IMAGE_CTX>>'), 'image context is embedded');
  assert.ok(s.includes('<<DATE_CTX>>'), 'date context is embedded');
  assert.ok(s.includes('<<BASE_SEL>>'), 'base-selection context is embedded');
  for (const key of ['"response"', '"memories"', '"staging"', '"generate"', '"cad"']) {
    assert.ok(s.includes(key), `the response contract mentions ${key}`);
  }
});

test('buildChatSystemInstruction lists memories only when present', () => {
  const withMem = buildChatSystemInstruction({
    imageContext: '',
    memories: [{ content: 'prefers Scandinavian style' }, { content: 'has a small apartment' }],
    dateContext: '',
    baseSelectionContext: '',
  });
  assert.match(withMem, /Important information to remember/);
  assert.ok(withMem.includes('1. prefers Scandinavian style'));
  assert.ok(withMem.includes('2. has a small apartment'));

  const noMem = buildChatSystemInstruction({ imageContext: '', memories: [], dateContext: '', baseSelectionContext: '' });
  assert.ok(!noMem.includes('Important information to remember'), 'no memory header when there are none');
});

test('buildChatUploadSystemInstruction embeds memories, identity, and the JSON contract', () => {
  const s = buildChatUploadSystemInstruction({ memories: [{ content: 'wants a cozy vibe' }], dateContext: '' });
  assert.match(s, /Stagify\.ai/);
  assert.ok(s.includes('1. wants a cozy vibe'), 'memory is listed');
  for (const key of ['"response"', '"memories"', '"staging"', '"generate"']) {
    assert.ok(s.includes(key), `the response contract mentions ${key}`);
  }
});

// --- buildWelcomeMessagePrompt: folds stored memories into a numbered list ---

test('buildWelcomeMessagePrompt with no memories omits the user-information block', () => {
  const s = buildWelcomeMessagePrompt();
  assert.match(s, /returning user of Stagify AI Designer/);
  assert.ok(!s.includes('User information:'), 'no memory block when there are none');
});

test('buildWelcomeMessagePrompt numbers each stored memory', () => {
  const s = buildWelcomeMessagePrompt([{ content: 'likes minimalism' }, { content: 'has two cats' }]);
  assert.match(s, /User information:/);
  assert.ok(s.includes('1. likes minimalism'));
  assert.ok(s.includes('2. has two cats'));
});

// --- generatePrompt: room-type + style matrix with keep/remove-furniture branches ---

test('generatePrompt keeps existing furniture by default and preserves architecture', () => {
  const p = generatePrompt('Bedroom', 'standard', '', false);
  assert.match(p, /KEEP EXISTING FURNITURE/);
  assert.match(p, /PRESERVE THE ARCHITECTURE EXACTLY/);
  assert.ok(!p.includes('remove all existing furniture'), 'does not instruct removal when keeping');
});

test('generatePrompt removes furniture first when removeFurniture is set (boolean or "true")', () => {
  for (const flag of [true, 'true']) {
    const p = generatePrompt('Living room', 'standard', '', flag);
    assert.match(p, /remove all existing furniture and decor/i);
    assert.ok(!p.includes('KEEP EXISTING FURNITURE'), `flag=${JSON.stringify(flag)} keeps nothing`);
  }
});

test('generatePrompt uses the additionalPrompt as the base for a custom style', () => {
  const p = generatePrompt('Office', 'custom', '  a Bauhaus reading nook  ', false);
  assert.ok(p.includes('a Bauhaus reading nook'), 'custom style promotes the additional prompt');
});

test('generatePrompt appends non-custom additional details as a priority suffix', () => {
  const p = generatePrompt('Kitchen', 'standard', 'add a green island', false);
  // Scoped to the STYLE guidance, deliberately. This used to read "above everything else",
  // which sat ~2,500 characters after the architecture rule and therefore told the model, in
  // as many words, that the free-text box outranked "do not resize the windows" — so a
  // request as ordinary as "make it feel bright and open" enlarged them.
  assert.match(p, /Prioritize the following over the style guidance above: add a green island/);
  assert.ok(!/above everything else/.test(p), 'nothing in the prompt claims to outrank the preservation block');
});

// --- The architecture lock: position, authority, and the two tiers -----------
//
// Position is the whole mechanism. Whichever block speaks LAST wins the argument — the same
// discipline ROOM_TYPE_CONSTRAINTS relies on to survive a remove-furniture request — so a
// block that claims to override everything above it is only telling the truth if nothing
// follows it. These pin that.

test('generatePrompt emits the architecture lock LAST, after the user free text', () => {
  const p = generatePrompt('Kitchen', 'standard', 'make it bright and open', false);
  assert.ok(
    p.indexOf('PRESERVE THE ARCHITECTURE') > p.indexOf('Prioritize the following'),
    'the preservation block must come after the free text it claims authority over',
  );
  assert.ok(
    p.trimEnd().endsWith('finishes of existing permanent fixtures.'),
    'nothing is appended after the preservation block',
  );
});

test('generatePrompt gives the architecture lock explicit authority over the user\'s own words', () => {
  const p = generatePrompt('Bedroom', 'standard', '', false);
  assert.match(p, /overrides EVERY instruction above it, including any request in the user's own words/);
});

test('generatePrompt states the window/door rule as a COUNT, not a vague noun list', () => {
  // A model can check a count against itself; "keep it as it appears" it cannot. The
  // partly-hidden clause is load-bearing: the most common way a window disappears is that
  // furniture was placed where it used to be and the model then had no reason to draw it.
  const p = generatePrompt('Living room', 'modern', '', false);
  assert.match(p, /same number of windows, doors and wall openings/i);
  assert.match(p, /PARTLY HIDDEN behind furniture in the input is still a window or door/i);
});

test('generatePrompt keeps surface finishes reachable by an explicit request (tier 2)', () => {
  // The lock is two-tier on purpose. Structure is absolute; finish is preserved BY DEFAULT
  // but an explicit request may change it — otherwise "paint the walls sage" stops working
  // and the free-text box stops being worth having.
  const p = generatePrompt('Bedroom', 'standard', '', false);
  const tier2 = p.slice(p.indexOf('DEFAULT-PRESERVE'));
  assert.match(tier2, /change these ONLY if the user explicitly asked for it/i);
  assert.match(tier2, /Wall colours, paint, wallpaper/);
  // …and the structural nouns must NOT be in the negotiable tier.
  for (const structural of ['windows', 'doors', 'wall openings']) {
    assert.ok(!tier2.includes(structural), `${structural} must stay in the absolute tier, not DEFAULT-PRESERVE`);
  }
});

// --- Framing lives in the lock, and only there ------------------------------
//
// It used to be emitted separately as `CRITICAL — IMAGE FRAMING`, which granted the camera
// an exception ("move it ONLY if the user explicitly asked for a closer or different crop")
// that the lock then denied outright — and the lock, speaking last, won. The result was a
// rule nobody had decided: "zoom in on the seating area" was silently refused. Two sections
// both claiming to own the camera is how that happens, so there is now one.

test('the structural camera rule is stated exactly once', () => {
  // THE drift test for this class of bug. A second framing section reintroduces the
  // contradiction, and nothing else in the suite would notice.
  const p = generatePrompt('Kitchen', 'modern', 'make it bright and open', false);
  const structural = p.split('\n').filter((l) => /camera/i.test(l) && /Do not change/i.test(l));
  assert.equal(structural.length, 1, 'exactly one bullet locks the camera');
  assert.ok(
    !p.includes('CRITICAL — IMAGE FRAMING'),
    'no standalone framing section — the lock owns framing now',
  );
});

test('no crop carve-out survives; the lock says so explicitly', () => {
  const p = generatePrompt('Living room', 'standard', 'zoom in on the fireplace', false);
  assert.ok(
    !p.includes('asked for a closer or different crop'),
    'the stale exception is gone — it contradicted the lock and lost silently',
  );
  assert.match(p, /No request may re-crop, zoom, or re-frame the photograph/);
});

test('the framing rules moved INTO the lock, none of them dropped', () => {
  const p = generatePrompt('Bedroom', 'standard', '', false);
  const lock = p.slice(p.indexOf('PRESERVE THE ARCHITECTURE'));
  for (const rule of [
    /EXACT same aspect ratio, orientation and canvas dimensions/,
    /Keep the FULL scene from the input in frame/,
    /no stretching, squashing, letterboxing or padding/,
    /Fit every staging change INSIDE the existing frame/,
  ]) {
    assert.match(lock, rule, `framing rule survived the move: ${rule}`);
  }
});

test('the merged fragments survived being folded into other bullets', () => {
  // The "do not add a window/skylight" bullet was deleted as subsumed by the
  // permanent-element list and the COUNT rule. Its two unique fragments were merged rather
  // than dropped — a merge that silently loses content is the failure mode here.
  const p = generatePrompt('Bedroom', 'standard', '', false);
  assert.match(p, /arches, skylights, ceilings/, 'skylights joined the permanent-element list');
  assert.match(
    p, /never add one either, however much better the room would look with it/i,
    'the anti-improvement nudge joined the COUNT bullet',
  );
});

test('a room-type rule can still veto a tier-2 finish change, but never a tier-1 one', () => {
  // The lock speaks LAST and so wins every argument — right for structure, wrong for finish.
  // A dorm student cannot repaint university property, so ROOM_TYPE_CONSTRAINTS['Dorm']
  // forbids it; without the carve-out, "paint the walls sage" would sail straight past that
  // rule because the lock's tier 2 permits finish changes on explicit request.
  const p = generatePrompt('Dorm', 'modern', 'paint the walls sage green', false);
  assert.match(p, /Do not paint walls, add wallpaper/, 'the dorm rule is still present');
  assert.match(
    p, /change these ONLY if the user explicitly asked for it above, AND no rule above forbids it/,
    'tier 2 defers to a hard room-type rule stated above it',
  );
  // Tier 1 keeps NO such carve-out: no room-type rule has any business moving a wall.
  const tier1 = p.slice(p.indexOf('PRESERVE THE ARCHITECTURE'), p.indexOf('DEFAULT-PRESERVE'));
  assert.match(tier1, /overrides EVERY instruction above it/);
  assert.ok(!/no rule above forbids it/.test(tier1), 'structure yields to nothing');
});

test('generatePrompt falls back to standard when a custom style carries no text', () => {
  // The picker lets anyone select Custom and type nothing. That used to resolve to the
  // matrix's own 'custom' entry — "Stage this kitchen with the elements and decor the user
  // asks for" — a null instruction that left the model to improvise the whole room.
  const empty = generatePrompt('Kitchen', 'custom', '', false);
  const standard = generatePrompt('Kitchen', 'standard', '', false);
  assert.equal(empty, standard, 'an empty custom request stages exactly as standard does');
  assert.ok(!empty.includes('the elements and decor the user asks for'), 'no null instruction reaches the model');
});

// --- Dorm: the fixed university-issued furniture + small-room scale constraints ---
//
// A dorm's desk, bed frame, wardrobe and dresser are university property the student
// cannot swap, so a staging that restyles them is unusable. These rules therefore have
// to reach the model on EVERY dorm path — including the two that bypass the prompt
// matrix (custom style) or would otherwise contradict them (remove-furniture).

test('generatePrompt pins the fixed dorm furniture and small-room scale', () => {
  const p = generatePrompt('Dorm', 'standard', '', false);
  assert.match(p, /FIXED UNIVERSITY-ISSUED FURNITURE/);
  assert.match(p, /DORM SCALE AND FOOTPRINT/);
  for (const fixed of [/\bdesk\b/i, /bed frame/i, /wardrobe/i, /dresser/i]) {
    assert.match(p, fixed, `names the fixed piece ${fixed}`);
  }
});

test('generatePrompt keeps the dorm constraints under a remove-furniture request', () => {
  // The removal clause and the dorm rules directly conflict; the dorm block is emitted
  // after it and says so explicitly, otherwise "remove all furniture" would strip the
  // very desk and bed frame that must survive.
  const p = generatePrompt('Dorm', 'modern', '', true);
  assert.match(p, /remove all existing furniture and decor/i);
  assert.match(p, /FIXED UNIVERSITY-ISSUED FURNITURE/);
  assert.match(p, /overrides every other instruction above/i);
  assert.ok(
    p.indexOf('FIXED UNIVERSITY-ISSUED FURNITURE') > p.indexOf('remove all existing furniture'),
    'the dorm rules come after the removal clause so they get the last word',
  );
});

test('generatePrompt keeps the dorm constraints for a custom style', () => {
  // A custom style replaces the matrix entry wholesale, so constraints living in
  // promptMatrix would silently vanish here.
  const p = generatePrompt('Dorm', 'custom', 'neon cyberpunk vibe', false);
  assert.ok(p.includes('neon cyberpunk vibe'));
  assert.match(p, /FIXED UNIVERSITY-ISSUED FURNITURE/);
  assert.match(p, /DORM SCALE AND FOOTPRINT/);
});

test('generatePrompt adds standard-issue dorm furniture when the room is bare', () => {
  const p = generatePrompt('Dorm', 'standard', '', false);
  assert.match(p, /If the room is bare and one of those pieces is absent, add a plain standard-issue version/i);
});

test('generatePrompt leaves non-dorm room types free of the dorm constraints', () => {
  for (const room of ['Bedroom', 'Living room', 'Office']) {
    const p = generatePrompt(room, 'standard', '', false);
    assert.ok(!p.includes('FIXED UNIVERSITY-ISSUED FURNITURE'), `${room} is unconstrained`);
  }
});

// --- qualityRetryFeedbackSuffix: turn a QA verdict into a corrective suffix ---

test('qualityRetryFeedbackSuffix is empty for a missing or passing review', () => {
  assert.equal(qualityRetryFeedbackSuffix(null), '');
  assert.equal(qualityRetryFeedbackSuffix({ perfect: true }), '');
});

test('qualityRetryFeedbackSuffix lifts the named defect out of the WHY: line', () => {
  const s = qualityRetryFeedbackSuffix({ perfect: false, reason: 'PERFECT: false\nWHY: the sofa has three arms' });
  assert.match(s, /REVISION NEEDED/);
  assert.ok(s.includes('the sofa has three arms'), 'the specific defect is quoted back');
});

test('qualityRetryFeedbackSuffix falls back to a generic nudge when no WHY: line is present', () => {
  const s = qualityRetryFeedbackSuffix({ perfect: false, reason: 'PERFECT: false' });
  assert.match(s, /a visible quality defect/);
});

// --- styleReferencePromptSuffix: singular vs. plural reference wording ---

test('styleReferencePromptSuffix is empty when there are no reference images', () => {
  assert.equal(styleReferencePromptSuffix(0), '');
  assert.equal(styleReferencePromptSuffix(-1), '');
});

test('styleReferencePromptSuffix distinguishes one reference from many', () => {
  assert.match(styleReferencePromptSuffix(1), /The second image is/);
  assert.match(styleReferencePromptSuffix(3), /The additional images after the room photo are/);
  assert.match(styleReferencePromptSuffix(1), /STYLE REFERENCE/);
});

// --- maskReferencePromptSuffix: constant guidance for the mask-edit reference ---

test('maskReferencePromptSuffix describes the trailing reference image', () => {
  const s = maskReferencePromptSuffix();
  assert.match(s, /REFERENCE IMAGE/);
  assert.match(s, /masked region/);
});

// --- furnitureReferencePromptSuffix: enumerate the reference ordinals (joinOrdinals) ---

test('furnitureReferencePromptSuffix is empty when there are no reference images', () => {
  assert.equal(furnitureReferencePromptSuffix(0), '');
});

test('furnitureReferencePromptSuffix uses singular wording for one reference', () => {
  const s = furnitureReferencePromptSuffix(1);
  assert.match(s, /The second image/);
  assert.match(s, /reference furniture piece\b/);
});

test('furnitureReferencePromptSuffix joins multiple ordinals with an Oxford comma', () => {
  const s = furnitureReferencePromptSuffix(3);
  assert.match(s, /The second, third, and fourth images/);
  assert.match(s, /reference furniture pieces\b/);
});

test('furnitureReferencePromptSuffix adds the preserve-existing-staging clause when asked', () => {
  const kept = furnitureReferencePromptSuffix(2, true);
  assert.match(kept, /ALREADY-STAGED ROOM/);
  const fresh = furnitureReferencePromptSuffix(2, false);
  assert.ok(!fresh.includes('ALREADY-STAGED ROOM'), 'no preserve clause without the flag');
});

// ── Drift guards ─────────────────────────────────────────────────────────────
//
// THE GUARD IS THE POINT of each extraction below, not the extraction. Three blocks of
// model-facing prose used to exist as two or three byte-identical copies each; nothing
// stopped one copy being tuned and the other left behind, and the two chat endpoints
// would then have quietly disagreed about how to route.

test('DRIFT: the CAD rules exist ONCE and reach BOTH system instructions', () => {
  const chat = buildChatSystemInstruction({
    imageContext: '', memories: [], dateContext: '', baseSelectionContext: '',
  });
  const upload = buildChatUploadSystemInstruction({ memories: [], dateContext: '' });

  for (const [name, s] of [['chat', chat], ['upload', upload]]) {
    assert.ok(s.includes(AI_DESIGNER_CAD_RULES), `${name} carries the shared CAD rules verbatim`);
    // Once, not twice: a re-inlined copy would show up as a second occurrence.
    assert.equal(
      s.split('CAD-STAGING RULES (for blueprints/floor plans and CAD-staged images):').length - 1,
      1,
      `${name} contains exactly one CAD-STAGING RULES header`,
    );
  }
});

test('DRIFT: the message-tag prefixes are defined once and every one is explained', () => {
  // The [TAG: …] prefix is the user's EXPLICIT pathway choice from the dropdown, and
  // nothing used to tell the model what it meant — so the one control meant to override
  // the model's inference was a string it had never been taught to read. A prefix the
  // rules do not name is exactly that bug again.
  for (const prefix of Object.values(MESSAGE_TAG_PREFIXES)) {
    assert.ok(
      AI_DESIGNER_MESSAGE_TAG_RULES.includes(prefix),
      `the tag rules explain ${prefix}`,
    );
  }
  assert.deepEqual(
    Object.keys(MESSAGE_TAG_PREFIXES).sort(),
    ['cad-stage', 'describe', 'generate', 'stage'],
    'the map matches the dropdown in public/ai-designer.html',
  );
});

test('DRIFT: the tag map has no second copy in the two prep modules', async () => {
  // It used to live in three places: chat-request-prep once and chat-upload-prep twice.
  const files = ['../../lib/chat/chat-request-prep.js', '../../lib/chat/chat-upload-prep.js'];
  for (const rel of files) {
    const src = await readFile(new URL(rel, import.meta.url), 'utf8');
    assert.ok(
      !src.includes("'[TAG: CAD-Stage]'"),
      `${rel} must use MESSAGE_TAG_PREFIXES, not its own literal copy`,
    );
    assert.ok(src.includes('MESSAGE_TAG_PREFIXES'), `${rel} imports the shared map`);
  }
});

test('DRIFT: the realism rules are one constant, used by staging AND the eye-level CAD prompt', () => {
  // generatePrompt is no longer the only consumer — lib/staging/cad-handling.js's
  // eye-level render needs the identical list, and a hand-written second copy would
  // drift the moment either is tuned.
  const staged = generatePrompt('Living room', 'modern', '', false);
  assert.ok(staged.includes(REALISTIC_DEFECT_FREE_RULES), 'generatePrompt interpolates the constant');
  assert.match(REALISTIC_DEFECT_FREE_RULES, /grounded contact shadows/);
});

test('DRIFT: both CAD views are described to the routing model', () => {
  // The schema can offer a `view` the prose never explains, in which case the model will
  // never pick the new one and the feature is inert.
  for (const view of ['top-down', 'eye-level']) {
    assert.ok(AI_DESIGNER_CAD_RULES.includes(`"${view}"`), `the rules name the ${view} view`);
  }
  assert.match(AI_DESIGNER_CAD_RULES, /"room" is REQUIRED for "eye-level"/);
});

test('DRIFT: every cad schema property is also listed as required', () => {
  // OpenAI structured outputs are STRICT here (additionalProperties:false): a property
  // added to `properties` but not to `required` makes the API reject the whole request,
  // which shows up as the Designer failing on every turn.
  const cad = DESIGNER_ROUTING_SCHEMA.properties.cad.items;
  assert.deepEqual(
    Object.keys(cad.properties).sort(),
    [...cad.required].sort(),
    'cad: properties and required must match exactly',
  );
});
