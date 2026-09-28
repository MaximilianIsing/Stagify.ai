// Stylelint config. Run by `npm run lint` alongside ESLint, so it gates CI the same way.
//
// stylelint-config-recommended only: it flags things that are likely BUGS (invalid syntax,
// unknown properties, duplicate selectors, deprecated properties), not formatting. It found
// a real one on day one: a comment in home.css closed early, the stray prose became the
// selector of the next rule, and `.whyus-board` was silently dropped by every browser.
//
// Inline <style> blocks in HTML are linted too, through postcss-html.

export default {
  extends: ['stylelint-config-recommended'],
  ignoreFiles: [
    'node_modules/**',
    'ds-bundle/**',
    'supademo-local/**',
    '**/vendor/**',
    '**/*.min.css',
  ],
  overrides: [
    {
      files: ['**/*.html'],
      customSyntax: 'postcss-html',
    },
  ],
  rules: {
    // Off: it compares every pair of selectors that COULD match the same element in source
    // order, so a stylesheet organised by component rather than by specificity trips it
    // hundreds of times (200 on the first run) with almost no real cascade bugs among them.
    'no-descending-specificity': null,
    // `clip` is still the portable half of the visually-hidden (.sr-only) pattern.
    'property-no-deprecated': [true, { ignoreProperties: ['clip'] }],
    // A viewport-unit fallback (100vh, then 100dvh) is two consecutive declarations of one
    // property on purpose; the older browser keeps the first.
    'declaration-block-no-duplicate-properties': [
      true,
      { ignore: ['consecutive-duplicates-with-different-values'] },
    ],
  },
};
