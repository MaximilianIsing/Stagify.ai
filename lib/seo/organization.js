// Single source of truth for the site's ORGANIZATION IDENTITY — the JSON-LD that tells
// a search engine or an answer engine which company this is.
//
// WHY THIS FILE EXISTS
// Four unrelated products share the name: stagify.io, stagify.app, stagify.online and
// stagifyai.com. An answer engine resolves a query to an ENTITY and then answers from
// what that entity's own pages assert, so a thin or contradictory identity block is how
// a review of somebody else's product ends up quoted as ours. Before this module the
// site asserted almost nothing to bind to — no alternateName, no founder, no
// foundingDate, no WebSite node — and what it did assert disagreed with itself: the
// Organization existed on exactly two pages, with a five-URL sameAs on index.html, a
// three-URL one on contact.html, and three owned profiles in neither.
//
// So the entity is declared ONCE, here, and baked into every indexable English page by
// scripts/build-i18n-seo.js (step 5) between generated markers. Localized pages inherit
// it untranslated through lib/i18n/render-page.js, deliberately: an entity's identity is
// the same fact in eleven languages, and the same choice is already made for the
// homepage FAQPage. Only the /about page's prose is translated.
//
// Change the identity HERE. test/seo/organization-jsonld.test.js fails the build when a
// page's baked copy drifts from this module, which is what stops the 5-vs-3 sameAs
// split from coming back.

import { SITE_ORIGIN } from '../i18n/locales.js';

/** Canonical node ids. Every page's Organization carries the same @id, so the graph merges. */
export const ORGANIZATION_ID = `${SITE_ORIGIN}/#organization`;
export const WEBSITE_ID = `${SITE_ORIGIN}/#website`;

/**
 * The similarly-named, unrelated domains. Listed so the disambiguation copy on /about,
 * in llms.txt and in disambiguatingDescription below all name the SAME set — three
 * hand-maintained lists is how one of them ends up a year out of date.
 * @type {string[]}
 */
export const UNAFFILIATED_DOMAINS = ['stagify.io', 'stagify.app', 'stagify.online', 'stagifyai.com'];

/**
 * The non-affiliation statement, in the one wording used everywhere it appears.
 * Written as a complete, quotable sentence pair on purpose: an assistant lifts a span of
 * text, not a fact graph, so the claim has to survive being quoted alone.
 */
export const NON_AFFILIATION = `Stagify.ai is an independent company and operates only at the domain stagify.ai. It is not affiliated with, endorsed by, or related to ${UNAFFILIATED_DOMAINS.slice(0, -1).join(', ')} or ${UNAFFILIATED_DOMAINS.at(-1)}, which are unrelated businesses with similar names.`;

/**
 * Every owned profile, in one list. `sameAs` only disambiguates when the link is
 * RECIPROCAL — each profile must point back at https://stagify.ai in its bio or website
 * field, or a crawler has one assertion instead of a confirmed pair. Adding a URL here
 * without doing that half is decoration.
 * @type {string[]}
 */
export const SAME_AS = [
  'https://www.instagram.com/stagify.ai/',
  'https://www.tiktok.com/@stagify.ai',
  'https://www.linkedin.com/company/stagify-ai/',
  'https://www.crunchbase.com/organization/stagify-ai',
  'https://www.indiehackers.com/Stagify',
  'https://stagify.substack.com',
  'https://stagifyai.blogspot.com',
  'https://www.tumblr.com/stagify',
];

/**
 * The founders, with the titles already stated in prose to the chat assistant at
 * lib/staging/designer-rules.js — the two have to agree, or the site contradicts its own
 * bot. Names and a founding date are the strongest cheap disambiguator there is: the
 * other four Stagifys have different ones.
 */
export const FOUNDERS = [
  { '@type': 'Person', name: 'Maximilian Ising', jobTitle: 'Co-Founder, Head of Development and AI' },
  { '@type': 'Person', name: 'Lucas Shtainer', jobTitle: 'Co-Founder, Head of Marketing' },
  { '@type': 'Person', name: 'Ryan Croman', jobTitle: 'Co-Founder, Head of Outreach' },
];

/** Company founding date (ISO 8601). */
export const FOUNDING_DATE = '2025-08-22';

/**
 * Third-party coverage, moved here verbatim from the hand-written Organization block in
 * index.html. Kept because corroboration by sources a crawler already trusts is how an
 * entity stops being a claim the site makes about itself — the exact gap that lets a
 * different Stagify's reviews get attached to this one.
 * @type {Record<string, unknown>[]}
 */
export const PRESS = [
    {
      "@type": "Article",
      "headline": "10 Best Virtual Staging AI Free Tools for 2026",
      "url": "https://armox.ai/blog/virtual-staging-ai-free#what-it-does-well",
      "datePublished": "2026-05-31",
      "author": {
        "@type": "Organization",
        "name": "Armox Labs",
        "url": "https://armox.ai"
      }
    },
    {
      "@type": "Article",
      "headline": "I Never Meant to Start an AI Company",
      "url": "https://medium.com/@ryancroman10/i-never-meant-to-start-an-ai-company-9115f58c0a3e",
      "datePublished": "2026-06-26",
      "publisher": {
        "@type": "Organization",
        "name": "Medium",
        "url": "https://medium.com"
      },
      "author": {
        "@type": "Person",
        "name": "Ryan Croman",
        "url": "https://medium.com/@ryancroman10"
      },
      "about": {
        "@id": "https://stagify.ai/#organization"
      }
    },
    {
      "@type": "Article",
      "headline": "I Never Meant to Start an AI Company",
      "url": "https://activerain.com/blogsview/5938752/i-never-meant-to-start-an-ai-company",
      "datePublished": "2026-06-26",
      "publisher": {
        "@type": "Organization",
        "name": "ActiveRain",
        "url": "https://activerain.com"
      },
      "author": {
        "@type": "Person",
        "name": "Ryan Croman"
      },
      "about": {
        "@id": "https://stagify.ai/#organization"
      }
    },
    {
      "@type": "Article",
      "headline": "I Never Meant to Start an AI Company",
      "url": "https://stagify.substack.com/p/i-never-meant-to-start-an-ai-company",
      "datePublished": "2026-06-26",
      "publisher": {
        "@type": "Organization",
        "name": "Substack",
        "url": "https://substack.com"
      },
      "author": {
        "@type": "Person",
        "name": "Ryan Croman"
      },
      "about": {
        "@id": "https://stagify.ai/#organization"
      }
    },
    {
      "@type": "Article",
      "headline": "The Room Doesn't Need to Change. You Just Need to See It Differently.",
      "url": "https://dev.to/ryan_croman_dc8f0b39757a6/the-room-doesnt-need-to-change-you-just-need-to-see-it-differently-4499",
      "datePublished": "2026-07-22",
      "publisher": {
        "@type": "Organization",
        "name": "DEV Community",
        "url": "https://dev.to"
      },
      "author": {
        "@type": "Person",
        "name": "Ryan Croman"
      },
      "about": {
        "@id": "https://stagify.ai/#organization"
      }
    },
    {
      "@type": "Article",
      "headline": "The Room Doesn't Need to Change. You Just Need to See It Differently.",
      "url": "https://stagify.substack.com/p/the-room-doesnt-need-to-change-you",
      "datePublished": "2026-07-22",
      "publisher": {
        "@type": "Organization",
        "name": "Substack",
        "url": "https://substack.com"
      },
      "author": {
        "@type": "Person",
        "name": "Ryan Croman"
      },
      "about": {
        "@id": "https://stagify.ai/#organization"
      }
    },
    {
      "@type": "Article",
      "headline": "The Room Doesn't Need to Change. You Just Need to See It Differently.",
      "url": "https://stagifyai.blogspot.com/2026/07/the-room-doesnt-need-to-change-you-just.html",
      "datePublished": "2026-07-22",
      "publisher": {
        "@type": "Organization",
        "name": "Blogger",
        "url": "https://www.blogger.com"
      },
      "author": {
        "@type": "Person",
        "name": "Ryan Croman"
      },
      "about": {
        "@id": "https://stagify.ai/#organization"
      }
    },
    {
      "@type": "Article",
      "headline": "The Room Doesn't Need to Change. You Just Need to See It Differently.",
      "url": "https://www.tumblr.com/stagify/822862652524167168/the-room-doesnt-need-to-change-you-just-need-to",
      "datePublished": "2026-07-22",
      "publisher": {
        "@type": "Organization",
        "name": "Tumblr",
        "url": "https://www.tumblr.com"
      },
      "author": {
        "@type": "Person",
        "name": "Ryan Croman"
      },
      "about": {
        "@id": "https://stagify.ai/#organization"
      }
    }
  ];

/**
 * The canonical Organization node.
 *
 * `press` controls whether the eight `subjectOf` articles ride along. They are a real
 * entity signal (third-party coverage is what a knowledge graph corroborates an entity
 * with) but they are ~7 KB, and repeating them on twenty pages would put more bytes of
 * press clippings than markup into the average page. They ship on the two pages that
 * are ABOUT the company — the homepage and /about — and the shared `@id` merges them
 * into the same entity everywhere else.
 * @param {{ press?: boolean }} [opts]
 * @returns {Record<string, unknown>}
 */
export function organizationNode({ press = false } = {}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': ORGANIZATION_ID,
    name: 'Stagify.ai',
    legalName: 'Stagify.ai',
    // The short form is what people and models actually type, and it is the exact string
    // that collides with the other four. Binding it to this entity explicitly is the
    // single most load-bearing property in this object.
    alternateName: ['Stagify', 'Stagify AI', 'stagify.ai'],
    url: `${SITE_ORIGIN}/`,
    logo: `${SITE_ORIGIN}/media-webp/logo/Logo180x180.webp`,
    image: `${SITE_ORIGIN}/og-image.png`,
    description: 'Free AI-powered virtual staging tool for real estate professionals',
    disambiguatingDescription: NON_AFFILIATION,
    slogan: 'Upload. Stage. Imagine.',
    email: 'team@stagify.ai',
    telephone: '+1-929-251-4372',
    foundingDate: FOUNDING_DATE,
    founder: FOUNDERS,
    contactPoint: [
      {
        '@type': 'ContactPoint',
        contactType: 'customer service',
        telephone: '+1-929-251-4372',
        email: 'team@stagify.ai',
        areaServed: 'US',
        availableLanguage: ['English', 'Spanish', 'French', 'German', 'Chinese', 'Korean', 'Portuguese', 'Russian', 'Italian', 'Japanese', 'Dutch'],
      },
    ],
    sameAs: SAME_AS,
    ...(press ? { subjectOf: PRESS } : {}),
  };
}

/**
 * The WebSite node — homepage only, since there is one website and it is declared once.
 * It carries the same alternateName array as the Organization because the two entities
 * are searched for by the same colliding string, and `publisher` ties them together.
 * @returns {Record<string, unknown>}
 */
export function websiteNode() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': WEBSITE_ID,
    name: 'Stagify.ai',
    alternateName: ['Stagify', 'Stagify AI'],
    url: `${SITE_ORIGIN}/`,
    description: 'Free AI-powered virtual staging tool for real estate professionals',
    inLanguage: ['en', 'es', 'fr', 'de', 'zh-Hans', 'ko', 'pt-BR', 'ru', 'it', 'ja', 'nl'],
    publisher: { '@id': ORGANIZATION_ID },
  };
}

/** Opening marker for the generated block. Matched by the build step and the drift test. */
export const BEGIN_MARKER = '<!-- BEGIN ORGANIZATION JSON-LD — generated by scripts/build-i18n-seo.js, do not hand-edit -->';
/** Closing marker for the generated block. */
export const END_MARKER = '<!-- END ORGANIZATION JSON-LD -->';

/**
 * One JSON-LD `<script>`, pretty-printed at `indent` so the baked output reads like the
 * hand-authored blocks beside it rather than a minified smear in a diff.
 * @param {Record<string, unknown>} node
 * @param {string} indent
 * @returns {string}
 */
function scriptFor(node, indent) {
  const body = JSON.stringify(node, null, 2)
    .split('\n')
    .map((line) => indent + line)
    .join('\n');
  return `${indent}<script type="application/ld+json">\n${body}\n${indent}</script>`;
}

/**
 * The full generated region: markers, the Organization block, and on the homepage the
 * WebSite block. Lines are joined with '\n'; the caller re-joins with the file's own EOL,
 * the same way injectHreflang does — an unconditional LF write shows up as a whole-file
 * diff on a CRLF checkout.
 * @param {{ press?: boolean, website?: boolean, indent?: string }} [opts]
 * @returns {string}
 */
export function renderOrganizationBlock({ press = false, website = false, indent = '    ' } = {}) {
  const parts = [indent + BEGIN_MARKER, scriptFor(organizationNode({ press }), indent)];
  if (website) parts.push(scriptFor(websiteNode(), indent));
  parts.push(indent + END_MARKER);
  return parts.join('\n');
}
