// Public / consumer email providers that must never be claimable as an
// *enterprise* domain.
//
// Why this exists: an enterprise domain is a blanket grant. `isActiveDomain()`
// upgrades EVERY account whose email ends in that domain to `pro` (see
// lib/services/auth-helpers.js). Registering `gmail.com` would therefore hand
// Stagify+ to a large slice of the internet for the price of one seat, so the
// domain a buyer types has to be one they actually control.
//
// Scope: this list gates enterprise domain registration ONLY. Ordinary signup
// at /api/signup must keep accepting gmail/yahoo/outlook addresses — do not
// wire this into the auth routes.
//
// Two families are listed together because both break the "a company controls
// this domain" assumption:
//   - free consumer mailbox providers (gmail, yahoo, gmx, qq, …)
//   - disposable / throwaway mail services (mailinator, guerrillamail, …)

/** Stable code returned to the browser so the message can be localized. */
export const PUBLIC_EMAIL_DOMAIN_CODE = 'PUBLIC_EMAIL_DOMAIN';

/** English fallback used server-side and when a language pack lacks the key. */
export const PUBLIC_EMAIL_DOMAIN_MESSAGE =
  'Enterprise plans require a company domain. Public email providers ' +
  '(gmail.com, yahoo.com, outlook.com, …) cannot be registered.';

/**
 * Free consumer mailbox providers. Keep lowercase and sorted-ish by family;
 * adding a provider is a one-line edit.
 */
const CONSUMER_PROVIDERS = [
  // Google
  'gmail.com', 'googlemail.com',
  // Yahoo (incl. the country variants that share the same open signup)
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.jp', 'yahoo.co.in', 'yahoo.co.id',
  'yahoo.ca', 'yahoo.com.au', 'yahoo.com.br', 'yahoo.com.mx', 'yahoo.com.ar',
  'yahoo.de', 'yahoo.fr', 'yahoo.es', 'yahoo.it', 'yahoo.se', 'yahoo.gr',
  'yahoo.com.sg', 'yahoo.com.ph', 'yahoo.com.hk', 'yahoo.com.tw', 'yahoo.com.vn',
  'ymail.com', 'rocketmail.com',
  // AOL / Verizon
  'aol.com', 'aol.co.uk', 'aim.com', 'verizon.net',
  // Microsoft
  'outlook.com', 'outlook.co.uk', 'outlook.de', 'outlook.fr', 'outlook.es',
  'outlook.it', 'outlook.jp', 'outlook.in', 'outlook.com.br', 'outlook.com.au',
  'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.es',
  'hotmail.it', 'hotmail.be', 'hotmail.nl', 'hotmail.ca', 'hotmail.com.br',
  'live.com', 'live.co.uk', 'live.ca', 'live.com.au', 'live.de', 'live.fr',
  'live.nl', 'live.it', 'live.se', 'live.dk', 'live.jp', 'live.cn',
  'msn.com', 'passport.com', 'windowslive.com',
  // Apple
  'icloud.com', 'me.com', 'mac.com',
  // Privacy-first consumer mail
  'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
  'tutanota.com', 'tutanota.de', 'tuta.io', 'tuta.com',
  'hushmail.com', 'fastmail.com', 'fastmail.fm', 'posteo.de', 'mailbox.org',
  'startmail.com', 'runbox.com', 'countermail.com', 'disroot.org', 'riseup.net',
  // German / European
  'gmx.com', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch', 'gmx.fr', 'gmx.us',
  'web.de', 'freenet.de', 't-online.de', 'arcor.de', 'online.de',
  'orange.fr', 'wanadoo.fr', 'free.fr', 'laposte.net', 'sfr.fr', 'neuf.fr',
  'bbox.fr', 'club-internet.fr',
  'libero.it', 'virgilio.it', 'tiscali.it', 'alice.it', 'tin.it', 'inwind.it',
  'terra.com', 'terra.com.br', 'uol.com.br', 'bol.com.br', 'ig.com.br',
  'globo.com', 'globomail.com', 'r7.com', 'zipmail.com.br',
  'telefonica.net', 'ono.com', 'wanadoo.es',
  'ziggo.nl', 'kpnmail.nl', 'home.nl', 'planet.nl', 'chello.nl', 'xs4all.nl',
  'telenet.be', 'skynet.be', 'scarlet.be',
  'bluewin.ch', 'sunrise.ch', 'hispeed.ch',
  'telia.com', 'spray.se', 'bredband.net', 'hotmail.se',
  'online.no', 'broadpark.no', 'start.no',
  'sol.dk', 'mail.dk', 'jubii.dk',
  'suomi24.fi', 'luukku.com', 'elisanet.fi',
  'wp.pl', 'onet.pl', 'o2.pl', 'interia.pl', 'gazeta.pl', 'poczta.onet.pl',
  'op.pl', 'tlen.pl',
  'seznam.cz', 'centrum.cz', 'email.cz', 'atlas.cz', 'volny.cz',
  'azet.sk', 'zoznam.sk', 'centrum.sk',
  'freemail.hu', 'citromail.hu', 'indamail.hu',
  'abv.bg', 'mail.bg', 'dir.bg',
  'sapo.pt', 'iol.pt', 'clix.pt',
  'mynet.com', 'hotmail.com.tr', 'yandex.com.tr',
  // Russian / CIS
  'mail.ru', 'inbox.ru', 'bk.ru', 'list.ru', 'internet.ru',
  'yandex.ru', 'yandex.com', 'yandex.by', 'yandex.kz', 'yandex.ua', 'ya.ru',
  'rambler.ru', 'lenta.ru', 'autorambler.ru', 'myrambler.ru', 'ro.ru',
  'ukr.net', 'i.ua', 'meta.ua', 'bigmir.net', 'tut.by',
  // Chinese
  'qq.com', 'vip.qq.com', 'foxmail.com',
  '163.com', '126.com', 'yeah.net', 'vip.163.com', 'vip.126.com',
  'sina.com', 'sina.cn', 'sina.com.cn', 'sohu.com', 'aliyun.com',
  '21cn.com', 'tom.com', '139.com', '189.cn', 'wo.cn',
  // Japanese / Korean
  'yahoo.ne.jp', 'ezweb.ne.jp', 'docomo.ne.jp', 'softbank.ne.jp', 'nifty.com',
  'biglobe.ne.jp', 'ocn.ne.jp', 'so-net.ne.jp', 'excite.co.jp', 'goo.jp',
  'naver.com', 'hanmail.net', 'daum.net', 'nate.com', 'kakao.com',
  // Indian / SE Asian
  'rediffmail.com', 'rediff.com', 'sify.com', 'indiatimes.com',
  'bsnl.in', 'vsnl.net', 'in.com',
  // Latin American
  'prodigy.net.mx', 'hotmail.com.mx', 'latinmail.com',
  // North American ISPs
  'comcast.net', 'xfinity.com', 'att.net', 'sbcglobal.net', 'bellsouth.net',
  'ameritech.net', 'pacbell.net', 'swbell.net', 'prodigy.net', 'flash.net',
  'charter.net', 'spectrum.net', 'roadrunner.com', 'rr.com', 'twc.com',
  'cox.net', 'optonline.net', 'optimum.net', 'earthlink.net', 'juno.com',
  'netzero.net', 'netzero.com', 'frontier.com', 'frontiernet.net',
  'windstream.net', 'centurylink.net', 'embarqmail.com', 'q.com',
  'cableone.net', 'mchsi.com', 'wowway.com', 'suddenlink.net', 'consolidated.net',
  'shaw.ca', 'rogers.com', 'sympatico.ca', 'telus.net', 'bell.net', 'videotron.ca',
  'cogeco.ca', 'eastlink.ca',
  // UK / IE / AU / NZ ISPs
  'btinternet.com', 'btopenworld.com', 'talktalk.net', 'tiscali.co.uk',
  'sky.com', 'virginmedia.com', 'blueyonder.co.uk', 'ntlworld.com',
  'plus.net', 'plusnet.com', 'zen.co.uk', 'eircom.net', 'iol.ie',
  'bigpond.com', 'bigpond.net.au', 'optusnet.com.au', 'iinet.net.au',
  'tpg.com.au', 'internode.on.net', 'westnet.com.au', 'ozemail.com.au',
  'xtra.co.nz', 'clear.net.nz', 'slingshot.co.nz',
  // Other free webmail
  'zoho.com', 'zohomail.com', 'mail.com', 'email.com', 'usa.com', 'consultant.com',
  'europe.com', 'post.com', 'writeme.com', 'dr.com', 'engineer.com', 'techie.com',
  'cheerful.com', 'gmx.co.uk', 'lycos.com', 'excite.com', 'angelfire.com',
  'tripod.com', 'netscape.net', 'compuserve.com', 'prodigy.com',
  'inbox.com', 'mail.yahoo.com', 'hushmail.me', 'safe-mail.net', 'lavabit.com',
  'openmailbox.org', 'autistici.org', 'inventati.org', 'cock.li',
  'keemail.me', 'skiff.com', 'duck.com', 'simplelogin.com', 'anonaddy.com',
  'addy.io', 'relay.firefox.com', 'mozmail.com', 'icloud.me',
];

/**
 * Disposable / throwaway mailbox services. Not exhaustive by nature — new ones
 * appear constantly — but the common ones are worth refusing outright.
 */
const DISPOSABLE_PROVIDERS = [
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com',
  'grr.la', 'spam4.me', 'pokemail.net',
  '10minutemail.com', '10minutemail.net', '20minutemail.com', 'tempmail.com',
  'temp-mail.org', 'tempmailo.com', 'tempail.com', 'throwawaymail.com',
  'trashmail.com', 'trashmail.de', 'trash-mail.com', 'wegwerfmail.de',
  'yopmail.com', 'yopmail.fr', 'yopmail.net', 'jetable.org',
  'getnada.com', 'nada.email', 'dispostable.com', 'fakeinbox.com',
  'mailnesia.com', 'maildrop.cc', 'mailcatch.com', 'mytemp.email',
  'moakt.com', 'emailondeck.com', 'burnermail.io', 'mailsac.com',
  'inboxkitten.com', 'mohmal.com', 'tempinbox.com', 'spamgourmet.com',
  'discard.email', 'spambog.com', 'byom.de', 'mvrht.com',
  'harakirimail.com', 'einrot.com', 'armyspy.com', 'cuvox.de', 'dayrep.com',
  'fleckens.hu', 'gustr.com', 'jourrapide.com', 'rhyta.com', 'superrito.com',
  'teleworm.us',
];

/**
 * Every domain that cannot be claimed as an enterprise domain.
 * Frozen so a caller cannot mutate the gate at runtime.
 * @type {ReadonlySet<string>}
 */
export const PUBLIC_EMAIL_DOMAINS = new Set([...CONSUMER_PROVIDERS, ...DISPOSABLE_PROVIDERS]);

/**
 * Normalize whatever the caller has (a bare domain, `@domain`, a full email
 * address, mixed case, a trailing dot) down to a comparable hostname.
 * @param {unknown} value
 * @returns {string} lowercase hostname, or '' when nothing usable was given
 */
export function normalizeDomain(value) {
  if (typeof value !== 'string') return '';
  let d = value.trim().toLowerCase();
  if (!d) return '';
  // Accept a whole address — take what follows the last '@'.
  const at = d.lastIndexOf('@');
  if (at >= 0) d = d.slice(at + 1);
  // Strip a scheme/path if someone pasted a URL, plus any trailing root dot.
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0].replace(/\.+$/, '');
  return d;
}

/**
 * True when `value` is a public mailbox provider and so must not be sold or
 * activated as an enterprise domain.
 *
 * Subdomains of a listed provider match too (`mail.gmail.com`), because the
 * buyer controls neither.
 *
 * @param {unknown} value - a domain, `@domain`, or full email address
 * @returns {boolean}
 */
export function isPublicEmailDomain(value) {
  const d = normalizeDomain(value);
  if (!d) return false;
  if (PUBLIC_EMAIL_DOMAINS.has(d)) return true;
  // `evil.gmail.com` resolves under Google, not the buyer.
  let idx = d.indexOf('.');
  while (idx !== -1) {
    if (PUBLIC_EMAIL_DOMAINS.has(d.slice(idx + 1))) return true;
    idx = d.indexOf('.', idx + 1);
  }
  return false;
}
