// developers.html's only script: fill the pricing grid from the live pack table.
//
// The rest of that page is static prose, which is the point — documentation that needs
// JavaScript to be readable is documentation that is sometimes not readable. Only the
// prices are dynamic, because they are the one thing that must never disagree with what
// checkout actually charges (see api-keys/credit-packs.js).

import { loadPacks, renderPacks } from './api-keys/credit-packs.js';

const host = document.getElementById('dev-packs');
if (host) {
  // No buy buttons here: purchasing needs an account, and the page's CTA already sends
  // people to api-keys.html where the same cards appear with a Buy button.
  void loadPacks().then((packs) => {
    renderPacks(host, packs, { buyable: false });
    // The cards arrive from a fetch, which means AFTER language-loader.js has already
    // walked the document — so the `data-lang` nodes inside them ("images", "an image",
    // and the empty state) would be left in English on a localized URL. Re-apply over
    // the freshly inserted markup. Optional-chained because the loader is a separate
    // module: if it has not finished booting, the cards stay English rather than
    // throwing and taking the pricing grid down with them.
    window.LanguageSystem?.applyLanguageToElements?.();
  });
}
