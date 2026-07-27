// Custom select component for the main Stagify tool (scripts/app.js).
//
// Plain exported function — no app state. Each call wires one .custom-select
// root (trigger, menu, options) and returns a { value, set } handle; a missing
// root yields a no-op handle so pages without the stage modal keep working.

export function initCustomSelect(rootSelector) {
      const root = document.querySelector(rootSelector);
      if (!root) return { get value() { return ''; } };
      const trigger = root.querySelector('.select-trigger');
      const menu = root.querySelector('.select-menu');
      const valueEl = root.querySelector('.select-value');
      const options = Array.from(root.querySelectorAll('.option'));
      function setValue(val) {
        root.dataset.value = val;
        const opt = options.find(o => o.dataset.value === val);
        // An option may carry trailing chrome (e.g. the "New" badge on Dorm). When it
        // does, the label lives in its own .option-label span — read that, or the whole
        // option's text would land in the trigger as "DormNew".
        const labelEl = opt?.querySelector('.option-label') || opt;
        valueEl.textContent = labelEl?.textContent?.trim() || val;
        // Carry the label's i18n key onto the trigger too. Without this the trigger keeps
        // whichever key it was authored with, so switching language after choosing a room
        // would re-render the trigger as the default room instead of the selected one.
        const langKey = labelEl?.getAttribute?.('data-lang');
        if (langKey) valueEl.setAttribute('data-lang', langKey);
        options.forEach(o => o.classList.toggle('selected', o.dataset.value === val));
        menu.classList.add('hidden');
      }
      trigger.addEventListener('click', () => {
        menu.classList.toggle('hidden');
      });
      options.forEach(o => {
        o.addEventListener('click', () => setValue(o.dataset.value));
      });
      document.addEventListener('click', (e) => {
        if (!root.contains(e.target)) menu.classList.add('hidden');
      });
      return {
        get value() { return root.dataset.value; },
        set(value) { setValue(value); }
      };
}
