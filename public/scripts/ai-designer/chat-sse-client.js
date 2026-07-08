// SSE (Server-Sent Events) stream parser for the AI Designer chat transport.
//
// Pure protocol logic: it takes a fetch Response whose body is an event-stream
// and a `handlers` object, decodes the byte stream, splits it into `\n\n`-
// delimited event blocks, parses each `event:` / `data:` pair, and dispatches
// to the matching handler. No DOM, no app state — the only inputs are the
// response and the callbacks, so it is unit-testable under node --test with a
// fake reader (see test/ai-designer-chat-sse-client.test.js). The browser entry
// wires the handlers to its DOM-rendering functions.
//
// handlers: { onStatus, onMessage, onImages, onError } — each optional, called
// with the parsed JSON payload for events named status/message/images/error.
export async function consumeChatSse(response, handlers) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let splitAt;
    while ((splitAt = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);
      let eventName = 'message';
      let dataLine = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) eventName = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLine = line.slice(6);
      }
      if (!dataLine) continue;
      const payload = JSON.parse(dataLine);
      if (eventName === 'status' && handlers.onStatus) handlers.onStatus(payload);
      else if (eventName === 'message' && handlers.onMessage) handlers.onMessage(payload);
      else if (eventName === 'images' && handlers.onImages) handlers.onImages(payload);
      else if (eventName === 'error' && handlers.onError) handlers.onError(payload);
    }
  }
}
