/* Screenshots the preview at exact device sizes over the DevTools protocol.
 *
 * Headless `--window-size` does not map to a CSS viewport width on Windows, so
 * the page is driven through `Emulation.setDeviceMetricsOverride` instead. This
 * is also what makes a phone-width check meaningful: the failure this catches
 * is horizontal overflow at 400 dp, not at whatever width the window happened
 * to have.
 *
 *   node tools/preview/build.mjs
 *   node tools/preview/serve.mjs            # in another shell
 *   node tools/preview/shoot.mjs            # writes tools/preview/output/*.png
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const output = join(here, 'output');
const port = Number(process.env.PREVIEW_PORT || 8791);
const debugPort = Number(process.env.PREVIEW_DEBUG_PORT || 9333);
const browser = process.env.PREVIEW_BROWSER
  || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);

if (!browser) {
  console.error('Set PREVIEW_BROWSER to a Chromium based browser executable.');
  process.exit(1);
}

const SHOTS = [
  { name: 'phone-light', width: 412, height: 915, page: 'light', query: '' },
  { name: 'phone-dark', width: 412, height: 915, page: 'dark', query: '' },
  { name: 'phone-spin', width: 412, height: 915, page: 'light', query: '?spin=1' },
  { name: 'dialog-preset', width: 412, height: 915, page: 'light', query: '?open=preset' },
  { name: 'dialog-preset-dark', width: 412, height: 915, page: 'dark', query: '?open=preset' },
  { name: 'dialog-import', width: 412, height: 915, page: 'light', query: '?open=import' },
  { name: 'dialog-save', width: 412, height: 915, page: 'light', query: '?open=save' },
  { name: 'dialog-help', width: 412, height: 915, page: 'light', query: '?open=help' },
  { name: 'narrow', width: 320, height: 800, page: 'light', query: '' },
  { name: 'wide-light', width: 900, height: 1000, page: 'light', query: '' },
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let next = 1;
  const pending = new Map();
  const events = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    for (const listener of events.get(message.method) || []) listener(message.params);
  });
  return {
    send(method, params = {}) {
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    once(method) {
      return new Promise(resolve => {
        const listeners = events.get(method) || [];
        const listener = params => {
          events.set(method, listeners.filter(item => item !== listener));
          resolve(params);
        };
        listeners.push(listener);
        events.set(method, listeners);
      });
    },
    close: () => socket.close(),
  };
}

const profile = mkdtempSync(join(tmpdir(), 'wheel-preview-'));
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

let endpoint = '';
for (let attempt = 0; attempt < 60 && !endpoint; attempt += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
    if (response.ok) endpoint = (await response.json()).webSocketDebuggerUrl;
  } catch { /* not up yet */ }
  if (!endpoint) await sleep(250);
}
if (!endpoint) throw new Error('the browser never exposed a DevTools endpoint');

mkdirSync(output, { recursive: true });
const browserSession = await connect(endpoint);
let failures = 0;

for (const shot of SHOTS) {
  const created = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const session = await connect(created.webSocketDebuggerUrl);
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: shot.width, height: shot.height, deviceScaleFactor: 2, mobile: shot.width < 600,
  });
  const loaded = session.once('Page.loadEventFired');
  await session.send('Page.navigate', { url: `http://127.0.0.1:${port}/${shot.page}.html${shot.query}` });
  await loaded;
  await sleep(shot.query.includes('spin') ? 4200 : 1400);

  const measured = await session.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `JSON.stringify({
      viewport: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll('body *')]
        .filter(node => node.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
        .filter(node => !node.closest('.filter-row'))
        .map(node => node.tagName + '.' + (node.className || node.id)).slice(0, 6),
    })`,
  });
  const result = JSON.parse(measured.result.value);
  if (result.scroll > result.viewport || result.overflow.length > 0) {
    failures += 1;
    console.error(`${shot.name}: horizontal overflow at ${result.viewport}px -> ${result.overflow.join(', ')}`);
  }
  const screenshot = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(output, `${shot.name}.png`), Buffer.from(screenshot.data, 'base64'));
  console.log(`${shot.name}: ${result.viewport}px, scrollWidth ${result.scroll}`);
  session.close();
  await browserSession.send('Target.closeTarget', { targetId: created.id });
}

child.kill();
await sleep(400);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold the profile */ }
console.log(failures === 0 ? `screenshots written to ${output}` : `${failures} shot(s) overflow horizontally`);
process.exit(failures === 0 ? 0 : 1);
