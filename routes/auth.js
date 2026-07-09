// auth routes, extracted verbatim from server.js.
import express from 'express';
import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError } from '../lib/http/http-helpers.js';
import path from 'path';
import { logger } from '../lib/logger.js';

export default function createAuthRouter(deps) {
  const { authStore, googleOAuthClient, resend, LOGS_ACCESS_KEY, authLimiter, emailLimiter, RESEND_FROM_EMAIL, EMAIL_DEBUG_MODE, DEBUG_EMAIL, IS_STAGING, SHOW_STAGING_BANNER, endpointKeyMatches, setSensitiveHeaders, getAuthUserFromRequest, toPublicAuthUser, sendRegistrationVerificationEmail , __dirname, googleClientId } = deps;
  const router = createAsyncRouter();

router.get('/getpro', (req, res) => {
  setSensitiveHeaders(res);
  res.sendFile(path.join(__dirname, 'public', 'getpro.html'));
});

router.post('/api/getpro', (req, res) => {
  setSensitiveHeaders(res);
  try {
    if (!LOGS_ACCESS_KEY) {
      return sendError(res, 503, 'Not configured');
    }
    const provided = req.get('X-Stagify-Endpoint-Key') || '';
    if (!endpointKeyMatches(provided, LOGS_ACCESS_KEY)) {
      return sendError(res, 403, 'Access denied');
    }
    const user = getAuthUserFromRequest(req);
    if (!user) {
      return sendError(res, 401, 'Sign in on this site first, then try again.');
    }
    const result = authStore.grantProWithPass(user.id);
    if (!result.ok) {
      return sendError(res, 400, result.error || 'Failed');
    }
    logger.info('[getpro] granted pro for user', user.id);
    return res.json({ ok: true });
  } catch (e) {
    logger.error('[getpro]', e);
    return sendError(res, 500, 'Error');
  }
});

router.post('/api/auth/register', authLimiter, express.json(), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = authStore.startRegistration(email, password);
    if (!result.ok) {
      return sendError(res, 400, result.error);
    }
    const mail = await sendRegistrationVerificationEmail({
      toEmail: result.toEmail,
      code: result.code,
    });
    if (!mail.ok) {
      return res.status(mail.status).json(mail.body);
    }
    res.json(mail.body);
  } catch (e) {
    logger.error('register error', e);
    sendError(res, 500, 'Registration failed');
  }
});

router.post('/api/auth/register/verify', authLimiter, express.json(), (req, res) => {
  try {
    const { email, code } = req.body || {};
    const result = authStore.completeRegistration(email, code);
    if (!result.ok) {
      return sendError(res, 400, result.error);
    }
    const fullUser = authStore.findUserByEmail(email);
    res.json({ success: true, token: result.token, user: toPublicAuthUser(fullUser) });
  } catch (e) {
    logger.error('register verify error', e);
    sendError(res, 500, 'Verification failed');
  }
});

router.post('/api/auth/register/resend', emailLimiter, express.json(), async (req, res) => {
  try {
    const email = (req.body && req.body.email) || '';
    const result = authStore.resendRegistrationCode(email);
    if (!result.ok) {
      return sendError(res, 400, result.error);
    }
    const mail = await sendRegistrationVerificationEmail({
      toEmail: result.toEmail,
      code: result.code,
    });
    if (!mail.ok) {
      return res.status(mail.status).json(mail.body);
    }
    res.json({
      ok: true,
      message: 'We sent a new verification code to your email.',
    });
  } catch (e) {
    logger.error('register resend error', e);
    sendError(res, 500, 'Could not resend verification code');
  }
});

router.post('/api/auth/login', authLimiter, express.json(), (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = authStore.login(email, password);
    if (!result.ok) {
      return sendError(res, 401, result.error);
    }
    const fullUser = authStore.findUserByEmail(email);
    res.json({ success: true, token: result.token, user: toPublicAuthUser(fullUser) });
  } catch (e) {
    logger.error('login error', e);
    sendError(res, 500, 'Login failed');
  }
});

router.get('/api/auth/config', (req, res) => {
  // On the staging site we withhold the client id so the UI never renders the
  // Google button, and advertise isStaging so the client can block the Stripe
  // subscribe / help-center buttons too.
  res.json({
    googleClientId: IS_STAGING ? null : googleClientId || null,
    isStaging: IS_STAGING,
    // Banner has its own flag so HIDE_STAGING_BANNER can suppress it without
    // affecting the Google/Stripe restrictions that isStaging still drives.
    showStagingBanner: SHOW_STAGING_BANNER,
  });
});

router.post('/api/auth/google', authLimiter, express.json(), async (req, res) => {
  try {
    if (IS_STAGING) {
      return sendError(res, 403, 'Google sign-in is disabled on the staging environment', {
        code: 'STAGING_DISABLED',
      });
    }
    if (!googleOAuthClient || !googleClientId) {
      return sendError(res, 503, 'Google sign-in is not configured');
    }
    const credential = req.body && req.body.credential;
    if (!credential || typeof credential !== 'string') {
      return sendError(res, 400, 'Missing credential');
    }
    const ticket = await googleOAuthClient.verifyIdToken({
      idToken: credential,
      audience: googleClientId,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email || !payload.sub) {
      return sendError(res, 401, 'Invalid Google sign-in');
    }
    if (payload.email_verified === false) {
      return sendError(res, 401, 'Google email not verified');
    }
    const result = authStore.loginWithGoogle({
      email: payload.email,
      googleSub: payload.sub,
    });
    if (!result.ok) {
      return sendError(res, 400, result.error);
    }
    const fullUser = authStore.findUserByEmail(payload.email);
    res.json({ success: true, token: result.token, user: toPublicAuthUser(fullUser) });
  } catch (e) {
    logger.error('google auth error', e.message || e);
    sendError(res, 401, 'Google sign-in failed');
  }
});

router.get('/api/auth/me', (req, res) => {
  const user = getAuthUserFromRequest(req);
  if (!user) {
    return sendError(res, 401, 'Not signed in', { code: 'AUTH_REQUIRED' });
  }
  res.json({ user: toPublicAuthUser(user) });
});

router.post('/api/auth/logout', express.json(), (req, res) => {
  const token =
    (req.body && req.body.authToken) ||
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7).trim()
      : null);
  if (token) authStore.logout(token);
  res.json({ success: true });
});

router.post('/api/auth/forgot-password', emailLimiter, express.json(), async (req, res) => {
  try {
    const email = (req.body && req.body.email) || '';
    const result = authStore.startPasswordReset(email);
    const baseUrlRaw =
      process.env.PUBLIC_APP_URL || process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const baseUrl = String(baseUrlRaw).replace(/\/$/, '');

    if (!result.token) {
      return res.json({
        ok: true,
        emailSent: false,
        message:
          'There is no Stagify account for that email address. Try signing up, or double-check for typos.',
      });
    }

    if (!resend) {
      logger.error('[auth] Resend not configured; cannot send password reset email');
      return sendError(
        res,
        503,
        'We could not send a reset email because email delivery is not configured on this server. Please contact support.',
        { code: 'EMAIL_NOT_CONFIGURED' },
      );
    }

    const resetUrl = `${baseUrl}/reset-password.html?token=${encodeURIComponent(result.token)}`;
    const recipient = EMAIL_DEBUG_MODE ? DEBUG_EMAIL : result.toEmail;
    const debugNote = EMAIL_DEBUG_MODE ? ` (intended recipient: ${result.toEmail})` : '';

    const sendResult = await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: recipient,
      subject: 'Reset your Stagify password',
      html:
        `<p>Hi,</p><p>We received a request to reset your Stagify password${debugNote}.</p>` +
        `<p><a href="${resetUrl}">Choose a new password</a></p>` +
        `<p>This link expires in one hour. If you didn’t ask for this, you can ignore this email.</p>` +
        `<p>— Stagify</p>`,
      text: `Reset your Stagify password: ${resetUrl}\n\nExpires in one hour. If you didn't request this, ignore this email.`,
    });

    if (sendResult.error) {
      const errMsg =
        typeof sendResult.error?.message === 'string'
          ? sendResult.error.message
          : JSON.stringify(sendResult.error);
      logger.error('[auth] Resend password reset failed:', errMsg);
      return sendError(
        res,
        502,
        'We could not send the reset email right now. Please try again in a few minutes. If it keeps failing, contact support.',
        { code: 'EMAIL_SEND_FAILED' },
      );
    }

    return res.json({
      ok: true,
      emailSent: true,
      message:
        'We sent a password reset link to your email. It expires in one hour. If you do not see it within a few minutes, check your spam or Promotions folder.',
    });
  } catch (e) {
    logger.error('forgot-password error', e);
    sendError(res, 500, 'Could not process request');
  }
});

router.post('/api/auth/reset-password', authLimiter, express.json(), (req, res) => {
  try {
    const token = (req.body && req.body.token) || '';
    const password = (req.body && req.body.password) || '';
    const out = authStore.completePasswordReset(token, password);
    if (!out.ok) {
      return sendError(res, 400, out.error);
    }
    res.json({ ok: true });
  } catch (e) {
    logger.error('reset-password error', e);
    sendError(res, 500, 'Could not reset password');
  }
});

  return router;
}
