// Scriptable fake AI clients for pipeline tests — canned responses only. No network,
// no keys, no cost. Shaped to match how the routes actually call the SDKs.

// Fake Gemini `genAI`. `responses` is a string or an array of strings (one per
// generateContent call; the last entry repeats for extra calls, e.g. the segment
// retry). Each string is returned as `response.text()`, matching routes/staging.js.
export function fakeGenAI(responses) {
  const seq = Array.isArray(responses) ? responses.slice() : [responses];
  let calls = 0;
  return {
    getGenerativeModel() {
      return {
        async generateContent() {
          const text = seq[Math.min(calls, seq.length - 1)];
          calls += 1;
          return { response: { text: () => String(text) } };
        },
      };
    },
    get callCount() { return calls; },
  };
}
