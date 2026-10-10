/* Builds a preview of the WebView payload that runs in a desktop browser.
 *
 * The WebView page normally only runs inside the host, which makes layout,
 * theming and canvas work awkward to iterate on. This script copies the shipped
 * payload into `tools/preview/site`, generates the host's theme tokens as two
 * stylesheets, and injects a stand-in for the host transport with an in-memory
 * dataset store, so the real `index.html` and the real scripts run unchanged.
 *
 *   node tools/preview/build.mjs && node tools/preview/serve.mjs
 *
 * Nothing here is packaged: the build reads `src/web` and never the other way
 * round. The generated site is git-ignored.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const payload = join(here, '..', '..', 'src', 'web');
const site = join(here, 'site');

/* Mirrors SuiteTokens.kt as the host writes it into theme.css. */
const LIGHT = {
  'primary': '#006B5F', 'on-primary': '#FFFFFF', 'primary-container': '#C3E4DC', 'on-primary-container': '#00201B',
  'secondary-container': '#D5E7E2', 'on-secondary-container': '#0B1F1B',
  'background': '#F7FAF8', 'on-background': '#191C1B', 'surface': '#F7FAF8', 'on-surface': '#191C1B',
  'surface-low': '#F0F5F2', 'surface-container': '#EAF0ED', 'surface-high': '#E3EAE6', 'surface-highest': '#DCE5E1',
  'on-surface-variant': '#3F4946', 'outline': '#6F7976', 'outline-variant': '#BFC9C5',
  'error': '#BA1A1A', 'on-error': '#FFFFFF', 'error-container': '#FFDAD6', 'on-error-container': '#410002',
  'success': '#176B45', 'on-success': '#FFFFFF', 'success-container': '#B8ECCE', 'on-success-container': '#002512',
  'warning': '#7A4B00', 'on-warning': '#FFFFFF', 'warning-container': '#FFDDB3', 'on-warning-container': '#281800',
  'info': '#245D91', 'on-info': '#FFFFFF', 'info-container': '#D2E4FF', 'on-info-container': '#001C37',
};

const DARK = {
  'primary': '#82D5C6', 'on-primary': '#00372F', 'primary-container': '#005047', 'on-primary-container': '#9EF2E2',
  'secondary-container': '#334B47', 'on-secondary-container': '#D5E7E2',
  'background': '#0E1513', 'on-background': '#DEE4E1', 'surface': '#0E1513', 'on-surface': '#DEE4E1',
  'surface-low': '#151C1A', 'surface-container': '#1A2220', 'surface-high': '#252D2A', 'surface-highest': '#303936',
  'on-surface-variant': '#BFC9C5', 'outline': '#89938F', 'outline-variant': '#3F4946',
  'error': '#FFB4AB', 'on-error': '#690005', 'error-container': '#93000A', 'on-error-container': '#FFDAD6',
  'success': '#88D5A6', 'on-success': '#00391F', 'success-container': '#00522F', 'on-success-container': '#A4F2C3',
  'warning': '#F3BD6F', 'on-warning': '#432C00', 'warning-container': '#5D4200', 'on-warning-container': '#FFDDB3',
  'info': '#A3C9FF', 'on-info': '#00315C', 'info-container': '#074875', 'on-info-container': '#D2E4FF',
};

const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 };

const TYPE = {
  'headline-large': [32, 40, 700],
  'headline-small': [24, 32, 600],
  'title-large': [22, 28, 600],
  'title-medium': [16, 24, 600],
  'body-large': [16, 24, 400],
  'body-medium': [14, 20, 400],
  'body-small': [12, 16, 400],
  'label-large': [14, 20, 600],
  'label-medium': [12, 16, 500],
};

function theme(palette, dark) {
  const lines = [`:root{color-scheme:${dark ? 'dark' : 'light'}`];
  for (const [name, value] of Object.entries(palette)) lines.push(`--ats-${name}:${value}`);
  for (const [name, value] of Object.entries(SPACE)) lines.push(`--ats-space-${name}:${value}px`);
  lines.push('--ats-card-radius:24px', '--ats-inner-radius:16px', '--ats-chip-radius:12px', '--ats-dialog-radius:28px');
  lines.push('--ats-content-max-width:720px', "--ats-font-family:system-ui,-apple-system,'Noto Sans SC',sans-serif");
  for (const [style, [size, line, weight]] of Object.entries(TYPE)) {
    lines.push(`--ats-type-${style}-size:${size}px`, `--ats-type-${style}-line:${line}px`, `--ats-type-${style}-weight:${weight}`);
  }
  return `${lines.join(';')}}`;
}

/* An in-memory stand-in for the host transport, including the RPC handshake and
   the dataset read/write protocol the page uses for storage. */
const HARNESS = `(() => {
  const pluginId = 'wheel_decide';
  const sessionId = 'preview';
  const datasets = new Map();
  const handles = new Map();
  let nextHandle = 1;

  for (const [id, value] of Object.entries(${JSON.stringify(seedData())})) {
    datasets.set(id, new TextEncoder().encode(JSON.stringify(value)));
  }

  const encode = bytes => { let out = ''; for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(out); };
  const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));

  function dispatch(method, payload) {
    switch (method) {
      case 'storage.dataset.openRead': {
        if (!datasets.has(payload.datasetId)) return {found: false};
        const handle = String(nextHandle++);
        handles.set(handle, {id: payload.datasetId});
        return {found: true, handle, size: datasets.get(payload.datasetId).length};
      }
      case 'storage.dataset.read': {
        const entry = handles.get(payload.handle);
        const bytes = datasets.get(entry.id);
        const part = bytes.subarray(payload.offset, payload.offset + payload.maxBytes);
        return {bytes: encode(part), offset: payload.offset, eof: payload.offset + part.length >= bytes.length};
      }
      case 'storage.dataset.abort': handles.delete(payload.handle); return {};
      case 'storage.dataset.openWrite': {
        const handle = String(nextHandle++);
        handles.set(handle, {id: payload.datasetId, chunks: []});
        return {handle, maxBytes: 1048576};
      }
      case 'storage.dataset.write': handles.get(payload.handle).chunks.push(decode(payload.bytes)); return {written: 1};
      case 'storage.dataset.commit': {
        const entry = handles.get(payload.handle);
        const total = entry.chunks.reduce((sum, part) => sum + part.length, 0);
        const bytes = new Uint8Array(total);
        let cursor = 0;
        for (const part of entry.chunks) { bytes.set(part, cursor); cursor += part.length; }
        datasets.set(entry.id, bytes);
        handles.delete(payload.handle);
        return {sha256: 'preview', size: total};
      }
      case 'app.getSession': return {pluginId, permissions: []};
      default: return {};
    }
  }

  function send(message) { window.atsTransport.onmessage({data: JSON.stringify(message)}); }

  window.atsTransport = {
    onmessage: null,
    postMessage(raw) {
      const message = JSON.parse(raw);
      if (message.kind === 'hello') {
        send({protocol: '2.0', kind: 'ready', pluginId, sessionId, requestId: '0', payload: {
          platform: {id: 'preview', api: 34}, protocol: '2.0',
          capabilities: ['app', 'storage', 'clipboard'],
          permissions: [{capability: 'clipboard', title: '剪贴板', risk: 'sensitive', state: 'granted', optional: true}],
          theme: {dark: document.documentElement.dataset.theme === 'dark', css: ''},
          container: {widthDp: window.innerWidth, heightDp: window.innerHeight},
        }});
        return;
      }
      if (message.kind !== 'request') return;
      let result;
      try { result = dispatch(message.method, message.payload || {}); }
      catch (error) {
        send({protocol: '2.0', kind: 'response', pluginId, sessionId, requestId: message.requestId, ok: false,
          error: {code: 'INTERNAL', message: String(error), retryable: false}});
        return;
      }
      setTimeout(() => send({protocol: '2.0', kind: 'response', pluginId, sessionId, requestId: message.requestId, ok: true, result}), 0);
    },
  };

  /* ?spin=1 clicks the primary action and ?open=<id> opens a dialog, so a
     screenshot can show those states without a device. */
  const params = new URLSearchParams(location.search);
  const clickWhenReady = id => {
    let waited = 0;
    const timer = setInterval(() => {
      waited += 50;
      const button = document.getElementById(id);
      if (button && !button.disabled && !document.body.classList.contains('initializing')) { clearInterval(timer); button.click(); }
      else if (waited > 3000) clearInterval(timer);
    }, 50);
  };
  window.addEventListener('load', () => {
    const open = params.get('open');
    if (open) { clickWhenReady({preset: 'wheel-picker', import: 'open-import', help: 'help-open', save: 'open-save'}[open]); return; }
    if (params.get('spin') === '1') clickWhenReady('spin');
  });
})();
`;

function seedData() {
  const now = Date.now();
  const option = (id, label, value) => ({ id, label, value, enabled: true });
  const config = extra => ({
    mode: 'score', temperature: 0.5, power: 1, floorPercent: 0,
    postSpin: 'keep', decayFactor: 0.5, cooldownSpins: 3, drawCount: 1, algorithm: 'prefix', ...extra,
  });
  return {
    'wheel-presets': {
      formatVersion: 1,
      activeWheelId: 'wheel-dinner',
      prefs: { historyOpen: true, showProbability: true, lastMode: 'score' },
      wheels: [
        {
          id: 'wheel-dinner', name: '今晚吃什么', createdAt: now - 60000, updatedAt: now - 60000,
          options: [option('o1', '火锅', 5), option('o2', '日料', 3), option('o3', '烧烤', 2), option('o4', '沙拉', 0.5), option('o5', '随便煮点面', 1), option('o6', '出去吃', 2)],
          config: config({ postSpin: 'remove' }),
        },
        {
          id: 'wheel-chore', name: '周末家务分配', createdAt: now - 86400000, updatedAt: now - 86400000,
          options: [option('c1', '拖地', 1), option('c2', '洗碗', 1), option('c3', '擦窗', 1), option('c4', '倒垃圾', 1)],
          config: config({ mode: 'equal' }),
        },
      ],
    },
    'wheel-history': {
      formatVersion: 1,
      entries: [
        { id: 'spin-3', at: now - 120000, wheelId: 'wheel-dinner', wheelName: '今晚吃什么', mode: 'score', label: '日料', probability: 0.2222, share: 22.2, detail: '已把「日料」移出本轮' },
        { id: 'spin-2', at: now - 300000, wheelId: 'wheel-dinner', wheelName: '今晚吃什么', mode: 'score', label: '火锅', probability: 0.3704, share: 37.0, detail: '已把「火锅」移出本轮' },
        { id: 'spin-1', at: now - 400000, wheelId: 'wheel-chore', wheelName: '周末家务分配', mode: 'equal', label: '洗碗', probability: 0.25, share: 25.0, detail: null },
      ],
    },
  };
}

rmSync(site, { recursive: true, force: true });
mkdirSync(site, { recursive: true });
cpSync(payload, site, { recursive: true });
writeFileSync(join(site, 'theme-light.css'), theme(LIGHT, false), 'utf8');
writeFileSync(join(site, 'theme-dark.css'), theme(DARK, true), 'utf8');
writeFileSync(join(site, 'preview-transport.js'), HARNESS, 'utf8');
writeFileSync(join(site, 'build-version.js'), 'window.wheelBuild={version:"preview"};\n', 'utf8');

const source = readFileSync(join(payload, 'index.html'), 'utf8');
for (const [name, dark] of [['light', false], ['dark', true]]) {
  writeFileSync(join(site, `${name}.html`), source
    .replace('/__ats__/theme.css', `theme-${name}.css`)
    .replace('<html lang="zh-CN">', `<html lang="zh-CN" data-theme="${name}">`)
    .replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="ats-plugin-id" content="wheel_decide"><meta name="ats-session-id" content="preview">')
    .replace('<script src="runtime.js" defer></script>', '<script src="preview-transport.js" defer></script><script src="runtime.js" defer></script>'), 'utf8');
}
cpSync(join(site, 'light.html'), join(site, 'index.html'));

console.log(`preview built at ${site}`);
console.log('open http://127.0.0.1:8791/light.html, dark.html, "?spin=1" or "?open=preset"');
