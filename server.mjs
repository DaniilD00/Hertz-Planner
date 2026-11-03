// Runs the finished map: serves the built site from dist/ and the local API from server/api.mjs.
// Start with `npm start` (or double-click start.bat on Windows), then open http://localhost:3000
// start.bat runs this with `node --watch`, so the server restarts by itself when its files are updated.

import { exec } from 'node:child_process';
import http from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { createApi } from './server/api.mjs';
import { flushStores } from './server/util.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(root, 'dist');
const port = Number(process.env.PORT) || 3000;
const api = createApi({ cacheDir: path.join(root, 'cache') });

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res) {
  const { pathname } = new URL(req.url || '/', 'http://localhost');
  let file = path.normalize(path.join(distDir, decodeURIComponent(pathname)));
  if (!file.startsWith(distDir)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    file = path.join(distDir, 'index.html');
  }
  try {
    let body = await readFile(file);
    const ext = path.extname(file);
    const headers = { 'content-type': types[ext] || 'application/octet-stream' };
    headers['cache-control'] = pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    if (/^(text|application\/json|image\/svg)/.test(headers['content-type']) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      body = zlib.gzipSync(body);
      headers['content-encoding'] = 'gzip';
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('The site has not been built yet. Run "npm run build" first, or use "npm run dev".');
  }
}

// Save unsaved cache changes (road shapes, addresses) before stopping: Ctrl+C, closing the window, or a --watch restart
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => {
    flushStores();
    process.exit(0);
  });
}

const openCmd = (url) => (process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`);

/**
 * Open the map in the browser once per start. Under `node --watch` the server restarts after an update, but its
 * parent (the watcher in the start.bat window) stays the same, so remembering the parent avoids a new tab each time.
 */
async function openOnce(url) {
  const marker = path.join(root, 'cache', 'opened-for.txt');
  try {
    if ((await readFile(marker, 'utf8')).trim() === String(process.ppid)) return;
  } catch {
    /* first start */
  }
  try {
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, String(process.ppid));
  } catch {
    /* can't remember: still open the page */
  }
  exec(openCmd(url), () => {});
}

http
  .createServer(async (req, res) => {
    if (await api(req, res)) return;
    await serveStatic(req, res);
  })
  .listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  Free car trips map is running at ${url}\n  Press Ctrl+C (or close this window) to stop.\n`);
    if (process.argv.includes('--open')) void openOnce(url);
  })
  .on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${port} is already in use: the map is probably running in another window. Opening it.\n`);
      if (process.argv.includes('--open')) exec(openCmd(`http://localhost:${port}`), () => {});
    } else console.error(err);
    setTimeout(() => process.exit(1), 500); // give the browser a moment to start
  });
