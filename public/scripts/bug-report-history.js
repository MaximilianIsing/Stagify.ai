// Transcript summariser for /api/bug-report, shared by the app's TWO report paths:
// the AI Designer's bug button (the classic ai-designer-model-selector.js, which
// reaches this through the `window.summariseBugReportHistory` bridge that
// ai-designer-app.js installs) and the account menu's "Report an issue" dialog
// (profile-menu/report-issue-modal.js, which imports it directly).
//
// WHY IT EXISTS AT ALL: a bug report carries the chat transcript for context, but
// the transcript's image entries hold whole base64 data URLs — megabytes each — and
// the server never keeps those bytes: bug_reports.csv stores only a per-message
// image COUNT (lib/http/bug-report-row.js). Shipping them bought nothing and pushed
// the body past the 1MB JSON limit, so the report came back 413 exactly when the
// user needed the channel.
//
// The rebuild keeps text parts verbatim and reduces every other content item to its
// bare type tag, which leaves the recorded image count — and the whole stored row —
// byte-identical to what the raw transcript would have produced. That equivalence is
// the contract test/frontend/ai-designer/bug-report-history.test.js pins.

/**
 * Strip image bytes out of a chat transcript, preserving everything the server
 * actually records.
 *
 * @param {any} history - The live transcript, or anything at all: a non-array
 *   degrades to `[]` rather than throwing, because a thrown summariser would lose
 *   the entire report.
 * @returns {Array<{ role: string, content: any }>} A transcript safe to POST.
 */
export function summariseBugReportHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.map(function (message) {
    const entry = message || {};
    const role = entry.role || 'unknown';
    const content = entry.content;
    if (Array.isArray(content)) {
      return {
        role: role,
        content: content.map(function (item) {
          const part = item || {};
          return part.type === 'text'
            ? { type: 'text', text: String(part.text == null ? '' : part.text) }
            : { type: part.type };
        }),
      };
    }
    // Non-array content is flattened with String() server-side anyway, so doing
    // it here keeps the stored row byte-identical while making it impossible for
    // an object-shaped content to smuggle image bytes onto the wire.
    return { role: role, content: String(content == null ? '' : content) };
  });
}

/**
 * The live AI Designer transcript, or `[]` on any page that has none.
 *
 * ai-designer-app.js is a `<script type="module">`, so its `conversationHistory`
 * binding is invisible to anything that does not import it; the accessor is the
 * only supported way in, and it is absent everywhere except the studio. Every
 * caller must degrade to an empty transcript rather than fail the report.
 *
 * @returns {any[]} The transcript, newest last.
 */
export function readBugReportHistory() {
  const accessor = window.getConversationHistory;
  return typeof accessor === 'function' ? summariseBugReportHistory(accessor()) : [];
}
