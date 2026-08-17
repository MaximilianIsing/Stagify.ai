// Pure formatting / string helpers for the AI Designer chat UI.
//
// HTML escaping lives in the shared `scripts/escape-html.js`, not here.
//
// No DOM, no window, no i18n, no app state — every function is a deterministic
// transform on its arguments, so these are unit-testable under `node --test`
// with zero shim (see test/frontend/ai-designer/ai-designer-format.test.js). The browser entry
// (scripts/ai-designer-app.js) imports these; each was lifted verbatim from
// that file so behaviour is identical.

import { escapeHtml } from '../escape-html.js';

// Human-readable byte size (e.g. 1536 -> "1.5 KB").
export function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// " (n)" suffix used to number multiple images; empty when there is only one.
export function imageCountSuffix(index, total) {
  return total > 1 ? ` (${index + 1})` : '';
}

// Escape HTML so model/user text can never inject markup — the shared escaper,
// re-exported here because this module's consumers import it from `format.js`.
// It also escapes quotes now (this file's own copy did not); in the text context
// these strings land in, `&quot;`/`&#39;` render as the plain characters, so what
// the user sees is unchanged.
export { escapeHtml };

// Apply inline **bold** / *italic* to text that is ALREADY html-escaped.
export function applyInlineFormatting(escaped) {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
}

// Render a small markdown subset (bullet lists + inline bold/italic + line
// breaks) to an HTML string. Escapes FIRST, then adds our own tags, so model
// or user text can never inject raw HTML.
export function formatMarkdown(text) {
  if (!text) return '';

  // Split into lines for processing
  const lines = text.split('\n');
  let html = '';
  let inList = false;

  lines.forEach((line, index) => {
    // Check for bullet points: * item, - item, or • item
    const bulletMatch = line.match(/^[*\-+•]\s+(.+)$/);

    if (bulletMatch) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      // Escape FIRST, then add our own formatting tags — without this,
      // list items render raw HTML from the model/user (injection hole).
      const itemText = applyInlineFormatting(escapeHtml(bulletMatch[1]));
      html += `<li>${itemText}</li>`;
    } else {
      if (inList) {
        html += '</ul>';
        inList = false;
      }

      if (line.trim()) {
        html += applyInlineFormatting(escapeHtml(line));
      }

      // Add line break if not last line
      if (index < lines.length - 1) {
        html += '<br>';
      }
    }
  });

  if (inList) {
    html += '</ul>';
  }

  return html;
}

// Filename without its extension, trimmed; null when there is nothing usable.
export function getFileStem(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const base = filename.replace(/\.[^.]+$/, '').trim();
  return base || null;
}

// Clamp a thumbnail label to 22 chars with an ellipsis; "Upload" when empty.
export function truncateThumbnailStem(stem) {
  if (!stem) return 'Upload';
  if (stem.length <= 22) return stem;
  return `${stem.slice(0, 20)}…`;
}

// Filename-safe slug for downloads (e.g. "Main Living.png" -> "main-living").
export function slugifyName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\.[^.]+$/, '')          // drop any extension
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'image';
}

// Map the user's selected message tag to a loading-status category. This
// replaces the old English-keyword guessing (which never worked for ES/ZH
// or paraphrased requests). "auto" stays generic until the server tells us.
export function messageTypeFromTag(tag) {
  switch (tag) {
    case 'generate': return 'generating';
    case 'stage': return 'staging';
    // Its own category, not 'staging': a floor-plan render is a ~30s Pro-model call, and
    // "staging your room…" described neither the work nor the wait.
    case 'cad-stage': return 'floorplan';
    case 'describe': return 'analyzing';
    default: return 'general';
  }
}
