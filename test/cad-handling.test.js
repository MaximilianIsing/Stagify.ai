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
//
// We also cover the two PRE-PROXY branches of POST /api/process-pdf via the shared
// mountStaging DI harness. process-pdf is an HTTPS proxy to an external PDF server;
// it never calls blueprintTo3D. Only the auth gate (401) and the missing-file guard
// (400) are reachable without hitting the network, so those are the only two paths
// asserted here — the streaming/success path would contact a real server and is left
// untouched by design.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  parseGeminiResponse,
  getMimeType,
  extractBase64,
} from "../lib/staging/cad-handling.js";
import { mountStaging } from "./helpers/staging-app.js";

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

// ── POST /api/process-pdf (pre-proxy branches only) ──────────────────────────

let app;
afterEach(async () => { if (app) { await app.close(); app = null; } });

test("process-pdf: rejects an unauthenticated request with 401 AUTH_REQUIRED", async () => {
  // Default baseDeps.requireProAccount sends 401 and returns null before any proxy.
  app = await mountStaging({});
  const res = await fetch(`${app.baseUrl}/api/process-pdf`, { method: "POST" });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "AUTH_REQUIRED");
});

test("process-pdf: returns 400 'No PDF file provided' when a pro user uploads no file", async () => {
  // requireProAccount truthy → past the auth gate; pdfUpload.single is a pass-through
  // (baseDeps), so req.file stays undefined and the missing-file guard fires. No proxy.
  app = await mountStaging({ requireProAccount: () => ({ id: "u1", plan: "pro" }) });
  const res = await fetch(`${app.baseUrl}/api/process-pdf`, { method: "POST" });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "No PDF file provided" });
});
