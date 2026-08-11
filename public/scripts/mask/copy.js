// The mask editor's phase copy — the strings both editors show when they swap
// between the draw and refine phases.
//
// These were duplicated verbatim across the two editors: six keys and 525
// characters of English fallback, byte-identical on both sides, including a
// 369-character paragraph explaining what the refine step does. The phase
// machines themselves are NOT shared (they are mostly DOM toggling, and folding
// them together would cost about as many lines of configuration as it saved) —
// but the copy is pure data with no per-editor variation, so it lives here.
//
// These are FALLBACKS. The translated strings come from the language packs via
// the injected `lang(key, fallback)`; a fallback only surfaces before the pack
// has loaded. That makes drift here low-severity but also completely pointless
// to risk — there is no reason for the same paragraph to exist twice.

const REFINE_HELP =
  "This step just fine-tunes where the AI’s change shows — it doesn’t run the AI again. " +
  'Brush to reveal more of the edit, erase to pull it back. ' +
  "It’s a safety net so the edit only touches the area you picked and can’t mess up the rest of your photo. " +
  'The faded preview shown on top is only there so you can see the full edit while refining — ' +
  "it won’t be in the final image.";

const REFINE_NOTE =
  "Brush to reveal more of the edit, erase to hide it — this only re-crops, it won’t re-run the AI.";

/**
 * Resolve the phase copy through the caller's i18n lookup.
 * @param {(key: string, fallback: string) => string} lang - Translator, called
 *   with the key and the English fallback.
 * @returns {{ title: string, rerun: string, done: string, refineTitle: string, refineHelp: string, refineHelpAria: string, refineNote: string }}
 */
export function maskCopy(lang) {
  return {
    // Draw-phase dialog title. The stage editor overrides this in "before" mode
    // (it is editing the original photo, not a staged result), so it reaches for
    // this one only in "after" mode.
    title: lang('pdf.maskEditor.title', 'Edit with Mask'),
    rerun: lang('pdf.maskEditor.rerun', 'Regenerate'),
    done: lang('pdf.maskEditor.done', 'Looks good'),
    refineTitle: lang('pdf.maskEditor.refineTitle', 'Refine the edit'),
    refineHelp: lang('pdf.maskEditor.refineHelp', REFINE_HELP),
    refineHelpAria: lang('pdf.maskEditor.refineHelpAria', 'What the refine step does'),
    refineNote: lang('pdf.maskEditor.refineNote', REFINE_NOTE),
  };
}
