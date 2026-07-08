// /faq.html is a permanent redirect to the FAQ section on the homepage. The
// <meta http-equiv="refresh"> handles the no-JS case; this replaces the location
// immediately (without adding a history entry) when JS is available. Externalised
// from an inline <script> so the CSP can drop 'unsafe-inline' from script-src.
location.replace('index.html#faq');
