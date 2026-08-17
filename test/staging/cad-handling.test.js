// Tier: unit (no network) — lib/staging/cad-handling.js, the floor-plan renderer.
//
// WHY NO REAL API CALL: the module talks to Gemini only through the client it is HANDED,
// so every test here injects a fake whose getGenerativeModel returns a scripted
// generateContent. That seam is the reason the file was refactored to take the shared
// client (it used to build its own from a lib/staging/key.txt that never existed), and it
// lets the whole render contract be asserted with no network, key, or cost:
//
//   - the two views and the fallback for an absent/unknown one
//   - the aspect pin, which differs BY view and fails open on an unreadable plan
//   - the quality-retry loop, its per-view reviewer rubric, and the gate-off path
//     (which is the SHIPPED wiring — see the note in server.js)
//   - delivery upscale, the disclosure stamp, and the onNative hook the gallery stores
//   - the response-parsing branch ladder and the mime/base64 helpers
//
// Image fixtures that must survive a real base64 round-trip through Buffer — and the
// dimension/format assertions on the delivered output — are built locally with sharp.

import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  createCadHandling,
  parseGeminiResponse,
  getMimeType,
  extractBase64,
  normalizeCadView,
  DEFAULT_CAD_VIEW,
} from "../../lib/staging/cad-handling.js";

// Wraps a base64 image payload in the { candidates: [{ content: { parts } }] }
// shape that Gemini's result.response exposes — the object parseGeminiResponse reads.
const responseWithParts = (parts) => ({ candidates: [{ content: { parts } }] });

// ── parseGeminiResponse ──────────────────────────────────────────────────────

test("parseGeminiResponse: returns a decodable image Buffer from the first inlineData part", async () => {
  const pngBuffer = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toBuffer();

  const response = responseWithParts([
    { inlineData: { data: pngBuffer.toString("base64"), mimeType: "image/png" } },
  ]);

  const result = parseGeminiResponse(response);
  assert.ok(Buffer.isBuffer(result), "result is a Buffer");

  const meta = await sharp(result).metadata();
  assert.equal(meta.width, 4);
  assert.equal(meta.height, 4);
  assert.equal(meta.format, "png");
});

test("parseGeminiResponse: prefers an image (inlineData) part over a text part", async () => {
  const pngBuffer = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).png().toBuffer();

  const response = responseWithParts([
    { text: "here is your render" },
    { inlineData: { data: pngBuffer.toString("base64"), mimeType: "image/png" } },
  ]);

  const result = parseGeminiResponse(response);
  const meta = await sharp(result).metadata();
  assert.equal(meta.width, 4);
  assert.equal(meta.height, 4);
});

test("parseGeminiResponse: returns the FIRST inlineData part when several are present", async () => {
  // The loop returns on the first part that has inlineData.data, so a 4x4 placed
  // ahead of an 8x8 must win. Decoding the dimensions proves which part was picked.
  const firstPng = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toBuffer();
  const secondPng = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 40, g: 50, b: 60 } },
  }).png().toBuffer();

  const response = responseWithParts([
    { inlineData: { data: firstPng.toString("base64"), mimeType: "image/png" } },
    { inlineData: { data: secondPng.toString("base64"), mimeType: "image/png" } },
  ]);

  const result = parseGeminiResponse(response);
  const meta = await sharp(result).metadata();
  assert.equal(meta.width, 4, "returns the first (4x4) part, not the second (8x8)");
  assert.equal(meta.height, 4);
});

test("parseGeminiResponse: throws 'text instead of an image' when the model returns only text", () => {
  const response = responseWithParts([
    { text: "I cannot generate images, but here is a description." },
  ]);
  assert.throws(() => parseGeminiResponse(response), /text instead of an image/);
});

test("parseGeminiResponse: throws 'Unexpected response format' for malformed shapes", () => {
  const badShapes = [
    {},
    { candidates: [] },
    { candidates: [{ content: {} }] },
    { candidates: [{ content: { parts: [] } }] },
  ];
  for (const shape of badShapes) {
    assert.throws(
      () => parseGeminiResponse(shape),
      /Unexpected response format/,
      `expected malformed shape to throw: ${JSON.stringify(shape)}`,
    );
  }
});

test("parseGeminiResponse: throws 'Unexpected response format' when a candidate has no content", () => {
  // candidates[0] is truthy but content is undefined, so the parts branch is skipped
  // entirely and execution falls through to the unexpected-shape throw.
  assert.throws(
    () => parseGeminiResponse({ candidates: [{}] }),
    /Unexpected response format/,
  );
});

test("parseGeminiResponse: throws 'Unexpected response format' when the only inlineData part has no .data", () => {
  // inlineData is present but .data is missing, so the loop skips it; with no text
  // parts either, nothing returns/throws inside the ladder and it falls through.
  const response = responseWithParts([{ inlineData: {} }]);
  assert.throws(() => parseGeminiResponse(response), /Unexpected response format/);
});

// ── getMimeType ──────────────────────────────────────────────────────────────

test("getMimeType: extracts the mime type from a data URL", () => {
  assert.equal(getMimeType("data:image/webp;base64,AAAA"), "image/webp");
  assert.equal(getMimeType("data:image/png;base64,AAAA"), "image/png");
  assert.equal(getMimeType("data:image/jpeg;base64,AAAA"), "image/jpeg");
});

test("getMimeType: maps known file extensions to their mime type", () => {
  assert.equal(getMimeType("floorplan.jpg"), "image/jpeg");
  assert.equal(getMimeType("floorplan.jpeg"), "image/jpeg");
  assert.equal(getMimeType("floorplan.png"), "image/png");
  assert.equal(getMimeType("floorplan.webp"), "image/webp");
  assert.equal(getMimeType("floorplan.gif"), "image/gif");
});

test("getMimeType: falls back to image/png for unknown or missing extensions", () => {
  assert.equal(getMimeType("drawing.bmp"), "image/png");
  assert.equal(getMimeType("noextension"), "image/png");
});

test("getMimeType: lowercases the extension before lookup (uppercase PLAN.JPG)", () => {
  // path.extname yields ".JPG"; the .toLowerCase() step is what makes the lookup hit.
  assert.equal(getMimeType("PLAN.JPG"), "image/jpeg");
});

// ── extractBase64 ────────────────────────────────────────────────────────────

test("extractBase64: encodes a Buffer to base64", () => {
  assert.equal(extractBase64(Buffer.from("ABC")), "QUJD");
});

test("extractBase64: strips the data URL prefix and returns the base64 payload", () => {
  assert.equal(extractBase64("data:image/png;base64,QUJD"), "QUJD");
});

test("extractBase64: returns a bare base64 string unchanged", () => {
  assert.equal(extractBase64("QUJD"), "QUJD");
});

test("extractBase64: returns the data URL unchanged when the base64 payload is empty", () => {
  // The /base64,(.+)$/ capture requires 1+ payload chars; an empty payload fails the
  // match, so the function falls through and returns the original string verbatim.
  assert.equal(extractBase64("data:image/png;base64,"), "data:image/png;base64,");
});

test("extractBase64: throws 'Invalid image data format' for non-string, non-Buffer input", () => {
  assert.throws(() => extractBase64(null), /Invalid image data format/);
  assert.throws(() => extractBase64(123), /Invalid image data format/);
  assert.throws(() => extractBase64({}), /Invalid image data format/);
});

// ── createCadHandling (client injection) ─────────────────────────────────────
//
// This module used to build its OWN GoogleGenerativeAI client from a private
// readApiKey() that resolved lib/staging/key.txt — a path that never exists,
// since the repo-wide convention is a root-level key file resolved through an
// injected __dirname. It was also the only consumer of GEMINI_API_KEY, and it
// threw on an empty GOOGLE_AI_API_KEY where ai-clients.js treats empty as
// "disabled". It now takes the shared client like every other AI-touching module.
//
// Still no real API call: the injected client is a fake whose getGenerativeModel
// returns a scripted generateContent, which is exactly the seam the old private
// client denied us.

// Minimal stand-in for the GoogleGenerativeAI client, recording what it was asked for.
// `configs` captures the WHOLE getGenerativeModel argument, because the aspect-ratio pin
// rides generationConfig.imageConfig rather than the content array.
function fakeGenAI(response) {
  const calls = { models: [], contents: [], configs: [] };
  return {
    calls,
    getGenerativeModel(config) {
      calls.models.push(config.model);
      calls.configs.push(config);
      return {
        generateContent: async (content) => {
          calls.contents.push(content);
          return { response };
        },
      };
    },
  };
}

test("createCadHandling: uses the INJECTED client rather than constructing its own", async () => {
  const pngBuffer = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toBuffer();

  const genAI = fakeGenAI(
    responseWithParts([
      { inlineData: { data: pngBuffer.toString("base64"), mimeType: "image/png" } },
    ]),
  );
  const { blueprintTo3D } = createCadHandling({ genAI });

  const result = await blueprintTo3D("data:image/png;base64,QUJD");

  assert.ok(Buffer.isBuffer(result), "returns the parsed render Buffer");
  assert.equal(genAI.calls.models.length, 1, "the injected client was the one used");
  assert.equal(
    genAI.calls.models[0],
    "gemini-3-pro-image",
    "CAD stays on Pro (see the model note in lib/config/model-config.js)",
  );
});

test("createCadHandling: throws a clear error when the shared client is null (no key configured)", async () => {
  // ai-clients.js leaves genAI null for BOTH an unset and an empty GOOGLE_AI_API_KEY.
  // The old private readApiKey() honored GEMINI_API_KEY and threw its own message, so
  // "Gemini is off" behaved differently here than everywhere else in the app.
  const { blueprintTo3D } = createCadHandling({ genAI: null });

  await assert.rejects(
    () => blueprintTo3D("data:image/png;base64,QUJD"),
    /Google AI client not configured/,
  );
});

test("createCadHandling: forwards the blueprint and furniture images as inlineData parts", async () => {
  const pngBuffer = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).png().toBuffer();

  const genAI = fakeGenAI(
    responseWithParts([
      { inlineData: { data: pngBuffer.toString("base64"), mimeType: "image/png" } },
    ]),
  );
  const { blueprintTo3D } = createCadHandling({ genAI });

  await blueprintTo3D("data:image/png;base64,QUJD", {
    furnitureImages: [{ image: "data:image/webp;base64,REVG", mimeType: "image/webp" }],
  });

  const content = genAI.calls.contents[0];
  const images = content.filter((p) => p.inlineData);
  assert.equal(images.length, 2, "blueprint + one furniture image");
  assert.equal(images[0].inlineData.data, "QUJD", "blueprint base64 is stripped of its data URL prefix");
  assert.equal(images[0].inlineData.mimeType, "image/png");
  assert.equal(images[1].inlineData.mimeType, "image/webp", "furniture mime type is preserved");
  assert.ok(
    content.some((p) => typeof p.text === "string" && p.text.includes("TOP-DOWN")),
    "the prompt text part is appended last",
  );
});

test("createCadHandling: folds an additional prompt into the request", async () => {
  const pngBuffer = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).png().toBuffer();

  const genAI = fakeGenAI(
    responseWithParts([
      { inlineData: { data: pngBuffer.toString("base64"), mimeType: "image/png" } },
    ]),
  );
  const { blueprintTo3D } = createCadHandling({ genAI });

  await blueprintTo3D("QUJD", {
    mimeType: "image/png",
    additionalPrompt: "  use a warm scandinavian palette  ",
  });

  const text = genAI.calls.contents[0].find((p) => p.text).text;
  assert.match(text, /ADDITIONAL REQUIREMENTS FROM USER/);
  assert.match(text, /use a warm scandinavian palette/);
  assert.ok(!text.includes("  use a warm"), "the extra prompt is trimmed");
});

// ── The two views ────────────────────────────────────────────────────────────
//
// The module used to render top-down ONLY — mandated five times in the prompt — while
// the welcome message, the homepage and all 11 language packs promised "a photorealistic,
// furnished render". These pin that both renders now exist and that eye-level does not
// inherit the top-down framing rules, which is the specific thing that would drag the
// output back toward being a picture of the blueprint.

/** A real PNG of the given size, so sharp can read dimensions off the "blueprint". */
const png = (width, height) => sharp({
  create: { width, height, channels: 3, background: { r: 8, g: 8, b: 8 } },
}).png().toBuffer();

/** Run one render against a fake client and hand back what it was asked for. */
async function renderWith(options, blueprint) {
  const out = await png(4, 4);
  const genAI = fakeGenAI(
    responseWithParts([{ inlineData: { data: out.toString("base64"), mimeType: "image/png" } }]),
  );
  const { blueprintTo3D } = createCadHandling({ genAI });
  await blueprintTo3D(blueprint ?? `data:image/png;base64,${(await png(600, 400)).toString("base64")}`, options);
  const content = genAI.calls.contents[0];
  return { genAI, prompt: content.find((p) => p.text).text };
}

test("view: an absent view still renders TOP-DOWN (a pre-`view` routing decision must not change behaviour)", async () => {
  const { prompt } = await renderWith({});
  assert.match(prompt, /THE OUTPUT MUST BE TOP-DOWN/);
  assert.doesNotMatch(prompt, /EYE-LEVEL INTERIOR PHOTOGRAPH/);
});

test("view: an unknown view falls back to top-down rather than throwing", async () => {
  // A render the user paid for must not fail on a routing field they never saw.
  const { prompt } = await renderWith({ view: "isometric" });
  assert.match(prompt, /THE OUTPUT MUST BE TOP-DOWN/);
});

test("view: 'eye-level' asks for an interior photograph and names the room", async () => {
  const { prompt } = await renderWith({ view: "eye-level", room: "living room" });
  assert.match(prompt, /EYE-LEVEL INTERIOR PHOTOGRAPH/);
  assert.match(prompt, /the living room/);
  assert.match(prompt, /eye height/);
  assert.doesNotMatch(prompt, /bird's eye view/, "must not ask for the overhead camera");
});

test("view: 'eye-level' does NOT inherit the top-down framing rules", async () => {
  // These two lines preserve the INPUT's frame. Correct when the output is another view
  // of the whole plan; wrong when it is a photograph taken inside it — left in, they pull
  // the render back toward the drawing it came from.
  const { prompt } = await renderWith({ view: "eye-level", room: "kitchen" });
  assert.doesNotMatch(prompt, /Preserve the full blueprint\/layout in frame/);
  assert.doesNotMatch(prompt, /Match the input image aspect ratio/);
});

test("view: both views carry the DIMENSIONS AND SCALING rules", async () => {
  // The shared core: without it the model invents a plausible room instead of rendering
  // THIS plan, which is the whole point of feeding it a blueprint.
  for (const view of ["top-down", "eye-level"]) {
    const { prompt } = await renderWith({ view, room: "bedroom" });
    assert.match(prompt, /DIMENSIONS AND SCALING/, `${view} keeps the scaling rules`);
    assert.match(prompt, /USE THE EXACT DIMENSIONS from the blueprint/, `${view} keeps the exact-dimensions rule`);
  }
});

test("view: 'eye-level' with no room falls back to the primary living space", async () => {
  const { prompt } = await renderWith({ view: "eye-level", room: null });
  assert.match(prompt, /primary living space/);
});

// ── Aspect-ratio pin ─────────────────────────────────────────────────────────
//
// There was no pin at all: the only control was the prose line "Match the input image
// aspect ratio", and a text instruction is not a control.

test("aspect: top-down pins to the BLUEPRINT's own ratio", async () => {
  const blueprint = `data:image/png;base64,${(await png(600, 400)).toString("base64")}`;
  const { genAI } = await renderWith({ view: "top-down" }, blueprint);
  assert.equal(genAI.calls.configs[0]?.generationConfig?.imageConfig?.aspectRatio, "3:2");
});

test("aspect: a TALL blueprint pins top-down to a TALL bucket", async () => {
  const blueprint = `data:image/png;base64,${(await png(400, 600)).toString("base64")}`;
  const { genAI } = await renderWith({ view: "top-down" }, blueprint);
  assert.equal(genAI.calls.configs[0]?.generationConfig?.imageConfig?.aspectRatio, "2:3");
});

test("aspect: eye-level pins to a PHOTOGRAPHIC ratio, not the plan's", async () => {
  // The regression this guards: a tall skinny floor plan producing a tall skinny
  // "interior photo". An eye-level render is a new photograph, so it gets 3:2 whatever
  // shape the drawing was.
  const blueprint = `data:image/png;base64,${(await png(400, 600)).toString("base64")}`;
  const { genAI } = await renderWith({ view: "eye-level", room: "den" }, blueprint);
  assert.equal(genAI.calls.configs[0]?.generationConfig?.imageConfig?.aspectRatio, "3:2");
});

test("aspect: an unreadable blueprint renders WITHOUT a pin instead of failing", async () => {
  // Fails open to the old behaviour — "QUJD" is not a decodable image.
  const { genAI } = await renderWith({ view: "top-down" }, "QUJD");
  assert.equal(genAI.calls.configs[0]?.generationConfig, undefined);
});

// ── Quality gate ─────────────────────────────────────────────────────────────

test("quality: a failed review is retried, and the retry is told what was wrong", async () => {
  const out = await png(4, 4);
  const genAI = fakeGenAI(
    responseWithParts([{ inlineData: { data: out.toString("base64"), mimeType: "image/png" } }]),
  );
  let call = 0;
  const reviewImageQuality = async () => (++call === 1
    ? { perfect: false, score: 40, reason: 'WHY: the sofa has three arms' }
    : { perfect: true, score: 95 });

  const { blueprintTo3D } = createCadHandling({ genAI, reviewImageQuality });
  await blueprintTo3D("QUJD", { view: "eye-level", room: "living room" });

  assert.equal(genAI.calls.contents.length, 2, "the failed review triggered exactly one retry");
  const retryPrompt = genAI.calls.contents[1].find((p) => p.text).text;
  assert.match(retryPrompt, /three arms/, "the retry targets the named defect, not a blind re-roll");
});

test("quality: the reviewer is told which view it is grading", async () => {
  // The reviewer's DEFAULT rubric grades interior photos, so an ungui­ded pass would fail
  // a CORRECT top-down render for having an overhead camera and no horizon.
  const out = await png(4, 4);
  const seen = [];
  const genAI = fakeGenAI(
    responseWithParts([{ inlineData: { data: out.toString("base64"), mimeType: "image/png" } }]),
  );
  const reviewImageQuality = async (_url, opts) => {
    seen.push(opts?.instruction || '');
    return { perfect: true, score: 100 };
  };
  const { blueprintTo3D } = createCadHandling({ genAI, reviewImageQuality });

  await blueprintTo3D("QUJD", { view: "top-down" });
  assert.match(seen[0], /overhead camera and the absence of a horizon are CORRECT/);

  await blueprintTo3D("QUJD", { view: "eye-level", room: "office" });
  assert.match(seen[1], /It is a DEFECT if it is a floor plan/);
});

test("quality: with no reviewer injected the render still ships (gate off, not broken)", async () => {
  const out = await png(4, 4);
  const genAI = fakeGenAI(
    responseWithParts([{ inlineData: { data: out.toString("base64"), mimeType: "image/png" } }]),
  );
  const { blueprintTo3D } = createCadHandling({ genAI });
  const result = await blueprintTo3D("QUJD", {});
  assert.ok(Buffer.isBuffer(result));
  assert.equal(genAI.calls.contents.length, 1, "no reviewer means no extra attempts");
});

// ── normalizeCadView ─────────────────────────────────────────────────────────
//
// The default lives at the CONSUMER, not in the routing schema, so a decision made
// before `view` existed keeps rendering the way it always did instead of failing on a
// field the user never saw.

test("normalizeCadView: keeps the two supported views and defaults everything else", () => {
  assert.equal(normalizeCadView("top-down"), "top-down");
  assert.equal(normalizeCadView("eye-level"), "eye-level");
  for (const bad of [undefined, null, "", "isometric", "TOP-DOWN", "eye level", 3, {}]) {
    assert.equal(
      normalizeCadView(/** @type {any} */ (bad)), DEFAULT_CAD_VIEW,
      `${JSON.stringify(bad)} falls back to the default`,
    );
  }
  assert.equal(DEFAULT_CAD_VIEW, "top-down");
});

// ── Delivery ─────────────────────────────────────────────────────────────────

test("delivery: the render is upscaled and shipped as WebP, like every staged render", async () => {
  // CAD output used to go out as the raw model PNG — no upscale, no format
  // normalization — so it was both lower-resolution and a bigger payload than a staged
  // photo produced by the same app.
  const native = await png(400, 300);
  const genAI = fakeGenAI(
    responseWithParts([{ inlineData: { data: native.toString("base64"), mimeType: "image/png" } }]),
  );
  const { blueprintTo3D } = createCadHandling({ genAI });

  const result = await blueprintTo3D("QUJD", {});
  const meta = await sharp(result).metadata();

  assert.equal(meta.format, "webp", "delivered as WebP, not the model PNG");
  assert.ok(meta.width > 400, `upscaled for delivery (got ${meta.width}px from a 400px native)`);
});

// ── Disclosure ───────────────────────────────────────────────────────────────
//
// CAD was the one render surface that never stamped, while staging, masking and
// exterior all do.

test("disclosure: an enabled stamp changes the delivered bytes", async () => {
  const native = await png(800, 600);
  const make = () => createCadHandling({
    genAI: fakeGenAI(responseWithParts([
      { inlineData: { data: native.toString("base64"), mimeType: "image/png" } },
    ])),
  }).blueprintTo3D;

  const plain = await make()("QUJD", {});
  const labelled = await make()("QUJD", {
    stamp: { enabled: true, lang: "english", style: "dark", scale: 1 },
  });

  assert.ok(!plain.equals(labelled), "the stamped render is not byte-identical to the plain one");
});

// ── onNative ─────────────────────────────────────────────────────────────────

test("onNative receives the model's own bytes, NOT the delivered upscale", async () => {
  // The gallery stores what this hook hands over. upscaleForDelivery is lanczos
  // interpolation, so storing the DELIVERED buffer costs several times the bytes for zero
  // extra detail — render-persistence.js makes that a rule, and the CAD path was breaking
  // it by persisting blueprintTo3D's return value.
  const native = await png(400, 300);
  const genAI = fakeGenAI(
    responseWithParts([{ inlineData: { data: native.toString("base64"), mimeType: "image/png" } }]),
  );
  const { blueprintTo3D } = createCadHandling({ genAI });

  let captured = null;
  const delivered = await blueprintTo3D("QUJD", { onNative: (b) => { captured = b; } });

  assert.ok(captured, "the hook fired");
  const nativeMeta = await sharp(captured).metadata();
  const deliveredMeta = await sharp(delivered).metadata();

  assert.equal(nativeMeta.width, 400, "the hook gets the model's own resolution");
  assert.equal(deliveredMeta.width, 800, "while the RETURN value is the upscaled delivery copy");
  assert.ok(captured.length < delivered.length, "and the native is the smaller of the two");
});

test("onNative gets the STAMPED bytes, so the stored master is labelled too", async () => {
  // Position matters: hooking before the stamp would leave the gallery master unlabelled,
  // and that master is the copy someone re-downloads months later and publishes.
  const native = await png(800, 600);
  const run = async (stamp) => {
    const genAI = fakeGenAI(responseWithParts([
      { inlineData: { data: native.toString("base64"), mimeType: "image/png" } },
    ]));
    let captured = null;
    await createCadHandling({ genAI }).blueprintTo3D("QUJD", { stamp, onNative: (b) => { captured = b; } });
    return captured;
  };

  const plain = await run(null);
  const labelled = await run({ enabled: true, lang: "english", style: "dark", scale: 1 });
  assert.ok(!plain.equals(labelled), "the native handed to the gallery carries the disclosure");
});

test("a throwing onNative does not fail the render", async () => {
  // A history feature must never be able to turn a paid render into an error.
  const native = await png(4, 4);
  const genAI = fakeGenAI(
    responseWithParts([{ inlineData: { data: native.toString("base64"), mimeType: "image/png" } }]),
  );
  const { blueprintTo3D } = createCadHandling({ genAI });

  const result = await blueprintTo3D("QUJD", {
    onNative: () => { throw new Error('gallery exploded'); },
  });
  assert.ok(Buffer.isBuffer(result), "the render still came back");
});

test("disclosure: stamp {enabled:false} leaves the image alone", async () => {
  const native = await png(800, 600);
  const make = () => createCadHandling({
    genAI: fakeGenAI(responseWithParts([
      { inlineData: { data: native.toString("base64"), mimeType: "image/png" } },
    ])),
  }).blueprintTo3D;

  const plain = await make()("QUJD", {});
  const off = await make()("QUJD", { stamp: { enabled: false, lang: "english", style: "dark", scale: 1 } });

  assert.ok(plain.equals(off), "a disabled stamp must not touch the image");
});

// ── Failure propagation ──────────────────────────────────────────────────────

test("a model error is rethrown, not swallowed into a blank render", async () => {
  // The dispatch turns a throw into a user-facing apology. Swallowing it here would
  // instead produce "Here is your render!" with nothing attached — the exact silent
  // failure this pass set out to remove.
  const genAI = {
    getGenerativeModel: () => ({
      generateContent: async () => { throw new Error("upstream exploded"); },
    }),
  };
  const { blueprintTo3D } = createCadHandling({ genAI });
  await assert.rejects(() => blueprintTo3D("QUJD", {}), /upstream exploded/);
});

test("a text-only response is rethrown after the retries are spent", async () => {
  // parseGeminiResponse throws inside the retry loop, and the loop re-enters on a throw,
  // so the caller sees the failure only once every attempt is gone.
  const genAI = fakeGenAI(responseWithParts([{ text: "I cannot generate images." }]));
  const { blueprintTo3D } = createCadHandling({ genAI });

  await assert.rejects(() => blueprintTo3D("QUJD", {}), /text instead of an image/);
  assert.equal(genAI.calls.contents.length, 3, "all three attempts were spent before giving up");
});
