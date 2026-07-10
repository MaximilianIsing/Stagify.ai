// Server-sent-events helpers for streamed chat responses, plus the request
// predicate that decides whether to stream. Extracted verbatim from server.js.

/**
 * Decide whether the client opted into SSE streaming for a chat response.
 * @param {import('express').Request} req - Request; checks body.streamResponse (bool/'true'), query.stream==='1', header x-stream-response==='1'.
 * @returns {boolean} Whether the client opted into SSE streaming.
 */
export function wantsStreamedChatResponse(req) {
  const body = req.body || {};
  return (
    body.streamResponse === true ||
    body.streamResponse === 'true' ||
    req.query?.stream === '1' ||
    req.headers['x-stream-response'] === '1'
  );
}

/**
 * Switch a response into text/event-stream mode for SSE streaming.
 * @param {import('express').Response} res - Response to switch into text/event-stream mode.
 * @returns {void} Sets status 200 and SSE headers; flushHeaders() when available.
 */
export function initChatSse(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
}

/**
 * Write a single SSE frame (one `event:` line and one `data:` line) to the response.
 * @param {import('express').Response} res - Active SSE response.
 * @param {string} event - SSE event name (e.g. 'status','message','images','done','error').
 * @param {unknown} payload - JSON-serializable payload written on the data line.
 * @returns {void} Writes one `event:`/`data:` SSE frame.
 */
export function writeChatSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Build the streamed `images` event payload from an assembled designer response.
 * Copies a fixed whitelist of image/annotation/file keys that are present.
 * @param {import('../types/chat.js').DesignerResponse} fullResponse - Assembled response body from buildDesignerResponse.
 * @returns {Record<string, any>} { response } plus only the whitelisted image/annotation/file keys that are present.
 */
export function extractChatImagePayload(fullResponse) {
  const payload = { response: fullResponse.response };
  const keys = [
    'stagedImage',
    'stagedImages',
    'stagingParams',
    'stagedImageAnnotations',
    'generatedImage',
    'generatedImages',
    'generatedImageAnnotations',
    'cadImage',
    'cadImages',
    'cadParams',
    'cadImageAnnotation',
    'cadImageAnnotations',
    'requestedImage',
    'recalledImage',
    'imageAnnotations',
    'files',
  ];
  for (const key of keys) {
    if (fullResponse[key] !== undefined) {
      payload[key] = fullResponse[key];
    }
  }
  return payload;
}

/**
 * Emit the final `images` and `done` SSE events and end the response.
 * @param {import('express').Response} res - Active SSE response.
 * @param {import('../types/chat.js').DesignerResponse} fullResponse - Assembled response body.
 * @returns {void} Emits the 'images' then 'done' events and calls res.end().
 */
export function finishStreamedChatResponse(res, fullResponse) {
  writeChatSseEvent(res, 'images', extractChatImagePayload(fullResponse));
  writeChatSseEvent(res, 'done', {});
  res.end();
}
