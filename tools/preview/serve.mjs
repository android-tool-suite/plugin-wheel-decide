import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), 'site');
const port = Number(process.env.PREVIEW_PORT || 8791);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
  const target = join(site, relative === '' ? 'index.html' : relative);
  if (!target.startsWith(site)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(target);
    response.writeHead(200, { 'content-type': types[extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`preview serving http://127.0.0.1:${port}/`));
