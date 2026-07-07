// auth routes, extracted verbatim from server.js.
import express from 'express';

export default function createAuthRouter(deps) {
  const { authStore, googleOAuthClient, resend, LOGS_ACCESS_KEY, authLimiter, emailLimiter, RESEND_FROM_EMAIL, EMAIL_DEBUG_MODE, DEBUG_EMAIL, IS_STAGING, HIDE_STAGING_BANNER, SHOW_STAGING_BANNER, endpointKeyMatches, setSensitiveHeaders, getAuthUserFromRequest, toPublicAuthUser, sendRegistrationVerificationEmail } = deps;
  const router = express.Router();

router.get('/getpro', (req, res) => {
  setSensitiveHeaders(res);
  res.sendFile(path.join(__dirname, 'public', 'getpro.html'));
});

router.post('/api/getpro', (req, res) => {
  setSensitiveHeaders(res);
  try {
    if (!LOGS_ACCESS_KEY) {
      return res.status(503).json({ error: 'Not configured' });
    }
    const provided = req.get('X-Stagify-Endpoint-Key') || '';
    if (!endpointKeyMatches(provided, LOGS_ACCESS_KEY)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const user = getAuthUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ error: 'Sign in on this site first, then try again.' });
    }
    const result = authStore.grantProWithPass(user.id);
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'Failed' });
    }
    console.log('[getpro] granted pro for user', user.id);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[getpro]', e);
    return res.status(500).json({ error: 'Error' });
  }
});

router.post('/api/auth/register', authLimiter, express.json(), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = authStore.startRegistration(email, password);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
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
    console.error('register error', e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/api/auth/register/verify', authLimiter, express.json(), (req, res) => {
  try {
    const { email, code } = req.body || {};
    const result = authStore.completeRegistration(email, code);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    const fullUser = authStore.findUserByEmail(email);
    res.json({ success: true, token: result.token, user: toPublicAuthUser(fullUser) });
  } catch (e) {
    console.error('register verify error', e);
    res.status(500).json({ error: 'Verification failed' });
  }
});

router.post('/api/auth/register/resend', emailLimiter, express.json(), async (req, res) => {
  try {
    const email = (req.body && req.body.email) || '';
    const result = authStore.resendRegistrationCode(email);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
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
    console.error('register resend error', e);
    res.status(500).json({ error: 'Could not resend verification code' });
  }
});

router.post('/api/auth/login', authLimiter, express.json(), (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = authStore.login(email, password);
    if (!result.ok) {
      return res.status(401).json({ error: result.error });
    }
    const fullUser = authStore.findUserByEmail(email);
    res.json({ success: true, token: result.token, user: toPublicAuthUser(fullUser) });
  } catch (e) {
    console.error('login error', e);
    res.status(500).json({ error: 'Login failed' });
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
      return res.status(403).json({
        error: 'Google sign-in is disabled on the staging environment',
        code: 'STAGING_DISABLED',
      });
    }
    if (!googleOAuthClient || !googleClientId) {
      return res.status(503).json({ error: 'Google sign-in is not configured' });
    }
    const credential = req.body && req.body.credential;
    if (!credential || typeof credential !== 'string') {
      return res.status(400).json({ error: 'Missing credential' });
    }
    const ticket = await googleOAuthClient.verifyIdToken({
      idToken: credential,
      audience: googleClientId,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email || !payload.sub) {
      return res.status(401).json({ error: 'Invalid Google sign-in' });
    }
    if (payload.email_verified === false) {
      return res.status(401).json({ error: 'Google email not verified' });
    }
    const result = authStore.loginWithGoogle({
      email: payload.email,
      googleSub: payload.sub,
    });
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    const fullUser = authStore.findUserByEmail(payload.email);
    res.json({ success: true, token: result.token, user: toPublicAuthUser(fullUser) });
  } catch (e) {
    console.error('google auth error', e.message || e);
    res.status(401).json({ error: 'Google sign-in failed' });
  }
});

router.get('/api/auth/me', (req, res) => {
  const user = getAuthUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ error: 'Not signed in', code: 'AUTH_REQUIRED' });
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
      console.error('[auth] Resend not configured; cannot send password reset email');
      return res.status(503).json({
        ok: false,
        error:
          'We could not send a reset email because email delivery is not configured on this server. Please contact support.',
        code: 'EMAIL_NOT_CONFIGURED',
      });
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
      console.error('[auth] Resend password reset failed:', errMsg);
      return res.status(502).json({
        ok: false,
        error:
          'We could not send the reset email right now. Please try again in a few minutes. If it keeps failing, contact support.',
        code: 'EMAIL_SEND_FAILED',
      });
    }

    return res.json({
      ok: true,
      emailSent: true,
      message:
        'We sent a password reset link to your email. It expires in one hour. If you do not see it within a few minutes, check your spam or Promotions folder.',
    });
  } catch (e) {
    console.error('forgot-password error', e);
    res.status(500).json({ error: 'Could not process request' });
  }
});

router.post('/api/auth/reset-password', authLimiter, express.json(), (req, res) => {
  try {
    const token = (req.body && req.body.token) || '';
    const password = (req.body && req.body.password) || '';
    const out = authStore.completePasswordReset(token, password);
    if (!out.ok) {
      return res.status(400).json({ error: out.error });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('reset-password error', e);
    res.status(500).json({ error: 'Could not reset password' });
  }
});

  return router;
}
