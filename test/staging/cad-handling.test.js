// Tier: pure helpers (no AI) — unit coverage for lib/cad-handling.js's newly
// extracted seam: parseGeminiResponse, getMimeType, extractBase64.
//
// WHY NO REAL API CALL: blueprintTo3D() is the only function in the module that
// talks to Gemini (it reads an API key, builds a GoogleGenerativeAI client, and
// awaits model.generateContent). We deliberately do NOT exercise that path. The
// three helpers under test are pure functions that were exported precisely so the
// response-parsing branch ladder and the mime/base64 utilities can be verified with
// hand-built inputs — a fake `result.response`-shaped object, plain strings, and
// Buffers — without any network, key, or model dependency. Image fixtures that must
// survive a real base64 round-trip through Buffer are built locally with sharp.

import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  createCadHandling,
  parseGeminiResponse,
  getMimeType,
  extractBase64,
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
function fakeGenAI(response) {
  const calls = { models: [], contents: [] };
  return {
    calls,
    getGenerativeModel({ model }) {
      calls.models.push(model);
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

  await blueprintTo3D("data:image/png;base64,QUJD", null, [
    { image: "data:image/webp;base64,REVG", mimeType: "image/webp" },
  ]);

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

  await blueprintTo3D("QUJD", "image/png", [], "  use a warm scandinavian palette  ");

  const text = genAI.calls.contents[0].find((p) => p.text).text;
  assert.match(text, /ADDITIONAL REQUIREMENTS FROM USER/);
  assert.match(text, /use a warm scandinavian palette/);
  assert.ok(!text.includes("  use a warm"), "the extra prompt is trimmed");
});
