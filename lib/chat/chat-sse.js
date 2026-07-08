// Server-sent-events helpers for streamed chat responses, plus the request
// predicate that decides whether to stream. Extracted verbatim from server.js.

export function wantsStreamedChatResponse(req) {
  const body = req.body || {};
  return (
    body.streamResponse === true ||
    body.streamResponse === 'true' ||
    req.query?.stream === '1' ||
    req.headers['x-stream-response'] === '1'
  );
}

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

export function writeChatSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

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

export function finishStreamedChatResponse(res, fullResponse) {
  writeChatSseEvent(res, 'images', extractChatImagePayload(fullResponse));
  writeChatSseEvent(res, 'done', {});
  res.end();
}
