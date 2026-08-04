// Every tile in the gallery grid is the same shape.
//
// WHAT THIS COVERS
// renderGrid used to set `--gal-ar` on each card from the render's own width/height, and
// gallery.css read it as `aspect-ratio: var(--gal-ar, 3 / 2)`. So the grid drew each
// thumbnail in whichever ratio the agent's camera produced — a 3:2 DSLR frame beside a 4:3
// phone frame beside a portrait — and because grid rows top-align, the short cards left a
// band of dead space beneath them. A wall of photographs that do not line up reads as a
// broken page, which is the opposite of what a gallery is for.
//
// The fix is one ratio for all of them, cropped with object-fit, and the uncropped render
// one click away in the detail panel. Both halves of that are guarded here, because either
// one alone silently restores the ragged grid: put the per-card property back and the CSS
// var wins again; put the var back in the CSS and the property is waiting for it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderGrid } from '../../../public/scripts/gallery/view.js';
import { galleryDocument } from '../../helpers/gallery-dom.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'gallery.css'), 'utf8');

/** Renders in three different shapes — landscape, phone, portrait — as a real page has. */
const MIXED = [
  { id: 'a', createdAt: Date.UTC(2026, 7, 1), roomType: 'Living Room', width: 1536, height: 1024, urls: { after: '/a.webp', thumb: '/at.webp' } },
  { id: 'b', createdAt: Date.UTC(2026, 7, 1), roomType: 'Kitchen', width: 1024, height: 768, urls: { after: '/b.webp', thumb: '/bt.webp' } },
  { id: 'c', createdAt: Date.UTC(2026, 7, 1), roomType: 'Bedroom', width: 768, height: 1024, urls: { after: '/c.webp', thumb: '/ct.webp' } },
];

/** The CSS block for one selector, comments stripped — a comment naming a declaration is
 *  not that declaration, and this guard would otherwise pass on the fix's own prose. */
function ruleFor(selector) {
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const match = new RegExp(`(^|})\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)}`, 'm').exec(bare);
  assert.ok(match, `${selector} is gone from gallery.css`);
  return match[2];
}

test('a card is not sized to its own photo, whatever shape the render was', () => {
  const { document, byId } = galleryDocument();
  const built = renderGrid({ grid: byId('gal-grid'), entries: MIXED, doc: document, onOpen: () => {} });

  assert.equal(built.length, 3);
  for (const [i, card] of built.entries()) {
    assert.deepEqual(
      card.style.props,
      {},
      `card ${i} carries an inline style; a per-card aspect ratio is what made the grid ragged`,
    );
  }
});

test('the tile ratio is a literal in the sheet, not a variable a card can override', () => {
  const rule = ruleFor('.gal-card__img');
  const ratio = /aspect-ratio:\s*([^;]+);/.exec(rule);
  assert.ok(ratio, '.gal-card__img has no aspect-ratio, so tiles fall back to the photo');
  assert.doesNotMatch(
    ratio[1],
    /var\(/,
    'a custom property here re-opens the per-card override the grid was ragged from',
  );
  assert.match(ratio[1].trim(), /^\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?$/);
  assert.match(rule, /object-fit:\s*cover/, 'without cover a pinned ratio distorts the photo');
});

test('the detail panel still shows the render in its own shape', () => {
  // The crop is acceptable on a thumbnail only because it is undone one click away. If
  // .gal-compare ever pins a ratio too, the uncropped view is gone from the product.
  const rule = ruleFor('.gal-compare');
  assert.doesNotMatch(rule, /aspect-ratio/, 'the before/after must keep the photo\'s own shape');
});
