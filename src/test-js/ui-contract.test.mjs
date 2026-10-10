import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* Static contract checks. The Web payload cannot be rendered in a unit test, so
   these assertions cover the failure modes that would otherwise only show up as
   a blank page on a device: an element id that does not exist, a script that is
   not shipped, a capability the manifest does not declare, and a design token
   the host never defines. */

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const web = name => read(`src/web/${name}`);
const exists = path => existsSync(fileURLToPath(new URL(path, root)));

const html = read('src/web/index.html');
const appJs = read('src/web/app.js');
const styles = read('src/web/styles.css');

/* The manifest is a template; the build substitutes the version fields exactly
   the way this does, so parsing it here validates the shipped shape. */
function manifest() {
  const template = read('src/manifest.template.json');
  const placeholders = template.match(/@[A-Z_]+@/g) || [];
  assert.deepEqual(
    [...new Set(placeholders)].sort(),
    ['@MIN_HOST_VERSION_CODE@', '@VERSION_CODE@', '@VERSION_NAME@'],
    'the manifest template defines a placeholder the build does not substitute',
  );
  return JSON.parse(
    template
      .replaceAll('@VERSION_NAME@', '1.0.0')
      .replaceAll('@VERSION_CODE@', '1')
      .replaceAll('@MIN_HOST_VERSION_CODE@', '24'),
  );
}

const manifestJson = manifest();

const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));

function collectedIds() {
  const body = /for \(const id of \[([\s\S]*?)\]\) \{/.exec(appJs);
  assert.ok(body, 'app.js no longer looks up its elements from a single id list');
  return [...body[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
}

function referencedIds() {
  const found = new Set();
  for (const match of appJs.matchAll(/document\.getElementById\('([^']+)'\)/g)) found.add(match[1]);
  for (const match of appJs.matchAll(/elements(?:\.([A-Za-z][\w-]*)|\[(?:'([^']+)'|"([^"]+)")\])/g)) {
    const name = match[1] || match[2] || match[3];
    if (name) found.add(name);
  }
  return found;
}

test('every element the page script looks up exists in the markup', () => {
  const missing = collectedIds().filter(id => !htmlIds.has(id));
  assert.deepEqual(missing, [], `index.html is missing these ids: ${missing.join(', ')}`);
});

test('no element is used without being registered in the lookup list', () => {
  const listed = new Set(collectedIds());
  const unlisted = [...referencedIds()].filter(id => !listed.has(id));
  assert.deepEqual(unlisted, [], `app.js uses elements that are never collected: ${unlisted.join(', ')}`);
});

test('every script and stylesheet the page loads is shipped in the package', () => {
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.length > 0);
  for (const script of scripts) {
    /* build-version.js is generated at packaging time from the version fields. */
    if (script === 'build-version.js') continue;
    assert.ok(exists(`src/web/${script}`), `${script} is referenced but not present in src/web`);
  }
  for (const match of html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)) {
    if (match[1].startsWith('/__ats__/')) continue;
    assert.ok(exists(`src/web/${match[1]}`), `${match[1]} is referenced but not present in src/web`);
  }
  /* The host injects the theme; a page must not carry a second copy of it. */
  assert.match(html, /<link rel="stylesheet" href="\/__ats__\/theme\.css">/);
});

test('the page keeps to what the host content policy allows', () => {
  assert.equal(/<script(?![^>]*\ssrc=)/i.test(html), false, 'inline <script> is blocked by the host content policy');
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'inline event handlers are blocked by the host content policy');
  assert.equal(/<iframe/i.test(html), false, 'frames are blocked by the host content policy');
  assert.equal(/<form[^>]*\saction=/i.test(html), false, 'form submission is blocked by the host content policy');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
  for (const script of scripts) {
    if (script === 'build-version.js') continue;
    const source = web(script);
    assert.equal(/\b(localStorage|sessionStorage|indexedDB)\b/.test(source), false, `${script} uses storage the host disables`);
    assert.equal(/\bfetch\s*\(|XMLHttpRequest|new WebSocket/.test(source), false, `${script} reaches the network directly`);
    assert.equal(/\bdocument\.write\b/.test(source), false, `${script} writes the document`);
    assert.equal(/\beval\s*\(|new Function\s*\(/.test(source), false, `${script} evaluates code at runtime`);
  }
});

test('the wheel canvas is described for readers who cannot see it', () => {
  assert.match(html, /<canvas id="wheel"[^>]*role="img"/, 'the canvas needs role="img"');
  assert.match(html, /<canvas id="wheel"[^>]*aria-label=/, 'the canvas needs a text alternative');
  assert.match(appJs, /setAttribute\('aria-label', summary\)/, 'the canvas label is never updated');
  /* The same numbers have to exist as text, because a canvas is opaque to
     assistive technology. */
  assert.match(html, /<ol id="options"/);
});

test('every design token the plugin uses is one the host defines', () => {
  const colours = [
    'primary', 'on-primary', 'primary-container', 'on-primary-container',
    'secondary-container', 'on-secondary-container',
    'background', 'on-background', 'surface', 'on-surface',
    'surface-low', 'surface-container', 'surface-high', 'surface-highest',
    'on-surface-variant', 'outline', 'outline-variant',
    'error', 'on-error', 'error-container', 'on-error-container',
    'success', 'on-success', 'success-container', 'on-success-container',
    'warning', 'on-warning', 'warning-container', 'on-warning-container',
    'info', 'on-info', 'info-container', 'on-info-container',
  ];
  const spacing = ['xs', 'sm', 'md', 'lg', 'xl', 'xxl', 'xxxl'].map(size => `space-${size}`);
  const radii = ['card-radius', 'inner-radius', 'chip-radius', 'dialog-radius'];
  const misc = ['content-max-width', 'font-family'];
  const type = [];
  for (const style of [
    'headline-large', 'headline-small', 'title-large', 'title-medium',
    'body-large', 'body-medium', 'body-small', 'label-large', 'label-medium',
  ]) {
    for (const part of ['size', 'line', 'weight']) type.push(`type-${style}-${part}`);
  }
  const allowed = new Set([...colours, ...spacing, ...radii, ...misc, ...type]);

  const sources = { 'styles.css': styles };
  for (const match of html.matchAll(/<script src="([^"]+)"/g)) {
    if (match[1] !== 'build-version.js') sources[match[1]] = web(match[1]);
  }
  const unknown = new Map();
  for (const [name, source] of Object.entries(sources)) {
    for (const match of source.matchAll(/--ats-([a-z0-9-]+)/g)) {
      if (!allowed.has(match[1])) {
        if (!unknown.has(match[1])) unknown.set(match[1], []);
        unknown.get(match[1]).push(name);
      }
    }
  }
  assert.deepEqual(
    [...unknown.entries()],
    [],
    `styles.css/scripts reference tokens the host never defines: ${[...unknown.keys()].join(', ')}`,
  );
});

test('the plugin does not carry a second copy of the theme', () => {
  assert.equal(/prefers-color-scheme/.test(styles), false, 'the host pins the colour scheme; a dark media query drifts from it');
  assert.equal(/#[0-9a-fA-F]{6}\b/.test(styles.replace(/#[0-9a-fA-F]{3,8}\b(?=[^;]*backdrop)/g, '')), false,
    'a literal colour in styles.css will not follow the host palette');
  for (const [name, source] of Object.entries({ 'app.js': appJs, 'wheel-canvas.js': web('wheel-canvas.js') })) {
    assert.equal(/#[0-9a-fA-F]{6}\b/.test(source.replace(/'#[0-9A-F]{6}'/g, '')), false, `${name} hard codes a colour`);
  }
});

test('the manifest declares exactly the capabilities and datasets the code calls', () => {
  const capabilities = new Set(manifestJson.requires.capabilities.map(item => item.id));
  for (const capability of ['app', 'storage']) {
    assert.ok(capabilities.has(capability), `the manifest does not declare ${capability}`);
  }
  assert.ok(capabilities.has('clipboard'), 'copying a result needs the clipboard capability');

  const methods = new Set();
  for (const file of ['runtime', 'storage', 'app']) {
    for (const match of web(`${file}.js`).matchAll(/'((?:app|storage|clipboard|file|network|scheduler)\.[a-zA-Z.]+)'/g)) {
      methods.add(match[1]);
    }
  }
  const declared = {
    app: new Set(['app.getSession', 'app.openExternal', 'app.openTool', 'app.openPermissions', 'app.setBackNavigation', 'app.reportOperation', 'app.openWidgetSettings', 'app.close']),
    storage: new Set([
      'storage.kv.get', 'storage.kv.set', 'storage.kv.delete',
      'storage.blob.openRead', 'storage.blob.openWrite', 'storage.blob.read', 'storage.blob.write',
      'storage.blob.close', 'storage.blob.delete', 'storage.secret.get', 'storage.secret.set',
      'storage.secret.delete', 'storage.dataset.openRead', 'storage.dataset.openWrite',
      'storage.dataset.read', 'storage.dataset.write', 'storage.dataset.commit',
      'storage.dataset.abort', 'storage.dataset.delete',
    ]),
    clipboard: new Set(['clipboard.read', 'clipboard.write']),
    'file.export': new Set(['file.export.save']),
    'file.import': new Set(['file.import.pick']),
  };
  const events = {
    app: new Set(['app.themeChanged', 'app.containerChanged', 'app.visibilityChanged', 'app.permissionsChanged', 'app.backRequested']),
  };
  assert.ok(methods.size > 0, 'no capability calls were found, so this check proves nothing');
  for (const method of methods) {
    const capability = method.split('.').slice(0, method.startsWith('file.') ? 2 : 1).join('.');
    assert.ok(capabilities.has(capability), `${method} needs the ${capability} capability in the manifest`);
    assert.ok(
      declared[capability]?.has(method) || events[capability]?.has(method),
      `${method} is not a real ${capability} method or event`,
    );
  }

  const datasets = new Set(manifestJson.datasets.map(item => item.id));
  for (const id of ['wheel-presets', 'wheel-history']) {
    assert.ok(datasets.has(id), `the manifest does not declare the ${id} dataset`);
    assert.ok(web('storage.js').includes(`'${id}'`), `storage.js no longer uses ${id}`);
  }
  for (const dataset of manifestJson.datasets) {
    assert.ok(dataset.maxBytes > 0 && dataset.formatVersion >= 1);
    assert.ok(dataset.restoreModes.includes('merge') && dataset.restoreModes.includes('replace'));
    assert.equal(dataset.validator, 'json');
    assert.ok(dataset.mergePolicy && dataset.mergePolicy.format === 'json');
  }
});

test('the manifest points at the entry points that actually exist', () => {
  assert.equal(manifestJson.plugin.id, 'wheel_decide');
  assert.equal(manifestJson.formatVersion, 3);
  assert.equal(manifestJson.plugin.kind, 'tool');
  assert.ok(manifestJson.plugin.title.length > 0 && manifestJson.plugin.title.length <= 80);
  assert.ok(manifestJson.plugin.description.length > 0 && manifestJson.plugin.description.length <= 320);
  assert.deepEqual(manifestJson.platforms, ['android']);
  assert.equal(manifestJson.runtime.ui.length, 1);
  assert.equal(manifestJson.runtime.ui[0].type, 'declarative');
  const ui = JSON.parse(read(`src/${manifestJson.runtime.ui[0].entry}`));
  assert.equal(ui.body.type, 'webview');
  assert.ok(exists(`src/${ui.body.entry}`), `${ui.body.entry} does not exist`);
  assert.deepEqual(manifestJson.contributes.tools, [{ id: 'main', uiEntry: 'main' }]);
  assert.deepEqual(manifestJson.provides.capabilities, []);
  assert.deepEqual(manifestJson.tasks, []);
  assert.ok(!/plugin\.apk/.test(JSON.stringify(manifest)));
});

test('the package never ships a development artefact', () => {
  for (const file of ['random', 'sampler', 'distribution', 'strategies', 'wheel-model', 'runtime', 'storage', 'feedback', 'wheel-canvas', 'app']) {
    const source = web(`${file}.js`);
    assert.equal(/console\.(log|debug)\(/.test(source), false, `${file}.js leaves debug logging in the shipped payload`);
    assert.equal(/\bTODO\b|\bFIXME\b/.test(source), false, `${file}.js ships a TODO`);
  }
  assert.equal(exists('src/web/tests'), false);
  assert.equal(exists('src/web/node_modules'), false);
});
