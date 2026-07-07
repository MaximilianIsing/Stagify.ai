// Tier 1 — static checks (no server, no network).
//
// Three cheap gates that catch the mistakes a boot test won't:
//   1. Syntax of server.js + every lib/*.js (a parse error = dead deploy).
//   2. Local asset references in public/*.html actually exist on disk
//      (catches broken <script>/<link>/<img> paths after file reworks/renames).
//   3. Every languages/*.json parses and carries english.json's keys.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function flattenKeys(obj, prefix = '') {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) keys.push(...flattenKeys(v, full));
    else keys.push(full);
  }
  return keys;
}

test('server.js and lib modules are syntactically valid', () => {
  const files = [
    'server.js',
    ...fs.readdirSync(path.join(ROOT, 'lib'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => path.join('lib', f)),
  ];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', f], { cwd: ROOT, stdio: 'pipe' });
    } catch (e) {
      throw new Error(`Syntax error in ${f}:\n${e.stderr?.toString() || e.message}`, { cause: e });
    }
  }
});

test('client scripts in public/scripts are syntactically valid', () => {
  const scripts = walk(path.join(PUBLIC, 'scripts')).filter((f) => f.endsWith('.js'));
  assert.ok(scripts.length > 0, 'expected at least one client script');
  for (const f of scripts) {
    try {
      execFileSync(process.execPath, ['--check', f], { cwd: ROOT, stdio: 'pipe' });
    } catch (e) {
      throw new Error(`Syntax error in ${path.relative(ROOT, f)}:\n${e.stderr?.toString() || e.message}`, { cause: e });
    }
  }
});

test('local asset references in public/*.html exist on disk', () => {
  const htmlFiles = walk(PUBLIC).filter((f) => f.endsWith('.html'));
  // Only asset-bearing tags — <a href> navigation is skipped (clean-URL routes
  // like /privacy are served by the app, not files, and would false-positive).
  const patterns = [
    /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi,
    /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /<source\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /<video\b[^>]*\bposter\s*=\s*["']([^"']+)["']/gi,
  ];
  // Only assert on things that are clearly static files (by extension).
  const fileExt = /\.(js|mjs|css|png|jpe?g|webp|svg|gif|ico|mp4|webm|woff2?|json|xml|txt)$/i;
  const missing = [];

  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf8');
    for (const re of patterns) {
      let m;
      while ((m = re.exec(html))) {
        const raw = m[1].trim();
        const ref = raw.split('#')[0].split('?')[0].trim();
        if (!ref) continue;
        if (/^(https?:)?\/\//i.test(ref)) continue;               // external / protocol-relative
        if (/^(data|mailto|tel|javascript|blob):/i.test(ref)) continue;
        if (ref.startsWith('{{') || ref.includes('${')) continue;  // templated
        if (!fileExt.test(ref)) continue;                          // clean-URL route, not a file
        const resolved = ref.startsWith('/')
          ? path.join(PUBLIC, ref)
          : path.join(path.dirname(file), ref);
        if (!fs.existsSync(resolved)) {
          missing.push(`${path.relative(ROOT, file)}  →  ${raw}`);
        }
      }
    }
  }

  assert.equal(missing.length, 0, `Broken asset reference(s):\n${missing.join('\n')}`);
});

function loadLanguages() {
  const langDir = path.join(PUBLIC, 'languages');
  const parsed = {};
  for (const f of fs.readdirSync(langDir).filter((n) => n.endsWith('.json'))) {
    parsed[f] = JSON.parse(fs.readFileSync(path.join(langDir, f), 'utf8'));
  }
  return parsed;
}

// Hard gate: a malformed language file genuinely breaks that locale's page load.
test('every language file is valid, non-empty JSON', () => {
  const langDir = path.join(PUBLIC, 'languages');
  const files = fs.readdirSync(langDir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'expected at least one language file');
  for (const f of files) {
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(path.join(langDir, f), 'utf8'));
    } catch (e) {
      throw new Error(`Invalid JSON in languages/${f}: ${e.message}`, { cause: e });
    }
    assert.ok(
      obj && typeof obj === 'object' && Object.keys(obj).length > 0,
      `languages/${f} should be a non-empty object`,
    );
  }
});

// Hard gate: every non-English locale must cover all of english.json's keys. When you
// add an English string, translate it in every locale or the build fails here. To
// temporarily downgrade this to non-blocking, add `{ todo: 'reason' }` as the 2nd arg.
test('translations cover english.json keys', () => {
  const parsed = loadLanguages();
  const baseKeys = flattenKeys(parsed['english.json']);
  const mismatches = [];
  for (const [f, obj] of Object.entries(parsed)) {
    if (f === 'english.json') continue;
    const keys = new Set(flattenKeys(obj));
    const missingKeys = baseKeys.filter((k) => !keys.has(k));
    if (missingKeys.length) {
      const preview = missingKeys.slice(0, 5).join(', ');
      mismatches.push(`${f}: missing ${missingKeys.length} key(s) [${preview}${missingKeys.length > 5 ? ', …' : ''}]`);
    }
  }
  assert.equal(mismatches.length, 0, `Language key coverage gaps:\n${mismatches.join('\n')}`);
});

test('sitemap.xml and manifest.json are well-formed; manifest icons exist', () => {
  const sitemap = fs.readFileSync(path.join(PUBLIC, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /<urlset[\s>]/, 'sitemap should open <urlset>');
  assert.match(sitemap, /<\/urlset>\s*$/, 'sitemap should close <urlset>');
  assert.match(sitemap, /<loc>https?:\/\//, 'sitemap should list at least one <loc>');

  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'manifest should list icons');
  const missingIcons = manifest.icons
    .map((i) => i.src)
    .filter((src) => src && !fs.existsSync(path.join(PUBLIC, src.replace(/^\//, ''))));
  assert.equal(missingIcons.length, 0, `manifest icon file(s) missing: ${missingIcons.join(', ')}`);
});

test('promptMatrix has a non-empty prompt for every room/style', async () => {
  const { promptMatrix } = await import('../lib/promptMatrix.js');
  const rooms = Object.keys(promptMatrix);
  assert.ok(rooms.length > 0, 'promptMatrix should define room types');
  const bad = [];
  for (const room of rooms) {
    const styles = promptMatrix[room];
    assert.ok(styles && typeof styles === 'object', `${room} should map styles to prompts`);
    for (const [style, prompt] of Object.entries(styles)) {
      if (typeof prompt !== 'string' || prompt.trim().length < 20) {
        bad.push(`${room} / ${style}`);
      }
    }
  }
  assert.equal(bad.length, 0, `Empty or too-short prompt(s): ${bad.join(', ')}`);
});

test('every public HTML page has a non-empty title and charset + viewport meta', () => {
  const htmlFiles = walk(PUBLIC).filter((f) => f.endsWith('.html'));
  const problems = [];
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    if (!/<title[^>]*>[^<]*\S[^<]*<\/title>/i.test(html)) problems.push(`${rel}: missing a non-empty <title>`);
    if (!/<meta[^>]+charset=/i.test(html)) problems.push(`${rel}: missing <meta charset>`);
    if (!/<meta[^>]+name=["']viewport["']/i.test(html)) problems.push(`${rel}: missing viewport meta`);
  }
  assert.equal(problems.length, 0, `HTML metadata problems:\n${problems.join('\n')}`);
});

test('internal <a href> links to .html pages resolve to real files', () => {
  const htmlFiles = walk(PUBLIC).filter((f) => f.endsWith('.html'));
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
  const missing = [];
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = re.exec(html))) {
      const raw = m[1].trim();
      const ref = raw.split('#')[0].split('?')[0].trim();
      if (!ref) continue;
      if (/^(https?:)?\/\//i.test(ref)) continue;
      if (/^(data|mailto|tel|javascript|blob):/i.test(ref)) continue;
      if (ref.startsWith('{{') || ref.includes('${')) continue;
      // Only explicit .html links — clean-URL routes (e.g. /privacy) are served by the app.
      if (!/\.html$/i.test(ref)) continue;
      const resolved = ref.startsWith('/') ? path.join(PUBLIC, ref) : path.join(path.dirname(file), ref);
      if (!fs.existsSync(resolved)) missing.push(`${path.relative(ROOT, file)}  →  ${raw}`);
    }
  }
  assert.equal(missing.length, 0, `Broken internal .html link(s):\n${missing.join('\n')}`);
});
