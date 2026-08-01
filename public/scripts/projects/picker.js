// The listings picker in the left panel.
//
// WHY IT IS ITS OWN MODULE. It used to be six lines in the entry that rendered title +
// address and nothing else — so a photographer with twenty listings saw twenty near-identical
// rows and had to open them one at a time to find the shoot they were mid-way through. The
// row now carries the date, the photo count when the server sends one, and a real status
// badge. That is enough markup and enough judgement to be worth reading on its own.
//
// createElement + textContent throughout; the operator's own listing titles flow through
// here, so there is deliberately no HTML-string sink to escape.

import { pickerMeta, projectBadge } from './summaries.js';

/**
 * @typedef {import('./state.js').PjProject} PjProject
 */

/**
 * A short, human label for a listing.
 * @param {{ title?: string, address?: string }} project
 * @returns {string}
 */
export function projectLabel(project) {
  const title = (project && project.title ? String(project.title) : '').trim();
  const address = (project && project.address ? String(project.address) : '').trim();
  if (title && address) return `${title} — ${address}`;
  return title || address || 'Untitled listing';
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Draw the picker.
 * @param {{
 *   root: HTMLElement,
 *   projects: PjProject[],
 *   currentId: string,
 *   onOpen: (id: string) => void,
 * }} args - The <ul>, the listings, the open listing's id (for the current marker), and
 *   the open callback.
 * @returns {void}
 */
export function drawPicker(args) {
  const { root, projects, currentId, onOpen } = args;
  root.textContent = '';
  if (!projects.length) {
    root.appendChild(el('li', 'pj-picker__empty', 'No listings yet.'));
    return;
  }
  for (const project of projects) {
    const item = el('li');
    const button = /** @type {HTMLButtonElement} */ (el('button', 'pj-picker__btn'));
    button.type = 'button';
    button.appendChild(el('span', 'pj-picker__title', projectLabel(project)));

    const badge = projectBadge(project);
    const chip = el('span', `pj-picker__badge pj-picker__badge--${badge.tone}`, badge.text);
    button.appendChild(chip);

    const meta = pickerMeta(project);
    // Omitted rather than rendered empty: a blank line under every row would put the badge
    // and the title back to looking identical, which is the problem being fixed.
    if (meta) button.appendChild(el('span', 'pj-picker__meta', meta));

    if (currentId && currentId === project.id) {
      button.classList.add('is-current');
      button.setAttribute('aria-current', 'true');
    }
    button.addEventListener('click', () => onOpen(project.id));
    item.appendChild(button);
    root.appendChild(item);
  }
}
