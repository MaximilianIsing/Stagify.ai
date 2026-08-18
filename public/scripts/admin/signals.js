// The Signals tab: renders what findings.js decided, and nothing more.
//
// This file makes no judgements. Every threshold, every severity and every
// sentence comes out of the rules engine, which is pure and unit-tested; the
// division exists so that "what the dashboard says" can be tested without a DOM
// and "how it looks" can change without touching a threshold.
//
// TWO THINGS HERE ARE LOAD-BEARING RATHER THAN DECORATIVE
//
// 1. **The empty state is never "all clear".** `runFindings` always returns
//    something when it could not check — the suppression roll-up is itself a
//    finding — so this file has no "nothing to report" branch to get wrong. If
//    the list is genuinely empty, that means every rule declined, which is worth
//    the same honest sentence.
// 2. **Account names are rendered with textContent, from `finding.accounts`.**
//    They are user-supplied and they are PII. They never go through innerHTML,
//    and they are never sent to the brief endpoint — lib/services/admin-brief.js
//    drops the field, and test/frontend/admin/admin-findings.test.js separately
//    asserts no rule puts an address into its prose.
//
// THE BRIEF IS ON DEMAND, NEVER ON LOAD. It costs a metered model call, so it
// fires only when the operator presses the button, and the result is cached on
// `ctx` for the session. A refresh of the dashboard clears it (admin.js), which
// is right — a brief written about last hour's numbers should not sit above this
// hour's findings.

import { qs, el } from './helpers.js';
import { runFindings, SEVERITY_SECTIONS, ACTIONABLE } from './findings.js';
import { activityIndexFrom } from './analytics-users.js';
import { stripHeader } from './analytics.js';
import { areaChart } from './charts.js';

/** Cards in this grid give a chart ~340 CSS px, so it must draw into a matching
 *  viewBox — the full-width default would scale its axis labels to ~4px. Same
 *  reason insights.js carries CARD_VB_W. */
const CARD_VB_W = 380;

/** How many findings the Overview teaser shows above the stat cards. */
const TEASER_LIMIT = 3;

/**
 * @param {object} deps
 * @param {{data: any, signalsBrief?: any, signalsResult?: ReturnType<typeof runFindings>|null}} deps.ctx
 *   Shared dashboard state. `signalsResult` memoizes one run of the engine per
 *   data load; `signalsBrief` caches the written brief for the session.
 * @param {(url: string, method: string, body?: any, isForm?: boolean) => Promise<any>} deps.apiSend Mutating request helper.
 * @param {(u: any) => string} deps.effectivePlan Plan resolver that folds in enterprise domains.
 */
export function createSignals({ ctx, apiSend, effectivePlan }) {
  /** Assemble the bag the rules engine reads. Header stripping happens once, here. */
  function buildInput() {
    const promptRows = stripHeader(ctx.data.promptRows || []);
    return {
      now: Date.now(),
      promptRows,
      contactRows: stripHeader(ctx.data.contactRows || []),
      users: ctx.data.users || [],
      enterprise: ctx.data.enterprise || [],
      metrics: ctx.data.metrics || null,
      index: activityIndexFrom({
        promptRows: ctx.data.promptRows || [],
        chatRows: ctx.data.chatRows || [],
        maskRows: ctx.data.maskRows || [],
      }),
      effectivePlan,
    };
  }

  /** Cached per render pass so the teaser and the tab cannot disagree. */
  function currentResult() {
    if (!ctx.signalsResult) ctx.signalsResult = runFindings(buildInput());
    return ctx.signalsResult;
  }

  // ── Card pieces ───────────────────────────────────────────────────────────

  function severityPill(severity) {
    return el('span', { className: `adm-sig-pill adm-sig-pill--${severity}`, textContent: severity });
  }

  function evidenceRow(evidence) {
    const wrap = el('div', { className: 'adm-sig-evidence' });
    evidence.forEach((e) => {
      wrap.appendChild(el('div', { className: 'adm-sig-ev' }, [
        el('span', { className: 'adm-sig-ev-label', textContent: e.label }),
        el('span', { className: 'adm-sig-ev-value', textContent: e.value }),
      ]));
    });
    return wrap;
  }

  /**
   * The named-accounts list.
   *
   * Every value here is user-supplied, so it goes in through textContent. This is
   * also the only place on the tab where an email is rendered at all — see the
   * note at the top of the file.
   */
  function accountList(accounts) {
    const wrap = el('div', { className: 'adm-sig-accounts' });
    accounts.forEach((a) => {
      wrap.appendChild(el('div', { className: 'adm-sig-account' }, [
        el('span', { className: 'adm-sig-account-email', textContent: a.email || a.id }),
        el('span', { className: 'adm-sig-account-note', textContent: a.note }),
      ]));
    });
    return wrap;
  }

  function findingCard(f) {
    const card = el('article', { className: `adm-card adm-sig-card adm-sig-card--${f.severity}` });

    card.appendChild(el('div', { className: 'adm-sig-head' }, [
      severityPill(f.severity),
      el('span', { className: 'adm-sig-area', textContent: f.area }),
      el('span', { className: 'adm-sig-confidence', textContent: `${f.confidence} confidence` }),
    ]));

    card.appendChild(el('h3', { className: 'adm-sig-title', textContent: f.title }));
    if (f.detail) card.appendChild(el('p', { className: 'adm-sig-detail', textContent: f.detail }));
    if (f.evidence.length) card.appendChild(evidenceRow(f.evidence));

    // An evidence chart where the rule supplied a series. Optional by design:
    // most findings are a comparison of two numbers, and a chart of two numbers
    // is worse than the numbers.
    if (f.series && f.series.points && f.series.points.length > 1) {
      card.appendChild(el('div', { className: 'adm-sig-chart' }, [
        areaChart(f.series.points, { width: CARD_VB_W, height: 120, unit: f.series.unit, maxLabels: 4 }),
      ]));
    }

    if (f.accounts && f.accounts.length) card.appendChild(accountList(f.accounts));

    card.appendChild(el('div', { className: 'adm-sig-action' }, [
      el('span', { className: 'adm-sig-action-label', textContent: 'Next step' }),
      el('p', { className: 'adm-sig-action-text', textContent: f.action }),
    ]));
    return card;
  }

  // ── The brief ─────────────────────────────────────────────────────────────

  /**
   * Ask the server to write the brief.
   *
   * Sends the findings, which are already conclusions rather than data. The
   * server projects them down to an allowlist and scrubs anything
   * address-shaped before a model sees them; this side simply must not add
   * anything that is not already on the page.
   */
  async function loadBrief(host) {
    const { findings } = currentResult();
    ctx.signalsBrief = { state: 'loading' };
    renderBrief(host);
    try {
      const res = await apiSend('/api/admin/brief', 'POST', { findings });
      ctx.signalsBrief = res && res.summary
        ? { state: 'ready', summary: res.summary }
        : { state: 'none', reason: (res && res.reason) || 'unavailable' };
    } catch {
      ctx.signalsBrief = { state: 'none', reason: 'error' };
    }
    renderBrief(host);
  }

  /** Why there is no brief, in words rather than a code. */
  function briefReason(reason) {
    if (reason === 'unavailable') return 'No model is configured, so there is no written brief. Every finding below is computed here in the browser and is unaffected.';
    if (reason === 'no-findings') return 'Nothing to summarise yet.';
    return 'The brief could not be written. The findings below are unaffected.';
  }

  function renderBrief(host) {
    host.innerHTML = '';
    const state = ctx.signalsBrief || { state: 'idle' };

    const head = el('div', { className: 'adm-sig-brief-head' }, [
      el('h2', { className: 'adm-sig-brief-title', textContent: 'Brief' }),
    ]);
    const btn = el('button', {
      type: 'button',
      className: 'adm-sig-btn',
      textContent: state.state === 'loading' ? 'Writing…' : state.state === 'ready' ? 'Rewrite' : 'Write a brief',
    });
    if (state.state === 'loading') btn.setAttribute('disabled', 'disabled');
    btn.addEventListener('click', () => loadBrief(host));
    head.appendChild(btn);
    host.appendChild(head);

    if (state.state === 'ready') {
      host.appendChild(el('p', { className: 'adm-sig-brief-text', textContent: state.summary }));
      host.appendChild(el('p', {
        className: 'adm-sig-brief-note',
        textContent: 'Written from the findings below, which were computed first. It restates them; it does not add numbers of its own.',
      }));
    } else if (state.state === 'none') {
      host.appendChild(el('p', { className: 'adm-sig-brief-note', textContent: briefReason(state.reason) }));
    } else if (state.state !== 'loading') {
      host.appendChild(el('p', {
        className: 'adm-sig-brief-note',
        textContent: 'A few sentences over the findings below, written on request. It costs a model call, so it is not generated automatically.',
      }));
    }
  }

  // ── The tab ───────────────────────────────────────────────────────────────

  function renderSummary(result) {
    const bar = el('div', { className: 'adm-sig-summary' });
    SEVERITY_SECTIONS.forEach((s) => {
      const n = result.counts[s.key] || 0;
      if (!n) return;
      bar.appendChild(el('div', { className: `adm-sig-tally adm-sig-tally--${s.key}` }, [
        el('span', { className: 'adm-sig-tally-n', textContent: String(n) }),
        el('span', { className: 'adm-sig-tally-label', textContent: s.label }),
      ]));
    });
    return bar;
  }

  function render() {
    const host = qs('#adm-signals');
    if (!host) return;
    // NOT reset here. The rail chip, the Overview teaser and this panel all read
    // `currentResult()`, and they must agree — recomputing per caller would let
    // the chip say 3 while the teaser listed 2 if data landed between them.
    // admin.js#loadAll calls reset() once, when new data arrives.
    const result = currentResult();

    host.innerHTML = '';

    const brief = el('div', { className: 'adm-sig-brief', id: 'adm-sig-brief' });
    host.appendChild(brief);
    renderBrief(brief);

    host.appendChild(renderSummary(result));

    SEVERITY_SECTIONS.forEach((section) => {
      const group = result.findings.filter((f) => f.severity === section.key);
      if (!group.length) return;
      const grid = el('div', { className: 'adm-sig-grid' });
      group.forEach((f) => grid.appendChild(findingCard(f)));
      host.appendChild(el('section', { className: 'adm-section' }, [
        el('h2', { className: 'adm-section-title', textContent: section.label }),
        grid,
      ]));
    });

    // Reached only if every rule declined AND none was suppressed, which the
    // engine makes unlikely — but a silent blank panel is exactly the thing this
    // tab exists to prevent, so it gets a sentence rather than nothing.
    if (!result.findings.length) {
      host.appendChild(el('p', {
        className: 'adm-sig-empty',
        textContent: 'No checks produced a result. That usually means no data has loaded yet rather than that everything is fine — try Refresh.',
      }));
    }

    if (result.failed.length) {
      host.appendChild(el('p', {
        className: 'adm-sig-empty',
        textContent: `${result.failed.length} check(s) errored and were skipped: ${result.failed.join(', ')}`,
      }));
    }
  }

  /**
   * The Overview teaser: the top few actionable findings, above the stat cards.
   *
   * Actionable only — a "working well" card is worth reading on the Signals tab
   * and is noise at the top of the Overview, where the point is to surface what
   * needs a decision without making anyone navigate first.
   */
  function renderTeaser() {
    const host = qs('#adm-signals-teaser');
    if (!host) return;
    const result = currentResult();
    const top = result.findings.filter((f) => ACTIONABLE.includes(f.severity)).slice(0, TEASER_LIMIT);

    host.innerHTML = '';
    if (!top.length) return;

    const total = result.counts.actionable || top.length;
    const head = el('div', { className: 'adm-sig-teaser-head' }, [
      el('span', {
        className: 'adm-sig-teaser-title',
        textContent: `${total} thing${total === 1 ? '' : 's'} need${total === 1 ? 's' : ''} attention`,
      }),
    ]);
    const open = el('button', { type: 'button', className: 'adm-sig-btn', textContent: 'Open Signals' });
    open.addEventListener('click', () => {
      const tab = document.querySelector('.adm-tab[data-tab="signals"]');
      if (tab) /** @type {HTMLElement} */ (tab).click();
    });
    head.appendChild(open);
    host.appendChild(head);

    const list = el('div', { className: 'adm-sig-teaser-list' });
    top.forEach((f) => {
      list.appendChild(el('div', { className: `adm-sig-teaser-row adm-sig-teaser-row--${f.severity}` }, [
        severityPill(f.severity),
        el('span', { className: 'adm-sig-teaser-text', textContent: f.title }),
      ]));
    });
    host.appendChild(list);
  }

  /** How many findings want a decision — the rail chip. */
  function actionableCount() {
    return currentResult().counts.actionable || 0;
  }

  /** Drop the memoized result so the next render recomputes. Called on reload/sign-out. */
  function reset() {
    ctx.signalsResult = null;
    ctx.signalsBrief = null;
  }

  return { render, renderTeaser, actionableCount, reset };
}
