// A throwaway static server rooted at the repo root, plus an in-memory slot for the
// post HTML itself.
//
// Why a server at all, rather than page.setContent() over file://: the post HTML pulls
// `/public/styles/...` and `/public/fonts/*.woff2`, and @font-face URLs inside a
// stylesheet resolve against the STYLESHEET's URL, not the page's. Over file:// that
// works only by accident and font fetches are subject to opaque-origin rules; over a
// real http origin every relative URL resolves the way it does in the browser, which is
// the whole reason we render in Chromium instead of compositing by hand.
//
// The page HTML is served from memory at /__post/<id>.html rather than written to disk,
// so a crashed render leaves no stray files in the repo.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

/**
 * @param {string} rootDir absolute path served as `/`
 * @returns {Promise<{ origin: string, put(id: string, html: string): string, close(): Promise<void> }>}
 */
export function startAssetServer(rootDir) {
  /** @type {Map<string, string>} */
  const pages = new Map();

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

      if (urlPath.startsWith('/__post/')) {
        const html = pages.get(urlPath);
        if (html === undefined) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('no such post page');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      // Resolve inside rootDir only. path.join collapses `..`, and comparing the
      // relative path back catches anything that escaped.
      const abs = path.join(rootDir, urlPath);
      const rel = path.relative(rootDir, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('forbidden');
        return;
      }

      fs.readFile(abs, (err, buf) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(buf);
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve({
        origin,
        /** Register a page and return the URL to navigate to. */
        put(id, html) {
          const routePath = `/__post/${id}.html`;
          pages.set(routePath, html);
          return `${origin}${routePath}`;
        },
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
