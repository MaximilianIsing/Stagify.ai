// Email catalog — one place that knows every email a USER can receive, built from
// the same pure renderers the senders use (lib/services/email.js +
// lib/services/lifecycle-emails.js). It powers the admin dashboard's Emails tab:
// `list()` feeds the preview gallery, and `renderById()` supplies the body for a
// live "send test to me" copy. Because it reuses the real renderers with
// representative sample data, a preview is always identical to what ships.
//
// NOT included here: operator-facing mail (bug reports, contact form) — those go to
// the Stagify team, not to users, so they are out of scope for a "what users see"
// gallery.

import {
  renderRegistrationVerificationEmail,
  renderAccountExistsEmail,
  renderPasswordResetEmail,
  renderPasswordChangedEmail,
} from './email.js';
import {
  renderTrialWelcomeEmail,
  renderTrialActivationNudgeEmail,
  renderTrialValueEmail,
  renderTrialEndingEmail,
  renderSubscriptionCanceledEmail,
} from './lifecycle-emails.js';

/**
 * Build the email catalog bound to the site origin (used in body links).
 * @param {{ appUrl?: string }} [deps] - The absolute site origin for links.
 * @returns {{
 *   list: () => Array<{ id: string, label: string, category: string, description: string, subject: string, html: string, text: string }>,
 *   renderById: (id: string) => { id: string, label: string, category: string, description: string, subject: string, html: string, text: string } | null,
 *   ids: () => string[],
 * }} The catalog API.
 */
export function createEmailCatalog({ appUrl } = {}) {
  const base = String(appUrl || 'https://stagify.ai').replace(/\/$/, '');

  // Representative sample data so every template renders a realistic preview.
  const SAMPLE = {
    code: '123456',
    resetUrl: `${base}/reset-password.html?token=example-reset-token`,
    daysLeft: 2,
    roomsStaged: 4,
    accessUntil: new Date('2026-09-01T00:00:00Z'),
  };

  /**
   * Ordered catalog definitions. `render()` is a thunk so a preview is only built
   * when asked for. Keep account → trial → billing ordering (roughly the order a
   * user meets them).
   * @type {Array<{ id: string, label: string, category: string, description: string, render: () => { subject: string, html: string, text: string } }>}
   */
  const defs = [
    {
      id: 'verification',
      label: 'Email verification code',
      category: 'Account',
      description: 'Sent when a new user signs up — the 6-digit code to confirm their address.',
      render: () => renderRegistrationVerificationEmail({ code: SAMPLE.code }),
    },
    {
      id: 'account-exists',
      label: 'Account already exists',
      category: 'Account',
      description: 'Sent when someone tries to register an email that already has an account (anti-enumeration notice).',
      render: () => renderAccountExistsEmail({}),
    },
    {
      id: 'password-reset',
      label: 'Password reset link',
      category: 'Account',
      description: 'Sent from “Forgot your password?” — a one-hour reset link.',
      render: () => renderPasswordResetEmail({ resetUrl: SAMPLE.resetUrl }),
    },
    {
      id: 'password-changed',
      label: 'Password changed notice',
      category: 'Account',
      description: 'Sent after a reset completes — confirms the change and that all devices were signed out.',
      render: () => renderPasswordChangedEmail({ appUrl: base }),
    },
    {
      id: 'trial-welcome',
      label: 'Trial welcome',
      category: 'Trial',
      description: 'Sent the moment a Stagify+ free trial starts.',
      render: () => renderTrialWelcomeEmail({ appUrl: base }),
    },
    {
      id: 'trial-activation',
      label: 'Activation nudge',
      category: 'Trial',
      description: 'Sent ~day 1–4 to trial users who haven’t staged anything yet.',
      render: () => renderTrialActivationNudgeEmail({ appUrl: base }),
    },
    {
      id: 'trial-value',
      label: 'Mid-trial feature spotlight',
      category: 'Trial',
      description: 'Sent ~day 3–5 to active trial users, highlighting the Stagify+-only tools.',
      render: () => renderTrialValueEmail({ appUrl: base }),
    },
    {
      id: 'trial-ending',
      label: 'Trial ending reminder',
      category: 'Trial',
      description: 'Sent ~2 days before the trial converts to a paid subscription.',
      render: () => renderTrialEndingEmail({ appUrl: base, daysLeft: SAMPLE.daysLeft, roomsStaged: SAMPLE.roomsStaged }),
    },
    {
      id: 'subscription-canceled',
      label: 'Cancellation win-back',
      category: 'Billing',
      description: 'Sent when a subscription ends — a win-back with a reactivate link.',
      render: () => renderSubscriptionCanceledEmail({ appUrl: base, accessUntil: SAMPLE.accessUntil }),
    },
  ];

  /**
   * @param {{ id: string, label: string, category: string, description: string, render: () => { subject: string, html: string, text: string } }} def
   * @returns {{ id: string, label: string, category: string, description: string, subject: string, html: string, text: string }}
   */
  function build(def) {
    const msg = def.render();
    return {
      id: def.id,
      label: def.label,
      category: def.category,
      description: def.description,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    };
  }

  return {
    list: () => defs.map(build),
    renderById: (id) => {
      const def = defs.find((d) => d.id === id);
      return def ? build(def) : null;
    },
    ids: () => defs.map((d) => d.id),
  };
}
